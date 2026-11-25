import { memo, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { RenderCapsule } from "@tchain/core";
import { Ban, Eye, PauseCircle } from "lucide-react";

export interface CapsuleNodeData extends Record<string, unknown> {
  capsule: RenderCapsule;
  onRevealBucket: (bucket: "discarded" | "parked") => void;
}

export const CapsuleNode = memo(function CapsuleNode(props: NodeProps) {
  const { capsule, onRevealBucket } = props.data as CapsuleNodeData;
  const [open, setOpen] = useState(false);

  return (
    <div
      className={`tc-capsule tc-capsule-${capsule.bucket}`}
      style={{ width: "100%", height: "100%" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={(e) => {
        e.stopPropagation();
        setOpen((v) => !v);
      }}
    >
      <Handle type="target" position={Position.Top} className="tc-handle-hidden" />
      <div className="tc-capsule-pill">
        {capsule.bucket === "discarded" ? <Ban size={13} /> : <PauseCircle size={13} />}
        <span>{capsule.label}</span>
      </div>

      {open && (
        <div
          className="tc-capsule-popover nodrag nopan"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="tc-capsule-pop-header">
            <span>{capsule.label}</span>
            <button
              type="button"
              className="tc-capsule-reveal-btn"
              onClick={() => onRevealBucket(capsule.bucket)}
            >
              <Eye size={12} /> 展开显示
            </button>
          </div>
          <div className="tc-capsule-pop-list">
            {capsule.items.map((item) => (
              <div key={item.id} className="tc-capsule-pop-item">
                <div className="tc-capsule-item-head">
                  <span className="tc-id-badge">{item.id}</span>
                  <span className="tc-capsule-item-title">{item.title}</span>
                </div>
                {item.statusNote && (
                  <div className="tc-capsule-item-note">{item.statusNote}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="tc-handle-hidden" />
    </div>
  );
});
