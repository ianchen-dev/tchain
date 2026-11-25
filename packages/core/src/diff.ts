import { canonicalizeGraph } from "./canonicalize.js";
import { edgeKey } from "./derive.js";
import type {
  Edge,
  Graph,
  MutableNodeField,
  Node,
  NodePatchSet,
  Op
} from "./schema.js";

const CONTENT_FIELDS: Exclude<MutableNodeField, "parentId">[] = [
  "type",
  "title",
  "status",
  "statusNote",
  "description",
  "conclusion",
  "metrics",
  "attachments",
  "report"
];

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function depthOf(nodeMap: Map<string, Node>, id: string): number {
  let d = 0;
  const seen = new Set<string>([id]);
  let cur = nodeMap.get(id)?.parentId;
  while (cur && nodeMap.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    d += 1;
    cur = nodeMap.get(cur)?.parentId;
  }
  return d;
}

/**
 * Computes a minimal valid `Op[]` transforming graph `a` into graph `b`
 * (assuming both share the same graph metadata `id`/`title`).
 */
export function diffGraphs(rawA: Graph, rawB: Graph): Op[] {
  const a = canonicalizeGraph(rawA);
  const b = canonicalizeGraph(rawB);
  const ops: Op[] = [];

  const aNodes = new Map(a.nodes.map((n) => [n.id, n]));
  const bNodes = new Map(b.nodes.map((n) => [n.id, n]));

  const aEdges = new Map<string, Edge>(a.edges.map((e) => [edgeKey(e.source, e.target), e]));
  const bEdges = new Map<string, Edge>(b.edges.map((e) => [edgeKey(e.source, e.target), e]));

  // 1. Remove edges that don't exist in `b` (and whose endpoints both survive,
  // or remove upfront so node removals stay clean).
  for (const [key, edge] of aEdges.entries()) {
    if (!bEdges.has(key)) {
      ops.push({ op: "remove_edge", source: edge.source, target: edge.target });
    }
  }

  // Track which edges are auto-removed when nodes are deleted
  const removedNodeIds = new Set<string>();
  for (const node of a.nodes) {
    if (!bNodes.has(node.id)) removedNodeIds.add(node.id);
  }

  // 2. Remove deleted nodes bottom-up (deepest first) with cascade: false
  // so surviving children are never accidentally deleted.
  const toRemove = [...removedNodeIds].sort(
    (x, y) => depthOf(aNodes, y) - depthOf(aNodes, x)
  );
  for (const id of toRemove) {
    ops.push({ op: "remove_node", id, cascade: false });
  }

  // Track simulated parentId of surviving nodes after removals
  const simParent = new Map<string, string | undefined>();
  for (const n of a.nodes) {
    if (!removedNodeIds.has(n.id)) {
      let p = n.parentId;
      while (p !== undefined && removedNodeIds.has(p)) {
        p = aNodes.get(p)?.parentId;
      }
      simParent.set(n.id, p);
    }
  }

  // 3. Add newly created nodes top-down (parents before children, in `b` order).
  // Wait: if a new node's parent in `b` is a surviving node, it already exists!
  // If a new node's parent in `b` is another new node, sorting by depth in `b` guarantees parent is added first.
  const addedNodes = b.nodes
    .filter((n) => !aNodes.has(n.id))
    .sort((x, y) => depthOf(bNodes, x.id) - depthOf(bNodes, y.id));

  for (const node of addedNodes) {
    ops.push({ op: "add_node", node: structuredClone(node) });
    simParent.set(node.id, node.parentId);
  }

  // 4. Update surviving nodes: content fields + parentId changes.
  // To avoid transient parentId cycles when swapping parent/child roles, first lift
  // any surviving node whose new parent is currently its descendant up to root.
  const surviving = b.nodes.filter((n) => aNodes.has(n.id));
  const needsParentChange = surviving.filter((n) => simParent.get(n.id) !== n.parentId);

  const isSimDescendant = (ancestor: string, candidate: string): boolean => {
    let cur = simParent.get(candidate);
    const seen = new Set<string>([candidate]);
    while (cur !== undefined && !seen.has(cur)) {
      if (cur === ancestor) return true;
      seen.add(cur);
      cur = simParent.get(cur);
    }
    return false;
  };

  for (const node of needsParentChange) {
    if (node.parentId !== undefined && isSimDescendant(node.id, node.parentId)) {
      // Break inversion by temporarily detaching target parent to root
      ops.push({ op: "update_node", id: node.parentId, unset: ["parentId"] });
      simParent.set(node.parentId, undefined);
    }
  }

  // Apply parentId changes top-down by target depth
  const sortedParentChanges = [...needsParentChange].sort(
    (x, y) => depthOf(bNodes, x.id) - depthOf(bNodes, y.id)
  );
  const updatedParentIds = new Set<string>();
  for (const bNode of sortedParentChanges) {
    if (simParent.get(bNode.id) === bNode.parentId) continue;
    updatedParentIds.add(bNode.id);
    if (bNode.parentId === undefined) {
      ops.push({ op: "update_node", id: bNode.id, unset: ["parentId"] });
    } else {
      ops.push({ op: "update_node", id: bNode.id, set: { parentId: bNode.parentId } });
    }
    simParent.set(bNode.id, bNode.parentId);
  }

  // Ensure any temporarily detached node gets its final parentId
  for (const bNode of surviving) {
    if (simParent.get(bNode.id) !== bNode.parentId) {
      if (bNode.parentId === undefined) {
        ops.push({ op: "update_node", id: bNode.id, unset: ["parentId"] });
      } else {
        ops.push({ op: "update_node", id: bNode.id, set: { parentId: bNode.parentId } });
      }
      simParent.set(bNode.id, bNode.parentId);
    }
  }

  // Content field diffs for surviving nodes
  for (const bNode of surviving) {
    const aNode = aNodes.get(bNode.id)!;
    const set: NodePatchSet = {};
    const unset: MutableNodeField[] = [];

    for (const field of CONTENT_FIELDS) {
      const av = (aNode as Record<string, unknown>)[field];
      const bv = (bNode as Record<string, unknown>)[field];
      if (deepEqual(av, bv)) continue;
      if (bv === undefined) {
        unset.push(field);
      } else {
        (set as Record<string, unknown>)[field] = structuredClone(bv);
      }
    }

    if (Object.keys(set).length > 0 || unset.length > 0) {
      ops.push({
        op: "update_node",
        id: bNode.id,
        ...(Object.keys(set).length > 0 ? { set } : {}),
        ...(unset.length > 0 ? { unset } : {})
      });
    }
  }

  // 5. Reconcile sibling order per parent container to match `b` exactly.
  // Simulate current sibling lists after ops so far (or align each group in `b` order).
  const parentGroups = new Map<string | undefined, string[]>();
  for (const n of b.nodes) {
    const list = parentGroups.get(n.parentId);
    if (list) list.push(n.id);
    else parentGroups.set(n.parentId, [n.id]);
  }

  // Reconstruct current order of siblings in `a` after removals/additions/reparenting
  // Simpler & 100% exact: only emit `after` moves for siblings that are out of order
  // relative to target `b`! We can compute current relative order of each parent group.
  const currentOrder = new Map<string | undefined, string[]>();
  for (const n of a.nodes) {
    if (removedNodeIds.has(n.id)) continue;
    const finalParent = bNodes.get(n.id)!.parentId;
    if (n.parentId === finalParent && !updatedParentIds.has(n.id)) {
      const list = currentOrder.get(finalParent) ?? [];
      list.push(n.id);
      currentOrder.set(finalParent, list);
    }
  }
  for (const n of addedNodes) {
    const list = currentOrder.get(n.parentId) ?? [];
    list.push(n.id);
    currentOrder.set(n.parentId, list);
  }
  for (const n of sortedParentChanges) {
    const list = currentOrder.get(n.parentId) ?? [];
    if (!list.includes(n.id)) list.push(n.id);
    currentOrder.set(n.parentId, list);
  }

  for (const [parentId, targetSiblings] of parentGroups.entries()) {
    const curSiblings = currentOrder.get(parentId) ?? [];
    const sameOrder =
      curSiblings.length === targetSiblings.length &&
      curSiblings.every((id, i) => id === targetSiblings[i]);
    if (sameOrder) continue;

    for (let i = 0; i < targetSiblings.length; i++) {
      const id = targetSiblings[i]!;
      const desiredAfter = i === 0 ? null : targetSiblings[i - 1]!;
      const curIdx = curSiblings.indexOf(id);
      const curAfter = curIdx <= 0 ? null : curSiblings[curIdx - 1]!;
      if (curAfter !== desiredAfter) {
        ops.push({
          op: "update_node",
          id,
          set: { after: desiredAfter }
        });
        // Update curSiblings to reflect move
        if (curIdx >= 0) curSiblings.splice(curIdx, 1);
        const insertIdx =
          desiredAfter === null ? 0 : curSiblings.indexOf(desiredAfter) + 1;
        curSiblings.splice(insertIdx, 0, id);
      }
    }
  }

  // 6. Add or update edges in `b`
  for (const [key, bEdge] of bEdges.entries()) {
    const aEdge = aEdges.get(key);
    const aKind = aEdge?.kind ?? "flow";
    const bKind = bEdge.kind ?? "flow";
    if (!aEdge || aKind !== bKind) {
      ops.push({
        op: "add_edge",
        source: bEdge.source,
        target: bEdge.target,
        ...(bKind !== "flow" ? { kind: bKind } : { kind: "flow" })
      });
    }
  }

  return ops;
}
