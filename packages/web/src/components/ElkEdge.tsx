import { memo } from "react";
import { EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import type { RenderEdge } from "@tchain/core";
import type { ElkPoint } from "../layout/elkGraph.js";

export interface ElkEdgeData extends Record<string, unknown> {
  renderEdge: RenderEdge;
  points: ElkPoint[];
  highlighted: boolean;
  dimmed: boolean;
}

/**
 * Builds an SVG path string with smooth quadratic corner fillets along ELK's
 * orthogonal bendPoints (PRD §8.3: custom rounded polyline, never React Flow bezier).
 */
export function buildRoundedPolylinePath(points: ElkPoint[], radius = 8): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y}`;
  if (points.length === 2) {
    return `M ${points[0]!.x} ${points[0]!.y} L ${points[1]!.x} ${points[1]!.y}`;
  }

  let d = `M ${points[0]!.x} ${points[0]!.y}`;

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    const next = points[i + 1]!;

    const dx1 = cur.x - prev.x;
    const dy1 = cur.y - prev.y;
    const len1 = Math.hypot(dx1, dy1);

    const dx2 = next.x - cur.x;
    const dy2 = next.y - cur.y;
    const len2 = Math.hypot(dx2, dy2);

    if (len1 < 0.5 || len2 < 0.5) {
      d += ` L ${cur.x} ${cur.y}`;
      continue;
    }

    const r = Math.min(radius, len1 / 2, len2 / 2);
    const beforeX = cur.x - (dx1 / len1) * r;
    const beforeY = cur.y - (dy1 / len1) * r;
    const afterX = cur.x + (dx2 / len2) * r;
    const afterY = cur.y + (dy2 / len2) * r;

    d += ` L ${beforeX} ${beforeY} Q ${cur.x} ${cur.y} ${afterX} ${afterY}`;
  }

  const last = points[points.length - 1]!;
  d += ` L ${last.x} ${last.y}`;
  return d;
}

function getPolylineMidpoint(points: ElkPoint[]): ElkPoint {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0]!;

  let total = 0;
  const segLengths: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const len = Math.hypot(
      points[i]!.x - points[i - 1]!.x,
      points[i]!.y - points[i - 1]!.y
    );
    segLengths.push(len);
    total += len;
  }

  const half = total / 2;
  let acc = 0;
  for (let i = 0; i < segLengths.length; i++) {
    const len = segLengths[i]!;
    if (acc + len >= half && len > 0) {
      const ratio = (half - acc) / len;
      const a = points[i]!;
      const b = points[i + 1]!;
      return {
        x: a.x + (b.x - a.x) * ratio,
        y: a.y + (b.y - a.y) * ratio
      };
    }
    acc += len;
  }
  return points[Math.floor(points.length / 2)]!;
}

export const ElkEdge = memo(function ElkEdge(props: EdgeProps) {
  const data = props.data as ElkEdgeData | undefined;
  const re = data?.renderEdge;
  const points =
    data?.points && data.points.length >= 2
      ? data.points
      : [
          { x: props.sourceX, y: props.sourceY },
          { x: props.targetX, y: props.targetY }
        ];

  const pathD = buildRoundedPolylinePath(points, 9);
  const mid = getPolylineMidpoint(points);

  const isRevises = re?.kind === "revises";
  const isDependsOn = re?.kind === "depends_on";
  const isDiscardedTarget = re?.targetEffectiveStatus === "discarded";
  const isParkedTarget = re?.targetEffectiveStatus === "parked";

  let stroke = "#64748b";
  let markerEnd = "url(#tc-arrow-default)";
  let strokeDasharray: string | undefined;

  if (isRevises) {
    stroke = "#d97706";
    markerEnd = "url(#tc-arrow-revises)";
    strokeDasharray = "6 4";
  } else if (isDiscardedTarget) {
    stroke = "#cbd5e1";
    markerEnd = "url(#tc-arrow-muted)";
    strokeDasharray = "4 4";
  } else if (isParkedTarget) {
    stroke = "#94a3b8";
    markerEnd = "url(#tc-arrow-muted)";
    strokeDasharray = "5 4";
  } else if (isDependsOn) {
    stroke = "#475569";
    strokeDasharray = "5 3";
  }

  if (data?.highlighted) {
    stroke = isRevises ? "#b45309" : "#2563eb";
    markerEnd = isRevises ? "url(#tc-arrow-revises)" : "url(#tc-arrow-highlight)";
  }

  const opacity = data?.dimmed ? 0.16 : data?.highlighted ? 1 : re?.isCapsuleEdge ? 0.55 : 0.85;
  const strokeWidth = data?.highlighted ? 2.4 : isRevises ? 2 : 1.75;

  const badgeParts: string[] = [];
  if (isRevises) badgeParts.push("回流修正");
  if (re && re.bypassedCount > 0) badgeParts.push(`跳过 ${re.bypassedCount} 步`);
  if (re && re.count > 1) badgeParts.push(`×${re.count}`);
  const badgeText = badgeParts.join(" · ");

  return (
    <>
      <path
        id={props.id}
        d={pathD}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={strokeDasharray}
        strokeLinecap="round"
        strokeLinejoin="round"
        markerEnd={markerEnd}
        style={{ opacity, pointerEvents: "none", transition: "opacity 150ms ease, stroke 150ms ease" }}
      />

      {badgeText && (
        <EdgeLabelRenderer>
          <div
            className={`tc-edge-badge ${isRevises ? "tc-edge-badge-revises" : ""} ${
              data?.highlighted ? "tc-edge-badge-highlight" : ""
            }`}
            style={{
              position: "absolute",
              transform: `translate(-50%, ${isRevises ? "-125%" : "-50%"}) translate(${mid.x}px, ${mid.y}px)`,
              opacity: data?.dimmed ? 0.2 : 1,
              pointerEvents: "none"
            }}
          >
            {badgeText}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
