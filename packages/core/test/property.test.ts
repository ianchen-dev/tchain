import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyOps,
  canonicalizeGraph,
  deriveGraph,
  diffGraphs,
  hashGraph,
  serializeGraph,
  validateGraph,
  type EdgeKind,
  type Graph,
  type Node,
  type NodeType,
  type Op,
  type Status
} from "../src/index.js";

const STATUSES: Status[] = ["todo", "active", "blocked", "done", "parked", "discarded"];
const NODE_TYPES: NodeType[] = ["goal", "decision", "option", "task", "milestone"];
const EDGE_KINDS: EdgeKind[] = ["flow", "depends_on", "revises"];

const arbStatus = fc.constantFrom(...STATUSES);
const arbType = fc.constantFrom(...NODE_TYPES);
const arbEdgeKind = fc.constantFrom(...EDGE_KINDS);

/**
 * Generates an arbitrary structurally valid Graph (valid parent tree in DFS preorder,
 * valid DAG edges + optional revises edges, leaf statuses guaranteed).
 */
function arbValidGraph(minNodes = 2, maxNodes = 10): fc.Arbitrary<Graph> {
  return fc
    .integer({ min: minNodes, max: maxNodes })
    .chain((count) => {
      const ids = Array.from({ length: count }, (_, i) => `N${i}`);
      return fc.record({
        parentChoices: fc.array(fc.integer({ min: -1, max: count - 1 }), {
          minLength: count,
          maxLength: count
        }),
        types: fc.array(arbType, { minLength: count, maxLength: count }),
        statuses: fc.array(arbStatus, { minLength: count, maxLength: count }),
        edgeSpecs: fc.array(
          fc.record({
            srcIdx: fc.integer({ min: 0, max: count - 1 }),
            tgtIdx: fc.integer({ min: 0, max: count - 1 }),
            kind: arbEdgeKind
          }),
          { minLength: 0, maxLength: count * 2 }
        )
      }).map(({ parentChoices, types, statuses, edgeSpecs }) => {
        // Assign parentId strictly from earlier indices to guarantee acyclic parent tree
        const rawNodes: Node[] = ids.map((id, i) => {
          const rawP = parentChoices[i]!;
          const parentIdx = i > 0 && rawP >= 0 && rawP < i ? rawP : -1;
          const status = statuses[i]!;
          const node: Node = {
            id,
            ...(parentIdx >= 0 ? { parentId: ids[parentIdx]! } : {}),
            type: types[i]!,
            title: `Title ${id}`,
            status,
            ...(status === "blocked" || status === "parked" || status === "discarded"
              ? { statusNote: `Note for ${id}` }
              : {})
          };
          return node;
        });

        // Order nodes in DFS preorder (matches canonical tree ordering)
        const childrenOf = new Map<string | undefined, Node[]>();
        for (const n of rawNodes) {
          const list = childrenOf.get(n.parentId) ?? [];
          list.push(n);
          childrenOf.set(n.parentId, list);
        }
        const orderedNodes: Node[] = [];
        const visit = (parentId: string | undefined) => {
          for (const child of childrenOf.get(parentId) ?? []) {
            orderedNodes.push(child);
            visit(child.id);
          }
        };
        visit(undefined);

        // Compute ancestor sets to forbid ancestor-descendant edges
        const gNoEdges: Graph = {
          schemaVersion: 1,
          id: "prop-graph",
          title: "Property Test Graph",
          nodes: orderedNodes,
          edges: []
        };
        const derived = deriveGraph(gNoEdges);

        const seenEdgeKeys = new Set<string>();
        const edges: Graph["edges"] = [];
        for (const spec of edgeSpecs) {
          if (spec.srcIdx === spec.tgtIdx) continue;
          const src = orderedNodes[spec.srcIdx]!.id;
          const tgt = orderedNodes[spec.tgtIdx]!.id;
          // For flow / depends_on enforce srcIdx < tgtIdx to guarantee DAG acyclicity
          if (spec.kind !== "revises" && spec.srcIdx >= spec.tgtIdx) continue;

          const srcAnc = derived.ancestorsMap.get(src) ?? [];
          const tgtAnc = derived.ancestorsMap.get(tgt) ?? [];
          if (srcAnc.includes(tgt) || tgtAnc.includes(src)) continue;

          const key = `${src}->${tgt}`;
          if (seenEdgeKeys.has(key)) continue;
          seenEdgeKeys.add(key);

          edges.push({
            source: src,
            target: tgt,
            ...(spec.kind !== "flow" ? { kind: spec.kind } : {})
          });
        }

        return canonicalizeGraph({
          ...gNoEdges,
          edges
        });
      });
    });
}

/**
 * Generates a single valid Op given a valid Graph state.
 */
function arbValidOpForGraph(graph: Graph, stepSeed: number): fc.Arbitrary<Op> {
  const derived = deriveGraph(graph);
  const candidates: fc.Arbitrary<Op>[] = [];

  // 1. add_node (always possible)
  const newId = `X${stepSeed}_${graph.nodes.length}`;
  const parentChoices: Array<string | undefined> = [
    undefined,
    ...graph.nodes.map((n) => n.id)
  ];
  candidates.push(
    fc
      .record({
        parentId: fc.constantFrom(...parentChoices),
        type: arbType,
        status: arbStatus
      })
      .chain(({ parentId, type, status }) => {
        const siblings = graph.nodes.filter((n) => n.parentId === parentId);
        const afterChoices: Array<string | null | undefined> = [
          undefined,
          null,
          ...siblings.map((s) => s.id)
        ];
        return fc.constantFrom(...afterChoices).map(
          (after): Op => ({
            op: "add_node",
            node: {
              id: newId,
              ...(parentId ? { parentId } : {}),
              type,
              title: `Added ${newId}`,
              status,
              ...(status === "blocked" || status === "parked" || status === "discarded"
                ? { statusNote: "reason" }
                : {})
            },
            ...(after !== undefined ? { after } : {})
          })
        );
      })
  );

  // 2. update_node fields or sibling reorder
  if (graph.nodes.length > 0) {
    candidates.push(
      fc
        .record({
          node: fc.constantFrom(...graph.nodes),
          status: arbStatus,
          titleSuffix: fc.integer({ min: 1, max: 99 })
        })
        .map(({ node, status, titleSuffix }): Op => {
          const siblings = graph.nodes.filter(
            (n) => n.parentId === node.parentId && n.id !== node.id
          );
          const maybeAfter =
            siblings.length > 0
              ? siblings[titleSuffix % siblings.length]!.id
              : undefined;
          return {
            op: "update_node",
            id: node.id,
            set: {
              title: `${node.title}-${titleSuffix}`,
              status,
              ...(maybeAfter ? { after: maybeAfter } : {})
            }
          };
        })
    );
  }

  // 3. remove_node (ensure removing doesn't leave container without status if parent had no status;
  // our generator gives every node a status so safe!)
  if (graph.nodes.length > 1) {
    candidates.push(
      fc
        .record({
          node: fc.constantFrom(...graph.nodes),
          cascade: fc.boolean()
        })
        .map(
          ({ node, cascade }): Op => ({
            op: "remove_node",
            id: node.id,
            cascade
          })
        )
    );
  }

  // 4. add_edge (pick valid non-ancestor/descendant pair respecting acyclic order for flow/depends_on)
  const validEdgePairs: Array<{ source: string; target: string; kind: EdgeKind }> = [];
  for (let i = 0; i < graph.nodes.length; i++) {
    for (let j = 0; j < graph.nodes.length; j++) {
      if (i === j) continue;
      const src = graph.nodes[i]!.id;
      const tgt = graph.nodes[j]!.id;
      const srcAnc = derived.ancestorsMap.get(src) ?? [];
      const tgtAnc = derived.ancestorsMap.get(tgt) ?? [];
      if (srcAnc.includes(tgt) || tgtAnc.includes(src)) continue;
      validEdgePairs.push({ source: src, target: tgt, kind: "revises" });
    }
  }
  if (validEdgePairs.length > 0) {
    candidates.push(
      fc.constantFrom(...validEdgePairs).map(
        (pair): Op => ({
          op: "add_edge",
          source: pair.source,
          target: pair.target,
          kind: pair.kind
        })
      )
    );
  }

  // 5. remove_edge
  if (graph.edges.length > 0) {
    candidates.push(
      fc.constantFrom(...graph.edges).map(
        (e): Op => ({
          op: "remove_edge",
          source: e.source,
          target: e.target
        })
      )
    );
  }

  return fc.oneof(...candidates);
}

describe("core property-based tests (fast-check)", () => {
  it("canonicalizeGraph is idempotent and hashGraph is stable", () => {
    fc.assert(
      fc.property(arbValidGraph(1, 12), (graph) => {
        const once = canonicalizeGraph(graph);
        const twice = canonicalizeGraph(once);
        expect(serializeGraph(twice)).toBe(serializeGraph(once));
        expect(hashGraph(twice)).toBe(hashGraph(once));
        expect(validateGraph(once).ok).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it("applyOps preserves validity and apply(apply(g, ops).graph, inverse) === g", () => {
    const arbGraphAndOps = arbValidGraph(2, 8).chain((initial) =>
      fc.integer({ min: 1, max: 5 }).chain((numOps) => {
        const buildChain = (
          cur: Graph,
          step: number,
          acc: Op[]
        ): fc.Arbitrary<{ initial: Graph; ops: Op[] }> => {
          if (step >= numOps) return fc.constant({ initial, ops: acc });
          return arbValidOpForGraph(cur, step).chain((op) => {
            const next = applyOps(cur, [op]).graph;
            return buildChain(next, step + 1, [...acc, op]);
          });
        };
        return buildChain(initial, 0, []);
      })
    );

    fc.assert(
      fc.property(arbGraphAndOps, ({ initial, ops }) => {
        const applied = applyOps(initial, ops);
        expect(validateGraph(applied.graph).ok).toBe(true);

        const undone = applyOps(applied.graph, applied.inverse);
        expect(validateGraph(undone.graph).ok).toBe(true);
        expect(serializeGraph(undone.graph)).toBe(serializeGraph(initial));
      }),
      { numRuns: 80 }
    );
  });

  it("diffGraphs produces valid ops transforming any valid graph A into valid graph B", () => {
    fc.assert(
      fc.property(arbValidGraph(1, 7), arbValidGraph(1, 7), (a, b) => {
        const ops = diffGraphs(a, b);
        const result = applyOps(a, ops);
        expect(validateGraph(result.graph).ok).toBe(true);
        expect(serializeGraph(result.graph)).toBe(serializeGraph(b));
      }),
      { numRuns: 60 }
    );
  });
});
