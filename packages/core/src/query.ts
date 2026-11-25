import { hashGraph } from "./canonicalize.js";
import { deriveGraph } from "./derive.js";
import { computeFocus } from "./focus.js";
import type { Graph, Node, Status } from "./schema.js";

export interface OverviewTreeNode {
  id: string;
  type: Node["type"];
  title: string;
  status: Status;
  effectiveStatus: Status;
  conclusion?: string;
  statusNote?: string;
  childCount: number;
  children?: OverviewTreeNode[];
}

export interface GraphOverview {
  graphId: string;
  title: string;
  hash: string;
  maxDepth: number;
  counts: {
    total: number;
    containers: number;
    leaves: number;
    byEffectiveStatus: Record<Status, number>;
  };
  focus: {
    activeIds: string[];
    nextIds: string[];
    isFallback: boolean;
  };
  keyDecisions: Array<{
    id: string;
    title: string;
    effectiveStatus: Status;
    conclusion?: string;
  }>;
  parkedRoutes: Array<{
    id: string;
    title: string;
    statusNote?: string;
  }>;
  discardedNodes: Array<{
    id: string;
    title: string;
    statusNote?: string;
  }>;
  tree: OverviewTreeNode[];
}

export function getGraphOverview(graph: Graph, maxDepth = 2): GraphOverview {
  const derived = deriveGraph(graph);
  const focus = computeFocus(graph);
  const safeDepth = Math.max(0, Math.min(10, Math.floor(maxDepth)));

  const byEffectiveStatus: Record<Status, number> = {
    active: 0,
    todo: 0,
    blocked: 0,
    done: 0,
    parked: 0,
    discarded: 0
  };
  let containers = 0;
  let leaves = 0;

  for (const node of graph.nodes) {
    if (derived.isContainer.has(node.id)) {
      containers += 1;
    } else {
      leaves += 1;
      const eff = derived.effectiveStatus.get(node.id) ?? "todo";
      byEffectiveStatus[eff] += 1;
    }
  }

  const buildTree = (parentId: string | null, depth: number): OverviewTreeNode[] => {
    const childIds = derived.childrenMap.get(parentId) ?? [];
    return childIds.map((id) => {
      const n = derived.nodeMap.get(id)!;
      const subIds = derived.childrenMap.get(id) ?? [];
      const item: OverviewTreeNode = {
        id: n.id,
        type: n.type,
        title: n.title,
        status: derived.resolvedStatus.get(id) ?? "todo",
        effectiveStatus: derived.effectiveStatus.get(id) ?? "todo",
        ...(n.conclusion ? { conclusion: n.conclusion } : {}),
        ...(n.statusNote ? { statusNote: n.statusNote } : {}),
        childCount: subIds.length
      };
      if (subIds.length > 0 && depth < safeDepth) {
        item.children = buildTree(id, depth + 1);
      }
      return item;
    });
  };

  const keyDecisions = graph.nodes
    .filter((n) => n.type === "decision" || n.type === "milestone")
    .map((n) => ({
      id: n.id,
      title: n.title,
      effectiveStatus: derived.effectiveStatus.get(n.id) ?? "todo",
      ...(n.conclusion ? { conclusion: n.conclusion } : {})
    }));

  const parkedRoutes = graph.nodes
    .filter((n) => n.status === "parked")
    .map((n) => ({
      id: n.id,
      title: n.title,
      ...(n.statusNote ? { statusNote: n.statusNote } : {})
    }));

  const discardedNodes = graph.nodes
    .filter((n) => n.status === "discarded")
    .map((n) => ({
      id: n.id,
      title: n.title,
      ...(n.statusNote ? { statusNote: n.statusNote } : {})
    }));

  return {
    graphId: graph.id,
    title: graph.title,
    hash: hashGraph(graph),
    maxDepth: safeDepth,
    counts: {
      total: graph.nodes.length,
      containers,
      leaves,
      byEffectiveStatus
    },
    focus: {
      activeIds: focus.activeIds,
      nextIds: focus.nextIds,
      isFallback: focus.isFallback
    },
    keyDecisions,
    parkedRoutes,
    discardedNodes,
    tree: buildTree(null, 0)
  };
}

export interface SearchNodeHit {
  id: string;
  parentId?: string;
  type: Node["type"];
  title: string;
  status: Status;
  effectiveStatus: Status;
  matchedFields: string[];
  conclusion?: string;
  statusNote?: string;
}

export function searchNodes(
  graph: Graph,
  query: string,
  status?: Status
): SearchNodeHit[] {
  const derived = deriveGraph(graph);
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  const hits: SearchNodeHit[] = [];

  for (const node of graph.nodes) {
    const resolved = derived.resolvedStatus.get(node.id) ?? "todo";
    const eff = derived.effectiveStatus.get(node.id) ?? resolved;

    if (status && eff !== status && resolved !== status) {
      continue;
    }

    if (tokens.length === 0) {
      hits.push({
        id: node.id,
        ...(node.parentId ? { parentId: node.parentId } : {}),
        type: node.type,
        title: node.title,
        status: resolved,
        effectiveStatus: eff,
        matchedFields: status ? ["status"] : ["all"],
        ...(node.conclusion ? { conclusion: node.conclusion } : {}),
        ...(node.statusNote ? { statusNote: node.statusNote } : {})
      });
      continue;
    }

    const fieldTexts: Array<[string, string]> = [
      ["id", node.id.toLowerCase()],
      ["title", node.title.toLowerCase()],
      ["description", (node.description ?? "").toLowerCase()],
      ["conclusion", (node.conclusion ?? "").toLowerCase()],
      ["statusNote", (node.statusNote ?? "").toLowerCase()],
      [
        "metrics",
        (node.metrics ?? []).map((m) => `${m.label} ${m.value}`).join(" ").toLowerCase()
      ],
      [
        "attachments",
        (node.attachments ?? [])
          .map((a) => `${a.title ?? ""} ${a.path ?? ""} ${a.url ?? ""} ${a.note ?? ""}`)
          .join(" ")
          .toLowerCase()
      ]
    ];

    const matchedFields = new Set<string>();
    const allTokensMatch = tokens.every((tok) => {
      let matchedAny = false;
      for (const [field, text] of fieldTexts) {
        if (text.includes(tok)) {
          matchedFields.add(field);
          matchedAny = true;
        }
      }
      return matchedAny;
    });

    if (allTokensMatch) {
      hits.push({
        id: node.id,
        ...(node.parentId ? { parentId: node.parentId } : {}),
        type: node.type,
        title: node.title,
        status: resolved,
        effectiveStatus: eff,
        matchedFields: [...matchedFields],
        ...(node.conclusion ? { conclusion: node.conclusion } : {}),
        ...(node.statusNote ? { statusNote: node.statusNote } : {})
      });
    }
  }

  return hits;
}
