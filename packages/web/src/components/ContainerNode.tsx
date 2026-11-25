import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { RenderNode, ViewMode } from "@tchain/core";
import { ChevronUp, Maximize2, Paperclip } from "lucide-react";
import { NODE_TYPE_META, STATUS_META } from "./statusMeta.js";

export interface ContainerNodeData extends Record<string, unknown> {
  renderNode: RenderNode;
  view: ViewMode;
  onToggleCollapse: (id: string) => void;
  onDrillInto: (id: string) => void;
  onOpenFirstAttachment: (id: string) => void;
}

export const ContainerNode = memo(function ContainerNode(props: NodeProps) {
  const data = props.data as ContainerNodeData;
  const { renderNode: rn, view, onToggleCollapse, onDrillInto, onOpenFirstAttachment } = data;
  const { node, effectiveStatus, dimmed, focusRole } = rn;
  const statusMeta = STATUS_META[effectiveStatus];
  const typeMeta = NODE_TYPE_META[node.type];
  const isReport = view === "report";
  const attachCount = node.attachments?.length ?? 0;

  const classes = [
    "tc-container",
    `tc-container-depth-${Math.min(rn.depth, 3)}`,
    `tc-status-${effectiveStatus}`,
    isReport ? "tc-container-report" : "",
    dimmed ? "tc-dimmed" : "",
    focusRole !== "none" ? `tc-focus-${focusRole}` : "",
    props.selected ? "tc-selected" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      style={{
        width: "100%",
        height: "100%",
        ["--status-accent" as string]: statusMeta.accent
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDrillInto(rn.id);
      }}
    >
      <Handle type="target" position={Position.Top} className="tc-handle-hidden" />

      <div className="tc-container-header">
        <div className="tc-container-title-group">
          <span
            className="tc-type-badge"
            style={{ background: typeMeta.badgeBg, color: typeMeta.badgeText }}
          >
            {typeMeta.label}
          </span>
          <span className="tc-id-badge">{node.id}</span>
          <span className={`tc-container-title ${effectiveStatus === "discarded" ? "tc-strike" : ""}`}>
            {node.title}
          </span>
          <span
            className="tc-status-pill"
            style={{
              background: statusMeta.bg,
              color: statusMeta.text,
              borderColor: statusMeta.border
            }}
          >
            {statusMeta.shortLabel}
          </span>
        </div>

        <div className="tc-container-actions">
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
          <button
            type="button"
            className="tc-icon-btn"
            title="折叠容器"
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse(rn.id);
            }}
          >
            <ChevronUp size={13} />
          </button>
          <button
            type="button"
            className="tc-icon-btn"
            title="钻入此容器（也可双击标题栏）"
            onClick={(e) => {
              e.stopPropagation();
              onDrillInto(rn.id);
            }}
          >
            <Maximize2 size={12} />
          </button>
        </div>
      </div>

      {((node.metrics && node.metrics.length > 0) || (isReport && node.conclusion)) && (
        <div className="tc-container-subbar">
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
          {isReport && node.conclusion && (
            <div className="tc-container-conclusion">{node.conclusion}</div>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="tc-handle-hidden" />
    </div>
  );
});
