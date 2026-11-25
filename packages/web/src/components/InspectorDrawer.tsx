import { useMemo } from "react";
import { deriveGraph } from "@tchain/core";
import {
  ArrowDownRight,
  ArrowUpLeft,
  ChevronDown,
  ChevronUp,
  Code2,
  ExternalLink,
  FileText,
  Info,
  Maximize2,
  Paperclip,
  X
} from "lucide-react";
import { useWorkbenchStore } from "../store.js";
import { MarkdownPreview } from "./MarkdownPreview.js";
import { NODE_TYPE_META, STATUS_META } from "./statusMeta.js";

function buildVscodeUrl(workspaceRoot: string, posixPath: string): string {
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const full = `${root}/${posixPath.replace(/^\/+/, "")}`;
  return `${full.startsWith("/") ? "vscode://file" : "vscode://file/"}${encodeURI(full)}`;
}

export function InspectorDrawer() {
  const graph = useWorkbenchStore((s) => s.graph);
  const workspaceRoot = useWorkbenchStore((s) => s.workspaceRoot);
  const selectedNodeId = useWorkbenchStore((s) => s.selectedNodeId);
  const view = useWorkbenchStore((s) => s.view);
  const collapsed = useWorkbenchStore((s) => s.collapsedByView[s.view]);
  const previewIndex = useWorkbenchStore((s) => s.previewIndex);

  const selectNode = useWorkbenchStore((s) => s.selectNode);
  const jumpToNode = useWorkbenchStore((s) => s.jumpToNode);
  const drillInto = useWorkbenchStore((s) => s.drillInto);
  const toggleCollapse = useWorkbenchStore((s) => s.toggleCollapse);
  const openPreviewDoc = useWorkbenchStore((s) => s.openPreviewDoc);

  const derived = useMemo(() => (graph ? deriveGraph(graph) : null), [graph]);
  const node = selectedNodeId && derived ? derived.nodeMap.get(selectedNodeId) : null;
  const hasPreview = previewIndex >= 0;

  if (!node && !hasPreview) return null;

  const effStatus = node && derived ? (derived.effectiveStatus.get(node.id) ?? "todo") : "todo";
  const resolvedStatus =
    node && derived ? (derived.resolvedStatus.get(node.id) ?? "todo") : "todo";
  const inheritedFromId =
    node && derived ? derived.inheritedStatusFrom.get(node.id) : undefined;
  const inheritedFromNode =
    inheritedFromId && derived ? derived.nodeMap.get(inheritedFromId) : undefined;
  const isContainer = node && derived ? derived.isContainer.has(node.id) : false;
  const isCollapsed = node ? collapsed.includes(node.id) : false;

  const incoming = node && derived ? (derived.incomingEdges.get(node.id) ?? []) : [];
  const outgoing = node && derived ? (derived.outgoingEdges.get(node.id) ?? []) : [];
  const ancestors =
    node && derived ? [...(derived.ancestorsMap.get(node.id) ?? [])].reverse() : [];

  const statusMeta = STATUS_META[effStatus];
  const typeMeta = node ? NODE_TYPE_META[node.type] : null;

  return (
    <aside className={`tc-right-dock ${hasPreview ? "tc-right-dock-wide" : ""}`}>
      {hasPreview && <MarkdownPreview />}

      {node && (
        <div className="tc-inspector">
          <div className="tc-inspector-header">
            <div className="tc-inspector-badges">
              {typeMeta && (
                <span
                  className="tc-type-badge"
                  style={{ background: typeMeta.badgeBg, color: typeMeta.badgeText }}
                >
                  {typeMeta.label}
                </span>
              )}
              <span className="tc-id-badge">{node.id}</span>
              <span
                className="tc-status-pill"
                style={{
                  background: statusMeta.bg,
                  color: statusMeta.text,
                  borderColor: statusMeta.border
                }}
              >
                {statusMeta.label}
              </span>
            </div>

            <button
              type="button"
              className="tc-icon-btn"
              title="关闭详情面板"
              onClick={() => selectNode(null)}
            >
              <X size={15} />
            </button>
          </div>

          <div className="tc-inspector-body">
            {ancestors.length > 0 && (
              <div className="tc-insp-chain">
                {ancestors.map((aid, idx) => (
                  <span key={aid}>
                    {idx > 0 && " > "}
                    <button
                      type="button"
                      className="tc-inline-link"
                      onClick={() => jumpToNode(aid)}
                    >
                      {aid} {derived?.nodeMap.get(aid)?.title}
                    </button>
                  </span>
                ))}
              </div>
            )}

            <h2 className="tc-insp-title">{node.title}</h2>

            {isContainer && (
              <div className="tc-insp-actions">
                <button
                  type="button"
                  className="tc-tool-btn tc-tool-sm"
                  onClick={() => drillInto(node.id)}
                >
                  <Maximize2 size={13} />
                  <span>钻入子图</span>
                </button>
                <button
                  type="button"
                  className="tc-tool-btn tc-tool-sm"
                  onClick={() => toggleCollapse(node.id)}
                >
                  {isCollapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
                  <span>{isCollapsed ? "展开容器" : "折叠容器"}</span>
                </button>
              </div>
            )}

            {inheritedFromId && (
              <div className="tc-insp-inherit-banner">
                <Info size={14} />
                <span>
                  有效状态：<strong>{STATUS_META[effStatus].label}</strong>（继承自{" "}
                  <button
                    type="button"
                    className="tc-inline-link"
                    onClick={() => jumpToNode(inheritedFromId)}
                  >
                    {inheritedFromId} {inheritedFromNode?.title}
                  </button>
                  ；节点自身状态为 {STATUS_META[resolvedStatus].label}）
                </span>
              </div>
            )}

            {node.statusNote && (
              <div className={`tc-insp-callout tc-callout-${effStatus}`}>
                <div className="tc-insp-section-label">
                  {effStatus === "blocked"
                    ? "阻塞原因"
                    : effStatus === "parked"
                      ? "搁置原因与恢复条件"
                      : effStatus === "discarded"
                        ? "否决原因（避坑记录）"
                        : "状态备注"}
                </div>
                <p>{node.statusNote}</p>
              </div>
            )}

            {node.conclusion && (
              <div className="tc-insp-section">
                <div className="tc-insp-section-label">核心结论（得出了什么）</div>
                <div className="tc-insp-conclusion">{node.conclusion}</div>
              </div>
            )}

            {node.description && (
              <div className="tc-insp-section">
                <div className="tc-insp-section-label">任务说明（做什么 / 为什么）</div>
                <p className="tc-insp-text">{node.description}</p>
              </div>
            )}

            {node.metrics && node.metrics.length > 0 && (
              <div className="tc-insp-section">
                <div className="tc-insp-section-label">量化指标</div>
                <div className="tc-insp-metrics-grid">
                  {node.metrics.map((m, idx) => (
                    <div key={idx} className={`tc-insp-metric-card tc-metric-${m.tone ?? "neutral"}`}>
                      <div className="tc-insp-metric-label">{m.label}</div>
                      <div className="tc-insp-metric-val">{m.value}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {node.attachments && node.attachments.length > 0 && (
              <div className="tc-insp-section">
                <div className="tc-insp-section-label">
                  <Paperclip size={12} /> 关联证据文档 ({node.attachments.length})
                </div>
                <div className="tc-attach-list">
                  {node.attachments.map((att, idx) => {
                    if (att.path) {
                      return (
                        <div key={idx} className="tc-attach-item">
                          <button
                            type="button"
                            className="tc-attach-open"
                            onClick={() =>
                              openPreviewDoc({
                                path: att.path!,
                                title: att.title
                              })
                            }
                          >
                            <FileText size={14} className="tc-attach-icon" />
                            <div className="tc-attach-meta">
                              <div className="tc-attach-title">
                                {att.title ?? att.path.split("/").pop()}
                              </div>
                              <div className="tc-attach-path">{att.path}</div>
                              {att.note && <div className="tc-attach-note">{att.note}</div>}
                            </div>
                          </button>
                          {workspaceRoot && (
                            <a
                              href={buildVscodeUrl(workspaceRoot, att.path)}
                              className="tc-icon-btn"
                              title="在 VS Code 中打开"
                            >
                              <Code2 size={13} />
                            </a>
                          )}
                        </div>
                      );
                    }
                    if (att.url) {
                      return (
                        <div key={idx} className="tc-attach-item">
                          <a
                            href={att.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="tc-attach-open"
                          >
                            <ExternalLink size={14} className="tc-attach-icon" />
                            <div className="tc-attach-meta">
                              <div className="tc-attach-title">{att.title ?? att.url}</div>
                              <div className="tc-attach-path">{att.url}</div>
                            </div>
                          </a>
                        </div>
                      );
                    }
                    return null;
                  })}
                </div>
              </div>
            )}

            {(incoming.length > 0 || outgoing.length > 0) && (
              <div className="tc-insp-section">
                <div className="tc-insp-section-label">上下游依赖</div>
                {incoming.length > 0 && (
                  <div className="tc-rel-group">
                    <div className="tc-rel-sub">
                      <ArrowUpLeft size={12} /> 前置输入 ({incoming.length})
                    </div>
                    <div className="tc-rel-chips">
                      {incoming.map((e) => {
                        const src = derived?.nodeMap.get(e.source);
                        return (
                          <button
                            key={`${e.source}->${e.target}`}
                            type="button"
                            className="tc-rel-chip"
                            onClick={() => jumpToNode(e.source)}
                          >
                            <span className="tc-id-badge">{e.source}</span>
                            <span>{src?.title ?? e.source}</span>
                            {e.kind && e.kind !== "flow" && (
                              <span className="tc-rel-kind">{e.kind}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {outgoing.length > 0 && (
                  <div className="tc-rel-group">
                    <div className="tc-rel-sub">
                      <ArrowDownRight size={12} /> 后续输出 ({outgoing.length})
                    </div>
                    <div className="tc-rel-chips">
                      {outgoing.map((e) => {
                        const tgt = derived?.nodeMap.get(e.target);
                        return (
                          <button
                            key={`${e.source}->${e.target}`}
                            type="button"
                            className="tc-rel-chip"
                            onClick={() => jumpToNode(e.target)}
                          >
                            <span className="tc-id-badge">{e.target}</span>
                            <span>{tgt?.title ?? e.target}</span>
                            {e.kind && e.kind !== "flow" && (
                              <span className="tc-rel-kind">{e.kind}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
