import { useState } from "react";
import type { HistorySource } from "@tchain/core";
import {
  BookmarkPlus,
  ChevronDown,
  ChevronUp,
  Clock,
  Diff,
  History,
  RotateCcw,
  X
} from "lucide-react";
import { fetchHistoryDiff, type HistoryDiffResponse } from "../api.js";
import { useWorkbenchStore } from "../store.js";
import { describeOpHeading } from "./PatchReviewDrawer.js";

const SOURCE_LABELS: Record<HistorySource, { label: string; cls: string }> = {
  patch: { label: "AI 提案", cls: "tc-hist-src-patch" },
  external: { label: "外部修改", cls: "tc-hist-src-ext" },
  manual: { label: "人工编辑", cls: "tc-hist-src-manual" },
  rollback: { label: "回退前", cls: "tc-hist-src-rollback" },
  cascade_delete: { label: "级联删除前", cls: "tc-hist-src-del" },
  manual_checkpoint: { label: "还原点", cls: "tc-hist-src-cp" }
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  } catch {
    return iso;
  }
}

export function HistoryDrawer() {
  const activeGraphId = useWorkbenchStore((s) => s.activeGraphId);
  const graphHash = useWorkbenchStore((s) => s.graphHash);
  const historyOpen = useWorkbenchStore((s) => s.historyOpen);
  const historyEntries = useWorkbenchStore((s) => s.historyEntries);
  const historyLoading = useWorkbenchStore((s) => s.historyLoading);
  const mutating = useWorkbenchStore((s) => s.mutating);

  const closeHistory = useWorkbenchStore((s) => s.closeHistory);
  const createCheckpoint = useWorkbenchStore((s) => s.createCheckpoint);
  const rollbackToRev = useWorkbenchStore((s) => s.rollbackToRev);

  const [checkpointTitle, setCheckpointTitle] = useState("");
  const [expandedRev, setExpandedRev] = useState<number | null>(null);
  const [diffMap, setDiffMap] = useState<Record<number, HistoryDiffResponse>>({});
  const [diffLoadingRev, setDiffLoadingRev] = useState<number | null>(null);

  if (!historyOpen) return null;

  const handleToggleDiff = async (rev: number) => {
    if (expandedRev === rev) {
      setExpandedRev(null);
      return;
    }
    setExpandedRev(rev);
    if (!activeGraphId) return;
    setDiffLoadingRev(rev);
    try {
      const diff = await fetchHistoryDiff(activeGraphId, rev);
      setDiffMap((prev) => ({ ...prev, [rev]: diff }));
    } catch {
      // ignore
    } finally {
      setDiffLoadingRev(null);
    }
  };

  return (
    <aside className="tc-right-dock tc-history-dock" aria-label="版本历史与回退">
      <div className="tc-inspector">
        <div className="tc-inspector-header">
          <div className="tc-inspector-badges">
            <History size={15} />
            <strong>版本历史与快照</strong>
            <span className="tc-id-badge">{historyEntries.length} 份</span>
          </div>
          <button
            type="button"
            className="tc-icon-btn"
            title="关闭版本历史"
            onClick={closeHistory}
          >
            <X size={15} />
          </button>
        </div>

        <div className="tc-history-checkpoint-bar">
          <input
            type="text"
            className="tc-input tc-input-sm"
            placeholder="可选：输入还原点备注…"
            value={checkpointTitle}
            onChange={(e) => setCheckpointTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void createCheckpoint(checkpointTitle);
                setCheckpointTitle("");
              }
            }}
          />
          <button
            type="button"
            className="tc-btn tc-btn-primary tc-btn-sm"
            disabled={mutating}
            onClick={() => {
              void createCheckpoint(checkpointTitle);
              setCheckpointTitle("");
            }}
          >
            <BookmarkPlus size={13} />
            <span>保存还原点</span>
          </button>
        </div>

        <div className="tc-inspector-body">
          {historyLoading && historyEntries.length === 0 ? (
            <div className="tc-op-empty">正在读取快照索引…</div>
          ) : historyEntries.length === 0 ? (
            <div className="tc-op-empty">
              暂无历史快照。应用 AI 提案、接受外部变更、级联删除或点击上方「保存还原点」时会自动留存快照。
            </div>
          ) : (
            <div className="tc-hist-list">
              {historyEntries.map((entry) => {
                const src = SOURCE_LABELS[entry.source] ?? {
                  label: entry.source,
                  cls: ""
                };
                const isSameAsCurrent = entry.hash === graphHash;
                const isExpanded = expandedRev === entry.rev;
                const diff = diffMap[entry.rev];

                return (
                  <div key={entry.rev} className="tc-hist-card">
                    <div className="tc-hist-top">
                      <span className="tc-id-badge">
                        rev-{String(entry.rev).padStart(4, "0")}
                      </span>
                      <span className={`tc-hist-src ${src.cls}`}>{src.label}</span>
                      {isSameAsCurrent && (
                        <span className="tc-hist-current-pill">与当前一致</span>
                      )}
                      <span className="tc-hist-time">
                        <Clock size={11} /> {formatTime(entry.at)}
                      </span>
                    </div>

                    <div className="tc-hist-title">{entry.title}</div>

                    <div className="tc-hist-actions">
                      <button
                        type="button"
                        className="tc-tool-btn tc-tool-sm"
                        onClick={() => void handleToggleDiff(entry.rev)}
                      >
                        <Diff size={12} />
                        <span>对比当前</span>
                        {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      </button>

                      <button
                        type="button"
                        className="tc-tool-btn tc-tool-sm"
                        disabled={mutating || isSameAsCurrent}
                        title={
                          isSameAsCurrent
                            ? "当前版本已与此快照完全一致"
                            : "回退前会自动留存当前版本快照，回退本身可逆"
                        }
                        onClick={() => void rollbackToRev(entry.rev)}
                      >
                        <RotateCcw size={12} />
                        <span>回退到此版本</span>
                      </button>
                    </div>

                    {isExpanded && (
                      <div className="tc-hist-diff-box">
                        {diffLoadingRev === entry.rev ? (
                          <div className="tc-op-subline">正在计算差异…</div>
                        ) : !diff ? (
                          <div className="tc-op-subline">无法加载差异</div>
                        ) : diff.forwardOps.length === 0 ? (
                          <div className="tc-op-subline">与当前图谱无结构差异。</div>
                        ) : (
                          <>
                            <div className="tc-op-subline">
                              自此快照以来共发生 <strong>{diff.forwardOps.length}</strong>{" "}
                              项变更（快照 {diff.snapshotNodeCount} 节点 → 当前{" "}
                              {diff.currentNodeCount} 节点）：
                            </div>
                            <ul className="tc-hist-diff-list">
                              {diff.forwardOps.slice(0, 12).map((op, i) => {
                                const h = describeOpHeading(op);
                                return (
                                  <li key={i}>
                                    <span className={`tc-op-badge ${h.badgeClass}`}>
                                      {h.badge}
                                    </span>{" "}
                                    <span>{h.title}</span>
                                  </li>
                                );
                              })}
                              {diff.forwardOps.length > 12 && (
                                <li className="tc-op-subline">
                                  …其余 {diff.forwardOps.length - 12} 项
                                </li>
                              )}
                            </ul>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
