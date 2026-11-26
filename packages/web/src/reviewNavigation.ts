import {
  applySelectedPatchOps,
  deriveGraph,
  type Graph,
  type PatchFile,
  type PatchOp,
  type ViewMode
} from "@tchain/core";

export function patchPreviewGraph(graph: Graph, patch: PatchFile, indices: number[]): Graph {
  try {
    return applySelectedPatchOps(graph, patch, indices).graph;
  } catch {
    // Match the canvas fallback when the selected operations cannot be applied.
    return graph;
  }
}

/** Deleted nodes navigate to their nearest surviving parent, or connected neighbours. */
export function resolveReviewNodeIds(base: Graph, preview: Graph, ids: string[]): string[] {
  const existing = new Set(preview.nodes.map((node) => node.id));
  const baseNodes = new Map(base.nodes.map((node) => [node.id, node]));
  const targets = new Set<string>();
  for (const id of ids) {
    if (existing.has(id)) {
      targets.add(id);
      continue;
    }
    let parentId = baseNodes.get(id)?.parentId;
    while (parentId && !existing.has(parentId)) parentId = baseNodes.get(parentId)?.parentId;
    if (parentId) {
      targets.add(parentId);
    } else {
      for (const edge of base.edges) {
        if (edge.source === id && existing.has(edge.target)) targets.add(edge.target);
        if (edge.target === id && existing.has(edge.source)) targets.add(edge.source);
      }
    }
  }
  return [...targets];
}

export function reviewNodeIds(base: Graph, preview: Graph, ops: readonly PatchOp[]): string[] {
  const ids = ops.flatMap((op) => {
    if (op.op === "add_node") return [op.node.id];
    if (op.op === "update_node" || op.op === "remove_node") return [op.id];
    return [op.source, op.target];
  });
  return resolveReviewNodeIds(base, preview, ids);
}

interface NavigationState {
  view: ViewMode;
  drillRoot: string | null;
  collapsedByView: Record<ViewMode, string[]>;
  showDiscarded: boolean;
  showParked: boolean;
  focusHideDimmed: boolean;
  fitViewNonce: number;
}

/** Reveal targets before layout so fitting uses the actual changed nodes, not lifted containers. */
export function revealReviewNodes(graph: Graph, ids: string[], state: NavigationState) {
  const derived = deriveGraph(graph);
  const view = state.view === "report" ? "workspace" : state.view;
  const ancestors = new Set(ids.flatMap((id) => derived.ancestorsMap.get(id) ?? []));
  const currentDrill = state.drillRoot;
  const drillRoot = currentDrill && ids.every((id) =>
    id === currentDrill || derived.descendantsMap.get(currentDrill)?.has(id)
  ) ? currentDrill : null;
  return {
    view,
    drillRoot,
    collapsedByView: {
      ...state.collapsedByView,
      [view]: state.collapsedByView[view].filter((id) => !ancestors.has(id))
    },
    showDiscarded: state.showDiscarded || ids.some((id) => derived.effectiveStatus.get(id) === "discarded"),
    showParked: state.showParked || ids.some((id) => derived.effectiveStatus.get(id) === "parked"),
    focusHideDimmed: ids.length > 0 ? false : state.focusHideDimmed,
    fitViewTarget: ids.length > 0 ? { nonce: state.fitViewNonce + 1, nodeIds: ids } : null,
    fitViewNonce: state.fitViewNonce + 1
  };
}
