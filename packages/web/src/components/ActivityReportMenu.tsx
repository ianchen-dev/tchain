import { useEffect, useRef, useState } from "react";
import { CalendarRange, Check, Copy } from "lucide-react";
import { fetchGraphActivity, fetchWorkspaceActivity } from "../api.js";
import { useWorkbenchStore } from "../store.js";
import {
  ACTIVITY_RANGE_OPTIONS,
  formatActivityCopyToast,
  shouldShowActivityEntry,
  shouldShowScopeSelector,
  type ActivityRangePreset,
  type ActivityScope
} from "../utils/activity.js";
import { copyTextToClipboard } from "../utils/clipboard.js";

export function ActivityReportMenu() {
  const view = useWorkbenchStore((s) => s.view);
  const graphs = useWorkbenchStore((s) => s.graphs);
  const activeGraphId = useWorkbenchStore((s) => s.activeGraphId);
  const graph = useWorkbenchStore((s) => s.graph);
  const showToast = useWorkbenchStore((s) => s.showToast);

  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<ActivityRangePreset>("7d");
  const [scope, setScope] = useState<ActivityScope>("current");
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);

  const anchorRef = useRef<HTMLDivElement | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const visible = shouldShowActivityEntry(view);
  const multiGraph = shouldShowScopeSelector(graphs);
  const effectiveScope: ActivityScope = multiGraph ? scope : "current";

  useEffect(() => {
    if (!visible) {
      setOpen(false);
    }
  }, [visible]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) {
        clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  if (!visible) return null;

  const currentRangeLabel =
    ACTIVITY_RANGE_OPTIONS.find((opt) => opt.id === range)?.label ?? "近 7 天";

  const handleCopy = async () => {
    if (copying) return;
    if (effectiveScope === "current" && !activeGraphId) {
      showToast("error", "当前没有已加载的图谱");
      return;
    }

    setCopying(true);
    try {
      const res =
        effectiveScope === "all"
          ? await fetchWorkspaceActivity({ since: range, format: "md" })
          : await fetchGraphActivity(activeGraphId!, { since: range, format: "md" });

      const ok = await copyTextToClipboard(res.text);
      if (!ok) {
        showToast("error", "剪贴板写入失败，请检查浏览器权限");
        return;
      }

      setCopied(true);
      setOpen(false);
      showToast("success", formatActivityCopyToast(currentRangeLabel, effectiveScope, res));

      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "生成周报素材失败");
    } finally {
      setCopying(false);
    }
  };

  return (
    <div className="tc-activity-anchor" ref={anchorRef}>
      <button
        type="button"
        className={`tc-tool-btn ${open || copied ? "tc-tool-active" : ""}`}
        disabled={!graph && !multiGraph}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="按时间窗提取周报素材并复制为 Markdown"
        onClick={() => setOpen((v) => !v)}
      >
        {copied ? <Check size={14} /> : <CalendarRange size={14} />}
        <span>{copied ? "已复制" : "周报素材"}</span>
      </button>

      {open && (
        <div className="tc-activity-popover" role="dialog" aria-label="周报素材设置">
          <div className="tc-activity-section">
            <div className="tc-activity-label">时间范围</div>
            <div className="tc-activity-choices">
              {ACTIVITY_RANGE_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`tc-activity-choice ${
                    range === opt.id ? "tc-activity-choice-active" : ""
                  }`}
                  onClick={() => setRange(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {multiGraph && (
            <div className="tc-activity-section">
              <div className="tc-activity-label">图谱范围</div>
              <div className="tc-activity-choices">
                <button
                  type="button"
                  className={`tc-activity-choice ${
                    effectiveScope === "current" ? "tc-activity-choice-active" : ""
                  }`}
                  onClick={() => setScope("current")}
                >
                  当前图谱
                </button>
                <button
                  type="button"
                  className={`tc-activity-choice ${
                    effectiveScope === "all" ? "tc-activity-choice-active" : ""
                  }`}
                  onClick={() => setScope("all")}
                >
                  全部图谱
                </button>
              </div>
            </div>
          )}

          <button
            type="button"
            className="tc-btn tc-btn-primary tc-activity-copy-btn"
            disabled={copying}
            onClick={() => void handleCopy()}
          >
            <Copy size={13} />
            <span>{copying ? "生成中…" : "复制周报素材"}</span>
          </button>

          <div className="tc-activity-hint">
            复制后可直接粘贴到 Codex / Antigravity 对话中润色为周报。
          </div>
        </div>
      )}
    </div>
  );
}
