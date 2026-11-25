import { deriveGraph } from "./derive.js";
import type { Graph, NodeType } from "./schema.js";

export interface FocusResult {
  activeIds: string[];
  pathIds: string[];
  nextIds: string[];
  focusIds: string[];
  isFallback: boolean;
  message?: string;
}

const KEY_PATH_TYPES = new Set<NodeType>(["decision", "milestone", "goal"]);

/**
 * Computes the Focus View node sets per PRD §6.3:
 * - Only traverses `flow` / `depends_on` edges (never `revises`), skipping `parked` / `discarded`.
 * - `S_active`: leaf nodes with effectiveStatus === "active".
 * - `S_path`: ancestors of S_active + direct predecessors (dist 1) + upstream decision/milestone/goal nodes.
 * - `S_next`: ready frontier (effectiveStatus in todo/blocked, all DAG predecessors done/active)
 *             scoped to the nearest containers of S_active.
 * - Fallback when S_active is empty: global ready frontier + all blocked nodes.
 */
export function computeFocus(graph: Graph): FocusResult {
  const derived = deriveGraph(graph);

  const isSkipped = (id: string): boolean => {
    const eff = derived.effectiveStatus.get(id);
    return eff === "parked" || eff === "discarded";
  };

  const isReadyFrontier = (id: string): boolean => {
    if (derived.isContainer.has(id)) return false;
    const eff = derived.effectiveStatus.get(id);
    if (eff !== "todo" && eff !== "blocked") return false;
    const preds = derived.dagIncoming.get(id) ?? [];
    return preds.every((edge) => {
      const predEff = derived.effectiveStatus.get(edge.source);
      return predEff === "done" || predEff === "active";
    });
  };

  // 1. Active leaf nodes
  const activeSet = new Set<string>();
  for (const node of graph.nodes) {
    if (!derived.isContainer.has(node.id) && derived.effectiveStatus.get(node.id) === "active") {
      activeSet.add(node.id);
    }
  }

  // 5. Fallback when no active leaf nodes exist
  if (activeSet.size === 0) {
    const nextSet = new Set<string>();
    const pathSet = new Set<string>();
    for (const node of graph.nodes) {
      if (isSkipped(node.id)) continue;
      const eff = derived.effectiveStatus.get(node.id);
      if (isReadyFrontier(node.id) || (!derived.isContainer.has(node.id) && eff === "blocked")) {
        nextSet.add(node.id);
        for (const anc of derived.ancestorsMap.get(node.id) ?? []) {
          if (!isSkipped(anc)) pathSet.add(anc);
        }
      }
    }
    const focusSet = new Set<string>([...pathSet, ...nextSet]);
    const ordered = (s: Set<string>) => graph.nodes.filter((n) => s.has(n.id)).map((n) => n.id);
    return {
      activeIds: [],
      pathIds: ordered(pathSet),
      nextIds: ordered(nextSet),
      focusIds: ordered(focusSet),
      isFallback: true,
      message: "当前没有进行中的节点"
    };
  }

  // 2. S_path: ancestors + direct predecessors + upstream decision/milestone/goal
  const pathSet = new Set<string>();
  const bfsQueue: string[] = [];
  const visited = new Set<string>();

  for (const activeId of activeSet) {
    visited.add(activeId);
    bfsQueue.push(activeId);

    // All containment ancestors
    for (const anc of derived.ancestorsMap.get(activeId) ?? []) {
      if (!isSkipped(anc)) {
        pathSet.add(anc);
        if (!visited.has(anc)) {
          visited.add(anc);
          bfsQueue.push(anc);
        }
      }
    }

    // Direct predecessors (distance 1)
    for (const edge of derived.dagIncoming.get(activeId) ?? []) {
      if (!isSkipped(edge.source)) {
        pathSet.add(edge.source);
        if (!visited.has(edge.source)) {
          visited.add(edge.source);
          bfsQueue.push(edge.source);
        }
      }
    }
  }

  // Continue upstream BFS along incoming DAG edges & containment parent links
  // keeping decision / milestone / goal nodes.
  let head = 0;
  while (head < bfsQueue.length) {
    const cur = bfsQueue[head++]!;

    const incoming = derived.dagIncoming.get(cur) ?? [];
    for (const edge of incoming) {
      const pred = edge.source;
      if (isSkipped(pred)) continue;
      if (!visited.has(pred)) {
        visited.add(pred);
        bfsQueue.push(pred);
      }
      const predNode = derived.nodeMap.get(pred);
      if (predNode && KEY_PATH_TYPES.has(predNode.type)) {
        pathSet.add(pred);
      }
    }

    const parentId = derived.nodeMap.get(cur)?.parentId;
    if (parentId && !isSkipped(parentId)) {
      if (!visited.has(parentId)) {
        visited.add(parentId);
        bfsQueue.push(parentId);
      }
      const parentNode = derived.nodeMap.get(parentId);
      if (parentNode && KEY_PATH_TYPES.has(parentNode.type)) {
        pathSet.add(parentId);
      }
    }
  }

  // Remove any activeId from pathSet so sets stay cleanly partitioned
  for (const id of activeSet) pathSet.delete(id);

  // 3. S_next: ready frontier within the nearest container(s) of S_active
  const activeScopes = new Set<string | null>();
  for (const activeId of activeSet) {
    activeScopes.add(derived.nodeMap.get(activeId)?.parentId ?? null);
  }

  const nextSet = new Set<string>();
  for (const scope of activeScopes) {
    const candidates =
      scope === null
        ? graph.nodes.filter((n) => n.parentId === undefined).map((n) => n.id)
        : [
            ...(derived.childrenMap.get(scope) ?? []),
            ...(derived.descendantsMap.get(scope) ?? [])
          ];
    for (const cid of candidates) {
      if (activeSet.has(cid) || isSkipped(cid)) continue;
      if (isReadyFrontier(cid)) {
        nextSet.add(cid);
      }
    }
  }

  const focusSet = new Set<string>([...activeSet, ...pathSet, ...nextSet]);
  const ordered = (s: Set<string>) => graph.nodes.filter((n) => s.has(n.id)).map((n) => n.id);

  return {
    activeIds: ordered(activeSet),
    pathIds: ordered(pathSet),
    nextIds: ordered(nextSet),
    focusIds: ordered(focusSet),
    isFallback: false
  };
}
