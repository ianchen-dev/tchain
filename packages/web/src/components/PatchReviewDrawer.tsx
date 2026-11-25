import { useMemo } from "react";
import {
  applySelectedPatchOps,
  type Op,
  type PatchOp
} from "@tchain/core";
import {
  AlertTriangle,
  Check,
  FileWarning,
  GitPullRequest,
  Link2,
  RotateCcw,
  ShieldAlert,
  Trash2,
  X
} from "lucide-react";
import { useWorkbenchStore } from "../store.js";
import { NODE_TYPE_META, STATUS_META } from "./statusMeta.js";

function formatVal(val: unknown): string {
  if (val === null || val === undefined) return "空";
  if (typeof val === "string") {
    if (val in STATUS_META) {
      return STATUS_META[val as keyof typeof STATUS_META].shortLabel;
    }
    if (val in NODE_TYPE_META) {
      return NODE_TYPE_META[val as keyof typeof NODE_TYPE_META].label;
    }
    return val.length > 48 ? `${val.slice(0, 48)}…` : val;
  }
  if (Array.isArray(val)) return `${val.length} 项`;
  return JSON.stringify(val);
}

const FIELD_LABELS: Record<string, string> = {
  title: "标题",
  type: "类型",
  status: "状态",
  statusNote: "状态备注",
  description: "任务说明",
  conclusion: "核心结论",
  parentId: "所属容器",
  metrics: "量化指标",
  attachments: "关联文档",
  report: "汇报可见",
  after: "排序位置"
};

export function describeOpHeading(op: Op | PatchOp): {
  badge: string;
  badgeClass: string;
  title: string;
  targetNodeId?: string;
} {
  if (op.op === "add_node") {
    return {
      badge: "+ 节点",
      badgeClass: "tc-op-badge-add",
      title: `${op.node.id} ${op.node.title}`,
      targetNodeId: op.node.id
    };
  }
  if (op.op === "update_node") {
    return {
      badge: "~ 修改",
      badgeClass: "tc-op-badge-mod",
      title: `更新节点 ${op.id}`,
      targetNodeId: op.id
    };
  }
  if (op.op === "remove_node") {
    return {
      badge: op.cascade ? "- 级联删" : "- 拆散删",
      badgeClass: "tc-op-badge-del",
      title: `删除节点 ${op.id}`,
      targetNodeId: op.id
    };
  }
  if (op.op === "add_edge") {
    return {
      badge: "+ 连线",
      badgeClass: "tc-op-badge-add",
      title: `${op.source} → ${op.target}${op.kind && op.kind !== "flow" ? ` (${op.kind})` : ""}`,
      targetNodeId: op.target
    };
  }
  return {
    badge: "- 删边",
    badgeClass: "tc-op-badge-del",
    title: `移除连线 ${op.source} → ${op.target}`,
    targetNodeId: op.source
  };
}

function OpDiffDetails({ op }: { op: PatchOp }) {
  if (op.op === "add_node") {
    return (
      <div className="tc-op-details">
        <div>
          类型：<strong>{NODE_TYPE_META[op.node.type].label}</strong>
          {op.node.status && (
            <>
              {" · "}状态：<strong>{STATUS_META[op.node.status].shortLabel}</strong>
            </>
          )}
          {op.node.parentId && (
            <>
              {" · "}归属：<code>{op.node.parentId}</code>
            </>
          )}
        </div>
        {op.node.conclusion && <div className="tc-op-subline">结论：{op.node.conclusion}</div>}
        {op.node.description && <div className="tc-op-subline">说明：{op.node.description}</div>}
      </div>
    );
  }

  if (op.op === "update_node") {
    const rows: Array<{ field: string; before: unknown; after: unknown }> = [];
    const before = op.before ?? {};
    for (const [k, v] of Object.entries(op.set ?? {})) {
      rows.push({ field: k, before: before[k], after: v });
    }
    for (const field of op.unset ?? []) {
      rows.push({ field, before: before[field], after: null });
    }
    return (
      <div className="tc-op-details">
        {rows.map((r) => (
          <div key={r.field} className="tc-op-diff-row">
            <span className="tc-op-field">{FIELD_LABELS[r.field] ?? r.field}</span>
            <span className="tc-op-before">{formatVal(r.before)}</span>
            <span className="tc-op-arrow">→</span>
            <span className="tc-op-after">{formatVal(r.after)}</span>
          </div>
        ))}
      </div>
    );
  }

  if (op.op === "remove_node") {
    return (
      <div className="tc-op-details">
        {op.before?.title ? <div>原节点：{String(op.before.title)}</div> : null}
        <div className="tc-op-subline">
          模式：{op.cascade ? "级联删除整个子树及关联边" : "仅拆散容器（子节点保留上移）"}
        </div>
      </div>
    );
  }

  return null;
}

export function PatchReviewDrawer() {
  const graph = useWorkbenchStore((s) => s.graph);
  const reviewTarget = useWorkbenchStore((s) => s.reviewTarget);
  const pendingPatches = useWorkbenchStore((s) => s.pendingPatches);
  const pendingExternalChange = useWorkbenchStore((s) => s.pendingExternalChange);
  const reviewSelectedIndices = useWorkbenchStore((s) => s.reviewSelectedIndices);
  const mutating = useWorkbenchStore((s) => s.mutating);

  const openPatchReview = useWorkbenchStore((s) => s.openPatchReview);
  const closeReview = useWorkbenchStore((s) => s.closeReview);
  const toggleReviewOp = useWorkbenchStore((s) => s.toggleReviewOp);
  const applyActivePatch = useWorkbenchStore((s) => s.applyActivePatch);
  const rejectActivePatch = useWorkbenchStore((s) => s.rejectActivePatch);
  const acceptExternalChange = useWorkbenchStore((s) => s.acceptExternalChange);
  const revertExternalChange = useWorkbenchStore((s) => s.revertExternalChange);
  const jumpToNode = useWorkbenchStore((s) => s.jumpToNode);

  const activePatchItem = useMemo(() => {
    if (reviewTarget?.kind !== "patch") return null;
    return pendingPatches.find((p) => p.patch.id === reviewTarget.patchId) ?? null;
  }, [reviewTarget, pendingPatches]);

  const previewValidationError = useMemo(() => {
    if (!graph || !activePatchItem || reviewSelectedIndices.length === 0) return null;
    try {
      applySelectedPatchOps(graph, activePatchItem.patch, reviewSelectedIndices);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, [graph, activePatchItem, reviewSelectedIndices]);

  if (!reviewTarget) return null;

  // ── External Direct Edit Review ──────────────────────────────────────────
  if (reviewTarget.kind === "external") {
    if (!pendingExternalChange) return null;
    return (
      <aside className="tc-right-dock tc-review-dock" aria-label="外部变更审查">
        <div className="tc-inspector">
          <div className="tc-inspector-header tc-review-header-ext">
            <div className="tc-inspector-badges">
              <FileWarning size={15} />
              <strong>外部文件修改审查</strong>
            </div>
            <button
              type="button"
              className="tc-icon-btn"
              title="退出审查"
              onClick={closeReview}
            >
              <X size={15} />
            </button>
          </div>

          <div className="tc-inspector-body">
            <div className="tc-review-meta-card">
              <div className="tc-review-title">检测到绕过受控管线的直接文件编辑</div>
              <div className="tc-review-sub">
                文件：<code>{pendingExternalChange.file}</code>
              </div>
              <div className="tc-review-rationale">
                画布正在预览磁盘新版本的高亮变更。您可以点击「接受外部变更」更新工作台基线（不重写磁盘文件，并自动留存旧版本快照），或点击「一键还原」将磁盘恢复为受控基线。
              </div>
            </div>

            {pendingExternalChange.metadataChanged && (
              <div className="tc-review-warn-box">
                <AlertTriangle size={14} />
                <span>图谱顶层元数据（标题或布局方向）已发生变化。</span>
              </div>
            )}

            <div className="tc-insp-section-label">
              差异操作清单 ({pendingExternalChange.ops.length} 项)
            </div>

            <div className="tc-op-list">
              {pendingExternalChange.ops.length === 0 ? (
                <div className="tc-op-empty">仅顶层元数据发生变更，无节点/边结构变化。</div>
              ) : (
                pendingExternalChange.ops.map((op, idx) => {
                  const head = describeOpHeading(op);
                  return (
                    <div
                      key={idx}
                      className="tc-op-item tc-op-checked"
                      onClick={() => head.targetNodeId && jumpToNode(head.targetNodeId)}
                    >
                      <div className="tc-op-top">
                        <span className="tc-op-idx">#{idx + 1}</span>
                        <span className={`tc-op-badge ${head.badgeClass}`}>{head.badge}</span>
                        <span className="tc-op-title">{head.title}</span>
                      </div>
                      <OpDiffDetails op={op} />
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="tc-review-footer">
            <button
              type="button"
              className="tc-btn tc-btn-primary"
              disabled={mutating}
              onClick={() => void acceptExternalChange()}
            >
              <Check size={14} />
              <span>接受外部变更</span>
            </button>
            <button
              type="button"
              className="tc-btn tc-btn-danger"
              disabled={mutating}
              onClick={() => void revertExternalChange()}
            >
              <RotateCcw size={14} />
              <span>一键还原文件</span>
            </button>
          </div>
        </div>
      </aside>
    );
  }

  // ── AI Patch Proposal Review ─────────────────────────────────────────────
  if (!activePatchItem) return null;
  const { patch, evaluation } = activePatchItem;
  const selectedSet = new Set(reviewSelectedIndices);

  return (
    <aside className="tc-right-dock tc-review-dock" aria-label="AI 变更提案审查">
      <div className="tc-inspector">
        <div className="tc-inspector-header tc-review-header-patch">
          <div className="tc-inspector-badges">
            <GitPullRequest size={15} />
            <strong>AI 变更提案审查</strong>
            <span className="tc-id-badge">{patch.author}</span>
          </div>
          <button
            type="button"
            className="tc-icon-btn"
            title="退出审查"
            onClick={closeReview}
          >
            <X size={15} />
          </button>
        </div>

        {pendingPatches.length > 1 && (
          <div className="tc-review-tabs">
            {pendingPatches.map((item, i) => (
              <button
                key={item.patch.id}
                type="button"
                className={`tc-review-tab ${
                  item.patch.id === patch.id ? "tc-review-tab-active" : ""
                }`}
                onClick={() => openPatchReview(item.patch.id)}
              >
                #{i + 1} {item.patch.title}
              </button>
            ))}
          </div>
        )}

        <div className="tc-inspector-body">
          <div className="tc-review-meta-card">
            <div className="tc-review-title">{patch.title}</div>
            <div className="tc-review-sub">
              ID：<code>{patch.id}</code>
            </div>
            {patch.rationale && (
              <div className="tc-review-rationale">{patch.rationale}</div>
            )}
          </div>

          {evaluation?.isStale && (
            <div
              className={`tc-review-warn-box ${
                evaluation.hasConflicts ? "tc-review-conflict-box" : ""
              }`}
            >
              <ShieldAlert size={15} />
              <span>
                {evaluation.hasConflicts
                  ? `图谱在提案提交后已被修改：检测到 ${evaluation.conflictCount} 项冲突，已标红并默认取消勾选，其余无冲突项可正常应用。`
                  : "图谱在提案提交后有新版本，但本提案全部操作与当前版本无冲突，可安全应用。"}
              </span>
            </div>
          )}

          {previewValidationError && (
            <div className="tc-review-warn-box tc-review-conflict-box">
              <AlertTriangle size={14} />
              <span>当前勾选子集校验未通过：{previewValidationError}</span>
            </div>
          )}

          <div className="tc-review-list-head">
            <span className="tc-insp-section-label">
              原子操作清单（已选 {reviewSelectedIndices.length} / {patch.ops.length}）
            </span>
            <span className="tc-review-dep-hint">勾选/取消自动联动依赖项</span>
          </div>

          <div className="tc-op-list">
            {patch.ops.map((op, idx) => {
              const evOp = evaluation?.ops[idx];
              const conflicted = evOp?.conflicted ?? false;
              const checked = selectedSet.has(idx);
              const head = describeOpHeading(op);
              const deps = op.deps ?? [];

              return (
                <div
                  key={idx}
                  className={`tc-op-item ${checked ? "tc-op-checked" : "tc-op-unchecked"} ${
                    conflicted ? "tc-op-conflicted" : ""
                  }`}
                >
                  <div className="tc-op-top">
                    <label className="tc-op-check-label">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => toggleReviewOp(idx, e.target.checked)}
                      />
                      <span className="tc-op-idx">#{idx + 1}</span>
                    </label>
                    <span className={`tc-op-badge ${head.badgeClass}`}>{head.badge}</span>
                    <button
                      type="button"
                      className="tc-op-title-btn"
                      onClick={() => head.targetNodeId && jumpToNode(head.targetNodeId)}
                    >
                      {head.title}
                    </button>
                    {conflicted && <span className="tc-conflict-pill">冲突</span>}
                  </div>

                  {deps.length > 0 && (
                    <div className="tc-op-deps">
                      <Link2 size={11} />
                      <span>依赖：{deps.map((d) => `#${d + 1}`).join("、")}</span>
                    </div>
                  )}

                  {conflicted && evOp?.conflictReason && (
                    <div className="tc-op-conflict-reason">{evOp.conflictReason}</div>
                  )}

                  <OpDiffDetails op={op} />
                </div>
              );
            })}
          </div>
        </div>

        <div className="tc-review-footer">
          <button
            type="button"
            className="tc-btn tc-btn-primary"
            disabled={
              mutating ||
              reviewSelectedIndices.length === 0 ||
              previewValidationError !== null
            }
            onClick={() => void applyActivePatch()}
          >
            <Check size={14} />
            <span>
              应用勾选变更 ({reviewSelectedIndices.length}/{patch.ops.length})
            </span>
          </button>
          <button
            type="button"
            className="tc-btn tc-btn-danger"
            disabled={mutating}
            onClick={() => void rejectActivePatch()}
          >
            <Trash2 size={14} />
            <span>驳回提案</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
