import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { ExternalStub } from "@tchain/core";
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { STATUS_META } from "./statusMeta.js";

export interface ExternalStubNodeData extends Record<string, unknown> {
  stub: ExternalStub;
  onJumpToNode: (targetNodeId: string) => void;
}

export const ExternalStubNode = memo(function ExternalStubNode(props: NodeProps) {
  const { stub, onJumpToNode } = props.data as ExternalStubNodeData;
  const statusMeta = STATUS_META[stub.effectiveStatus];
  const chainHint = stub.parentChain.map((p) => p.id).join(" > ");

  return (
    <button
      type="button"
      className={`tc-stub tc-stub-${stub.direction}`}
      style={{ width: "100%", height: "100%" }}
      title={`点击跳转到外部节点 ${stub.targetNodeId}（${chainHint || "顶层"}）`}
      onClick={(e) => {
        e.stopPropagation();
        onJumpToNode(stub.targetNodeId);
      }}
    >
      <Handle type="target" position={Position.Top} className="tc-handle-hidden" />
      <div className="tc-stub-top">
        <span className="tc-stub-dir">
          {stub.direction === "in" ? (
            <>
              <ArrowDownLeft size={12} /> 来自外部
            </>
          ) : (
            <>
              <ArrowUpRight size={12} /> 去往外部
            </>
          )}
        </span>
        <span className="tc-id-badge">{stub.targetNodeId}</span>
        <span
          className="tc-stub-dot"
          style={{ background: statusMeta.accent }}
          title={statusMeta.label}
        />
      </div>
      <div className="tc-stub-title">{stub.title}</div>
      <Handle type="source" position={Position.Bottom} className="tc-handle-hidden" />
    </button>
  );
});
