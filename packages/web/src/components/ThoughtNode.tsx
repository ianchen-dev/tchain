import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { RenderNode, ViewMode } from "@tchain/core";
import {
  ChevronDown,
  Maximize2,
  Paperclip,
  PauseCircle,
  Ban,
  AlertTriangle,
  CheckCircle2,
  Circle,
  Flame
} from "lucide-react";
import { NODE_TYPE_META, STATUS_META } from "./statusMeta.js";

export interface ThoughtNodeData extends Record<string, unknown> {
  renderNode: RenderNode;
  view: ViewMode;
  selected: boolean;
  connectable?: boolean;
  diffState?: "added" | "modified";
  statusTransition?: { before: string; after: string };
  diffTooltip?: string;
  onToggleCollapse: (id: string) => void;
  onDrillInto: (id: string) => void;
  onOpenFirstAttachment: (id: string) => void;
}

function StatusIcon({ status }: { status: RenderNode["effectiveStatus"] }) {
  switch (status) {
    case "active":
      return <Flame size={12} />;
    case "blocked":
      return <AlertTriangle size={12} />;
    case "done":
      return <CheckCircle2 size={12} />;
    case "parked":
      return <PauseCircle size={12} />;
    case "discarded":
      return <Ban size={12} />;
    default:
      return <Circle size={11} />;
  }
}

export const ThoughtNode = memo(function ThoughtNode(props: NodeProps) {
  const data = props.data as ThoughtNodeData;
  const {
    renderNode: rn,
    view,
    connectable,
    diffState,
    statusTransition,
    diffTooltip,
    onToggleCollapse,
    onDrillInto,
    onOpenFirstAttachment
  } = data;
  const { node, effectiveStatus, dimmed, focusRole, isCollapsed, isContainer } = rn;
  const statusMeta = STATUS_META[effectiveStatus];
  const typeMeta = NODE_TYPE_META[node.type];
  const isReport = view === "report";
  const attachCount = node.attachments?.length ?? 0;

  const classes = [
    "tc-card",
    `tc-status-${effectiveStatus}`,
    isReport ? "tc-card-report" : "",
    isCollapsed ? "tc-card-collapsed" : "",
    dimmed ? "tc-dimmed" : "",
    focusRole !== "none" ? `tc-focus-${focusRole}` : "",
    props.selected ? "tc-selected" : "",
    diffState === "added" ? "tc-diff-added" : "",
    diffState === "modified" ? "tc-diff-modified" : ""
  ]
    .filter(Boolean)
    .join(" ");

  const activeCount = rn.statusSummary.active ?? 0;
  const doneCount = rn.statusSummary.done ?? 0;
  const todoCount = rn.statusSummary.todo ?? 0;
  const blockedCount = rn.statusSummary.blocked ?? 0;
  const handleClass = connectable ? "tc-handle-connect" : "tc-handle-hidden";

  return (
    <div
      className={classes}
      title={diffTooltip}
      style={{
        width: "100%",
        height: "100%",
        ["--status-accent" as string]: statusMeta.accent
      }}
      onDoubleClick={(e) => {
        if (isContainer) {
          e.stopPropagation();
          onDrillInto(rn.id);
        }
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        className={handleClass}
        isConnectable={Boolean(connectable)}
      />
      <Handle
        type="target"
        position={Position.Left}
        id="left-t"
        className={handleClass}
        isConnectable={Boolean(connectable)}
      />

      <div className="tc-card-header">
        <div className="tc-card-badges">
          <span
            className="tc-type-badge"
            style={{ background: typeMeta.badgeBg, color: typeMeta.badgeText }}
          >
            {typeMeta.label}
          </span>
          <span className="tc-id-badge">{node.id}</span>
          <span
            className="tc-status-pill"
            style={{
              background: statusMeta.bg,
              color: statusMeta.text,
              borderColor: statusMeta.border
            }}
          >
            <StatusIcon status={effectiveStatus} />
            <span>{statusMeta.shortLabel}</span>
          </span>
          {diffState === "added" && <span className="tc-diff-pill tc-diff-pill-add">+ 新增</span>}
          {diffState === "modified" && (
            <span className="tc-diff-pill tc-diff-pill-mod">
              {statusTransition
                ? `${statusTransition.before} → ${statusTransition.after}`
                : "已修改"}
            </span>
          )}
        </div>

        <div className="tc-card-actions">
          {attachCount > 0 && (
            <button
              type="button"
              className="tc-icon-chip"
              title={`查看 ${attachCount} 份关联文档`}
              onClick={(e) => {
                e.stopPropagation();
                onOpenFirstAttachment(rn.id);
              }}
            >
              <Paperclip size={11} />
              <span>{attachCount}</span>
            </button>
          )}
          {isCollapsed && (
            <>
              <button
                type="button"
                className="tc-icon-btn"
                title="展开容器"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleCollapse(rn.id);
                }}
              >
                <ChevronDown size={13} />
              </button>
              <button
                type="button"
                className="tc-icon-btn"
                title="双击或点击钻入子图"
                onClick={(e) => {
                  e.stopPropagation();
                  onDrillInto(rn.id);
                }}
              >
                <Maximize2 size={12} />
              </button>
            </>
          )}
        </div>
      </div>

      <div className={`tc-card-title ${effectiveStatus === "discarded" ? "tc-strike" : ""}`}>
        {node.title}
      </div>

      {node.conclusion && (
        <div className="tc-card-conclusion" title={node.conclusion}>
          {node.conclusion}
        </div>
      )}

      {!node.conclusion && isCollapsed && node.description && !isReport && (
        <div className="tc-card-desc" title={node.description}>
          {node.description}
        </div>
      )}

      {!node.conclusion &&
        node.statusNote &&
        (effectiveStatus === "blocked" ||
          effectiveStatus === "parked" ||
          effectiveStatus === "discarded") && (
          <div className="tc-card-note" title={node.statusNote}>
            {node.statusNote}
          </div>
        )}

      {node.metrics && node.metrics.length > 0 && (
        <div className="tc-metrics-row">
          {node.metrics.map((m, idx) => (
            <span key={idx} className={`tc-metric-pill tc-metric-${m.tone ?? "neutral"}`}>
              <span className="tc-metric-label">{m.label}</span>
              <span className="tc-metric-val">{m.value}</span>
            </span>
          ))}
        </div>
      )}

      {isCollapsed && (
        <div className="tc-collapsed-footer">
          <span className="tc-collapsed-count">已折叠 · {rn.descendantCount} 个子节点</span>
          <div className="tc-collapsed-stats">
            {activeCount > 0 && <span className="tc-mini-dot active">{activeCount} 进行中</span>}
            {blockedCount > 0 && <span className="tc-mini-dot blocked">{blockedCount} 阻塞</span>}
            {doneCount > 0 && <span className="tc-mini-dot done">{doneCount} 完成</span>}
            {todoCount > 0 && <span className="tc-mini-dot todo">{todoCount} 待办</span>}
          </div>
        </div>
      )}

      <Handle
        type="source"
        position={Position.Bottom}
        className={handleClass}
        isConnectable={Boolean(connectable)}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right-s"
        className={handleClass}
        isConnectable={Boolean(connectable)}
      />
    </div>
  );
});
