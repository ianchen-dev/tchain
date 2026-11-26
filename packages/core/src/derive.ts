import { normalizeIsoTimestamp } from "./canonicalize.js";
import type { Edge, Graph, Node, Status } from "./schema.js";

export function edgeKey(source: string, target: string): string {
  return `${source}->${target}`;
}

export function isNonTerminalStatus(status: Status): boolean {
  return status === "todo" || status === "active" || status === "blocked";
}

export interface DerivedGraph {
  nodeMap: Map<string, Node>;
  nodeIndex: Map<string, number>;
  childrenMap: Map<string | null, string[]>;
  isContainer: Set<string>;
  ancestorsMap: Map<string, string[]>;
  descendantsMap: Map<string, Set<string>>;
  outgoingEdges: Map<string, Edge[]>;
  incomingEdges: Map<string, Edge[]>;
  dagOutgoing: Map<string, Edge[]>;
  dagIncoming: Map<string, Edge[]>;
  rolledUpStatus: Map<string, Status>;
  resolvedStatus: Map<string, Status>;
  effectiveStatus: Map<string, Status>;
  inheritedStatusFrom: Map<string, string>;
  subtreeUpdatedAt: Map<string, string>;
}

function rollupStatuses(childStatuses: Status[]): Status {
  if (childStatuses.includes("active")) return "active";
  if (childStatuses.includes("blocked")) return "blocked";
  if (childStatuses.includes("todo")) return "todo";
  if (childStatuses.includes("done")) return "done";
  if (childStatuses.includes("parked")) return "parked";
  return "discarded";
}

export function deriveGraph(graph: Graph): DerivedGraph {
  const nodeMap = new Map<string, Node>();
  const nodeIndex = new Map<string, number>();
  const childrenMap = new Map<string | null, string[]>();
  childrenMap.set(null, []);

  for (let i = 0; i < graph.nodes.length; i++) {
    const node = graph.nodes[i]!;
    if (!nodeMap.has(node.id)) {
      nodeMap.set(node.id, node);
      nodeIndex.set(node.id, i);
      childrenMap.set(node.id, []);
    }
  }

  for (const node of graph.nodes) {
    const parentKey = node.parentId && nodeMap.has(node.parentId) ? node.parentId : null;
    const list = childrenMap.get(parentKey);
    if (list) {
      list.push(node.id);
    } else {
      childrenMap.set(parentKey, [node.id]);
    }
  }

  const isContainer = new Set<string>();
  for (const [parentId, children] of childrenMap.entries()) {
    if (parentId !== null && children.length > 0) {
      isContainer.add(parentId);
    }
  }

  const ancestorsMap = new Map<string, string[]>();
  const descendantsMap = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    descendantsMap.set(node.id, new Set<string>());
  }

  for (const node of graph.nodes) {
    const ancestors: string[] = [];
    const seen = new Set<string>([node.id]);
    let cur = node.parentId;
    while (cur && nodeMap.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      ancestors.push(cur);
      descendantsMap.get(cur)?.add(node.id);
      cur = nodeMap.get(cur)?.parentId;
    }
    ancestorsMap.set(node.id, ancestors);
  }

  const outgoingEdges = new Map<string, Edge[]>();
  const incomingEdges = new Map<string, Edge[]>();
  const dagOutgoing = new Map<string, Edge[]>();
  const dagIncoming = new Map<string, Edge[]>();

  for (const node of graph.nodes) {
    outgoingEdges.set(node.id, []);
    incomingEdges.set(node.id, []);
    dagOutgoing.set(node.id, []);
    dagIncoming.set(node.id, []);
  }

  for (const edge of graph.edges) {
    outgoingEdges.get(edge.source)?.push(edge);
    incomingEdges.get(edge.target)?.push(edge);
    if (edge.kind !== "revises") {
      dagOutgoing.get(edge.source)?.push(edge);
      dagIncoming.get(edge.target)?.push(edge);
    }
  }

  const rolledUpStatus = new Map<string, Status>();
  const resolvedStatus = new Map<string, Status>();

  const computeStatus = (id: string, visiting: Set<string>): Status => {
    const cached = resolvedStatus.get(id);
    if (cached) return cached;
    if (visiting.has(id)) return "todo";
    visiting.add(id);

    const node = nodeMap.get(id)!;
    const children = childrenMap.get(id) ?? [];
    if (children.length > 0) {
      const childResolved = children.map((cid) => computeStatus(cid, visiting));
      const rolled = rollupStatuses(childResolved);
      rolledUpStatus.set(id, rolled);
      const resolved = node.status ?? rolled;
      resolvedStatus.set(id, resolved);
      visiting.delete(id);
      return resolved;
    }

    const leafStatus = node.status ?? "todo";
    rolledUpStatus.set(id, leafStatus);
    resolvedStatus.set(id, leafStatus);
    visiting.delete(id);
    return leafStatus;
  };

  for (const node of graph.nodes) {
    computeStatus(node.id, new Set<string>());
  }

  const effectiveStatus = new Map<string, Status>();
  const inheritedStatusFrom = new Map<string, string>();

  for (const node of graph.nodes) {
    const ownResolved = resolvedStatus.get(node.id) ?? "todo";
    const ancestors = ancestorsMap.get(node.id) ?? [];
    let inheritedFrom: string | undefined;
    let inheritedStatus: Status | undefined;

    for (const ancId of ancestors) {
      const anc = nodeMap.get(ancId);
      if (anc?.status === "parked" || anc?.status === "discarded") {
        inheritedFrom = ancId;
        inheritedStatus = anc.status;
        break;
      }
    }

    if (inheritedFrom && inheritedStatus && isNonTerminalStatus(ownResolved)) {
      effectiveStatus.set(node.id, inheritedStatus);
      inheritedStatusFrom.set(node.id, inheritedFrom);
    } else {
      effectiveStatus.set(node.id, ownResolved);
    }
  }

  const subtreeUpdatedAt = new Map<string, string>();
  const subtreeVisiting = new Set<string>();

  const pickLatestTimestamp = (
    current: { iso: string; ms: number } | null,
    candidateRaw: string | undefined
  ): { iso: string; ms: number } | null => {
    if (!candidateRaw || candidateRaw.trim() === "") return current;
    const iso = normalizeIsoTimestamp(candidateRaw);
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return current;
    if (!current || ms > current.ms) {
      return { iso, ms };
    }
    return current;
  };

  const computeSubtreeUpdatedAt = (id: string): { iso: string; ms: number } | null => {
    const cached = subtreeUpdatedAt.get(id);
    if (cached !== undefined) {
      return { iso: cached, ms: Date.parse(cached) };
    }
    if (subtreeVisiting.has(id)) return null;
    subtreeVisiting.add(id);

    const node = nodeMap.get(id);
    let best: { iso: string; ms: number } | null = null;
    if (node) {
      best = pickLatestTimestamp(best, node.updatedAt);
      best = pickLatestTimestamp(best, node.statusChangedAt);
      best = pickLatestTimestamp(best, node.createdAt);
    }

    for (const cid of childrenMap.get(id) ?? []) {
      const childBest = computeSubtreeUpdatedAt(cid);
      if (childBest && (!best || childBest.ms > best.ms)) {
        best = childBest;
      }
    }

    subtreeVisiting.delete(id);
    if (best) {
      subtreeUpdatedAt.set(id, best.iso);
    }
    return best;
  };

  for (const node of graph.nodes) {
    computeSubtreeUpdatedAt(node.id);
  }

  return {
    nodeMap,
    nodeIndex,
    childrenMap,
    isContainer,
    ancestorsMap,
    descendantsMap,
    outgoingEdges,
    incomingEdges,
    dagOutgoing,
    dagIncoming,
    rolledUpStatus,
    resolvedStatus,
    effectiveStatus,
    inheritedStatusFrom,
    subtreeUpdatedAt
  };
}
