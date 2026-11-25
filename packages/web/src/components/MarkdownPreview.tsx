import { useEffect, useId, useMemo, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import {
  ArrowLeft,
  ArrowRight,
  Code2,
  ExternalLink,
  FileText,
  X
} from "lucide-react";
import { buildWorkspaceFileUrl, fetchWorkspaceTextFile } from "../api.js";
import { useWorkbenchStore } from "../store.js";

/**
 * Safely converts simple raw HTML `<table>...</table>` blocks (commonly exported from
 * Feishu/Notion notes) into GFM pipe tables surrounded by blank lines, without enabling
 * `rehype-raw` (preserving strict XSS safety per PRD §8.1).
 */
function normalizeSimpleHtmlTables(markdown: string): string {
  return markdown.replace(
    /<table\b[^>]*>([\s\S]*?)<\/table>/gi,
    (_full, inner: string) => {
      const rowMatches = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
      if (rowMatches.length === 0) return _full;

      const rows: string[][] = [];
      for (const rm of rowMatches) {
        const cellMatches = [...rm[1]!.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)];
        if (cellMatches.length === 0) continue;
        const cells = cellMatches.map((cm) =>
          cm[1]!
            .replace(/<br\s*\/?>/gi, " ")
            .replace(/<[^>]+>/g, "")
            .replace(/\|/g, "\\|")
            .replace(/\s+/g, " ")
            .trim()
        );
        rows.push(cells);
      }

      if (rows.length === 0) return _full;
      const colCount = Math.max(...rows.map((r) => r.length));
      const padRow = (r: string[]) => {
        const out = [...r];
        while (out.length < colCount) out.push("");
        return `| ${out.join(" | ")} |`;
      };

      const header = padRow(rows[0]!);
      const sep = `| ${Array.from({ length: colCount }, () => "---").join(" | ")} |`;
      const body = rows.slice(1).map(padRow);
      return `\n\n${[header, sep, ...body].join("\n")}\n\n`;
    }
  );
}

function resolveRelativePosixPath(baseFilePath: string, href: string): string {
  const cleanHref = href.split("#")[0]?.split("?")[0] ?? "";
  let decoded = cleanHref;
  try {
    decoded = decodeURIComponent(cleanHref);
  } catch {
    // keep raw
  }

  const baseParts = baseFilePath.split("/");
  baseParts.pop(); // remove filename

  const rawParts = decoded.startsWith("/")
    ? decoded.slice(1).split("/")
    : [...baseParts, ...decoded.split("/")];

  const resolved: string[] = [];
  for (const part of rawParts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return resolved.join("/");
}

function buildVscodeFileUrl(workspaceRoot: string, posixRelPath: string): string {
  const cleanRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const joined = `${cleanRoot}/${posixRelPath.replace(/^\/+/, "")}`;
  // VS Code URI format: vscode://file/c:/... or vscode://file//...
  const prefix = joined.startsWith("/") ? "vscode://file" : "vscode://file/";
  return `${prefix}${encodeURI(joined)}`;
}

let mermaidInitialized = false;

function MermaidBlock({ chart }: { chart: string }) {
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSvg(null);
    setError(null);

    import("mermaid")
      .then(async (mod) => {
        const mermaid = mod.default;
        if (!mermaidInitialized) {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            theme: "neutral"
          });
          mermaidInitialized = true;
        }
        const rendered = await mermaid.render(`mmd_${reactId}_${Date.now()}`, chart);
        if (active) setSvg(rendered.svg);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      active = false;
    };
  }, [chart, reactId]);

  if (error) {
    return (
      <div className="tc-mermaid-err">
        <div>Mermaid 渲染失败：{error}</div>
        <pre>
          <code>{chart}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return <div className="tc-mermaid-loading">正在渲染 Mermaid 图表…</div>;
  }

  return (
    <div
      className="tc-mermaid-box"
      // Safe: Mermaid rendered with securityLevel: "strict"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function MarkdownPreview() {
  const workspaceRoot = useWorkbenchStore((s) => s.workspaceRoot);
  const previewHistory = useWorkbenchStore((s) => s.previewHistory);
  const previewIndex = useWorkbenchStore((s) => s.previewIndex);
  const openPreviewDoc = useWorkbenchStore((s) => s.openPreviewDoc);
  const navigatePreview = useWorkbenchStore((s) => s.navigatePreview);
  const closePreviewDoc = useWorkbenchStore((s) => s.closePreviewDoc);

  const currentDoc = previewIndex >= 0 ? previewHistory[previewIndex] : null;
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const renderedMarkdown = useMemo(() => normalizeSimpleHtmlTables(content), [content]);

  useEffect(() => {
    if (!currentDoc) return;
    let active = true;
    setLoading(true);
    setError(null);

    fetchWorkspaceTextFile(currentDoc.path)
      .then((text) => {
        if (active) {
          setContent(text);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [currentDoc]);

  if (!currentDoc) return null;

  const canBack = previewIndex > 0;
  const canForward = previewIndex < previewHistory.length - 1;
  const vscodeUrl = workspaceRoot
    ? buildVscodeFileUrl(workspaceRoot, currentDoc.path)
    : null;

  return (
    <section className="tc-md-pane" aria-label="Markdown 证据预览">
      <div className="tc-md-header">
        <div className="tc-md-nav">
          <button
            type="button"
            className="tc-icon-btn"
            disabled={!canBack}
            title="后退"
            onClick={() => navigatePreview(-1)}
          >
            <ArrowLeft size={14} />
          </button>
          <button
            type="button"
            className="tc-icon-btn"
            disabled={!canForward}
            title="前进"
            onClick={() => navigatePreview(1)}
          >
            <ArrowRight size={14} />
          </button>
          <FileText size={15} className="tc-md-file-icon" />
          <div className="tc-md-title-block">
            <div className="tc-md-title">
              {currentDoc.title ?? currentDoc.path.split("/").pop()}
            </div>
            <div className="tc-md-path" title={currentDoc.path}>
              {currentDoc.path}
            </div>
          </div>
        </div>

        <div className="tc-md-actions">
          {vscodeUrl && (
            <a
              href={vscodeUrl}
              className="tc-tool-btn tc-tool-sm"
              title="通过 vscode:// 协议在本地 IDE 中打开"
            >
              <Code2 size={13} />
              <span>IDE 打开</span>
            </a>
          )}
          <button
            type="button"
            className="tc-icon-btn"
            title="关闭预览 (Esc)"
            onClick={closePreviewDoc}
          >
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="tc-md-body">
        {loading && <div className="tc-md-state">正在加载文档…</div>}
        {error && (
          <div className="tc-md-state tc-md-state-err">
            无法加载文档：{error}
          </div>
        )}
        {!loading && !error && (
          <article className="tc-markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={{
                a({ href, children, ...rest }) {
                  if (!href) return <a {...rest}>{children}</a>;
                  if (/^https?:\/\//i.test(href)) {
                    return (
                      <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
                        {children}
                        <ExternalLink size={11} className="tc-inline-ext" />
                      </a>
                    );
                  }
                  if (href.startsWith("#")) {
                    return (
                      <a href={href} {...rest}>
                        {children}
                      </a>
                    );
                  }
                  const targetPath = resolveRelativePosixPath(currentDoc.path, href);
                  const isPreviewable = /\.(md|markdown|txt|json|yaml|yml|csv)$/i.test(
                    targetPath
                  );
                  if (isPreviewable) {
                    return (
                      <a
                        href={`#${targetPath}`}
                        onClick={(e) => {
                          e.preventDefault();
                          openPreviewDoc({ path: targetPath });
                        }}
                        {...rest}
                      >
                        {children}
                      </a>
                    );
                  }
                  return (
                    <a
                      href={buildWorkspaceFileUrl(targetPath)}
                      target="_blank"
                      rel="noopener noreferrer"
                      {...rest}
                    >
                      {children}
                    </a>
                  );
                },
                img({ src, alt, ...rest }) {
                  if (!src) return null;
                  const resolvedSrc = /^https?:\/\/|^data:/i.test(src)
                    ? src
                    : buildWorkspaceFileUrl(resolveRelativePosixPath(currentDoc.path, src));
                  return <img src={resolvedSrc} alt={alt ?? ""} loading="lazy" {...rest} />;
                },
                code(codeProps: ComponentPropsWithoutRef<"code">) {
                  const { className, children, ...rest } = codeProps;
                  const match = /language-([\w-]+)/.exec(className ?? "");
                  if (match && match[1] === "mermaid") {
                    const chartText = String(children).replace(/\n$/, "");
                    return <MermaidBlock chart={chartText} />;
                  }
                  return (
                    <code className={className} {...rest}>
                      {children}
                    </code>
                  );
                }
              }}
            >
              {renderedMarkdown}
            </ReactMarkdown>
          </article>
        )}
      </div>
    </section>
  );
}
