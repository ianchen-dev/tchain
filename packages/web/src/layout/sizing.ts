import type { ExternalStub, RenderCapsule, RenderNode, ViewMode } from "@tchain/core";

export interface NodeSize {
  width: number;
  height: number;
}

export interface ContainerPadding {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/**
 * Estimates the visual display width of a string in units of `fontSizePx`.
 * CJK / full-width characters count as ~1.02em; ASCII characters count as ~0.58em.
 */
export function estimateTextUnits(text: string): number {
  let units = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef) ||
      code >= 0x20000
    ) {
      units += 1.02;
    } else if (ch === " ") {
      units += 0.35;
    } else {
      units += 0.58;
    }
  }
  return units;
}

export function estimateWrappedLines(
  text: string,
  maxWidthPx: number,
  fontSizePx: number,
  maxLines?: number
): number {
  if (!text.trim()) return 0;
  const effectiveWidth = Math.max(40, maxWidthPx);
  const lines = text.split(/\r?\n/);
  let total = 0;
  for (const line of lines) {
    const px = estimateTextUnits(line) * fontSizePx;
    total += Math.max(1, Math.ceil(px / effectiveWidth));
  }
  return maxLines !== undefined ? Math.min(total, maxLines) : total;
}

export function getCardWidth(view: ViewMode, isCollapsedContainer: boolean): number {
  if (view === "report") {
    return isCollapsedContainer ? 344 : 316;
  }
  return isCollapsedContainer ? 292 : 268;
}

export function getContainerPadding(rn: RenderNode, view: ViewMode): ContainerPadding {
  const isReport = view === "report";
  const hasMetrics = (rn.node.metrics?.length ?? 0) > 0;
  const hasConclusion = Boolean(rn.node.conclusion);
  // Extra top padding to hold container header bar cleanly without overlapping child nodes
  let top = isReport ? 72 : 58;
  if (hasMetrics) top += isReport ? 28 : 24;
  if (isReport && hasConclusion) top += 34;

  return {
    top,
    left: isReport ? 28 : 22,
    bottom: isReport ? 28 : 22,
    right: isReport ? 28 : 22
  };
}

/**
 * Deterministically estimates card dimensions for leaf nodes and collapsed containers.
 * Used as fixed width + computed height input to ELK Layered layout (PRD §8.3).
 */
export function estimateNodeSize(rn: RenderNode, view: ViewMode): NodeSize {
  const isReport = view === "report";
  const width = getCardWidth(view, rn.isCollapsed);
  const innerWidth = width - (isReport ? 34 : 28);

  const titleFont = isReport ? 16 : 13.5;
  const titleLineHeight = isReport ? 22 : 19;
  const bodyFont = isReport ? 13.5 : 12;
  const bodyLineHeight = isReport ? 19 : 17;

  // Base chrome: top/bottom padding + header badge row
  let height = isReport ? 58 : 48;

  // Title lines
  const titleLines = estimateWrappedLines(rn.node.title, innerWidth, titleFont, 3);
  height += titleLines * titleLineHeight;

  // Conclusion or compact description preview
  if (rn.node.conclusion) {
    const maxConclusionLines = isReport ? 4 : 2;
    const cLines = estimateWrappedLines(
      rn.node.conclusion,
      innerWidth - 16,
      bodyFont,
      maxConclusionLines
    );
    // Match the conclusion's vertical padding (5px / 7px per side) and the card gap.
    height += (isReport ? 14 : 10) + cLines * bodyLineHeight + 6;
  } else if (!isReport && rn.node.description && rn.isCollapsed) {
    const dLines = estimateWrappedLines(rn.node.description, innerWidth, bodyFont, 2);
    height += 8 + dLines * bodyLineHeight;
  }

  // Metrics pills
  const metrics = rn.node.metrics ?? [];
  if (metrics.length > 0) {
    const rows = Math.ceil(metrics.length / 2);
    // Include the card gap, row margin, and spacing between wrapped rows.
    height += 6 + 2 + rows * (isReport ? 24 : 21) + (rows - 1) * 5;
  }

  // Collapsed container footer (child count summary)
  if (rn.isCollapsed) {
    height += isReport ? 30 : 26;
  }

  // Status note preview for blocked/parked/discarded leaves when no conclusion
  if (
    !rn.node.conclusion &&
    rn.node.statusNote &&
    (rn.effectiveStatus === "blocked" ||
      rn.effectiveStatus === "parked" ||
      rn.effectiveStatus === "discarded")
  ) {
    const noteLines = estimateWrappedLines(rn.node.statusNote, innerWidth, 11.5, 2);
    height += 8 + noteLines * 16;
  }

  return {
    width,
    height: Math.max(isReport ? 96 : 78, Math.ceil(height))
  };
}

export function estimateStubSize(stub: ExternalStub, view: ViewMode): NodeSize {
  const isReport = view === "report";
  const width = isReport ? 236 : 210;
  const lines = estimateWrappedLines(stub.title, width - 28, isReport ? 13 : 12, 2);
  return {
    width,
    height: Math.max(54, 34 + lines * 17)
  };
}

export function estimateCapsuleSize(capsule: RenderCapsule, view: ViewMode): NodeSize {
  const isReport = view === "report";
  return {
    width: isReport ? 210 : 186,
    height: isReport ? 44 : 38
  };
}
