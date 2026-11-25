import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyOps,
  applySelectedPatchOps,
  computePatchPreviewHighlights,
  evaluatePatchAgainstGraph,
  getGraphOverview,
  hashGraph,
  preparePatchOps,
  searchNodes,
  toggleOpSelection,
  type Graph,
  type Op,
  type PatchFile
} from "../src/index.js";

const fixturePath = path.resolve(
  import.meta.dirname,
  "../../../fixtures/announcement-pipeline.tgraph.json"
);
const sampleGraph: Graph = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

describe("patch engine (before snapshots, deps linking, conflict detection)", () => {
  it("computes before snapshots and causal deps for chained ops", () => {
    const ops: Op[] = [
      {
        op: "update_node",
        id: "K3",
        set: { status: "done", conclusion: "结构化财报可替代 80% 财报公告" }
      },
      {
        op: "add_node",
        node: {
          id: "K7",
          parentId: "K",
          type: "task",
          title: "补充结构化财报映射脚本",
          status: "todo"
        },
        after: "K6"
      },
      {
        op: "add_edge",
        source: "K3",
        target: "K7"
      },
      {
        op: "add_edge",
        source: "K7",
        target: "H10"
      }
    ];

    const prepared = preparePatchOps(sampleGraph, ops);
    expect(prepared.ops).toHaveLength(4);
    expect(prepared.ops[0]!.before).toEqual({
      status: "todo",
      conclusion: null
    });
    expect(prepared.ops[0]!.deps).toBeUndefined();
    expect(prepared.ops[1]!.deps).toBeUndefined();
    expect(prepared.ops[2]!.deps).toEqual([1]);
    expect(prepared.ops[3]!.deps).toEqual([1]);

    // Dependency-linked selection: unchecking op 1 (add_node K7) unchecks ops 2 and 3
    const all = new Set([0, 1, 2, 3]);
    const afterUncheck = toggleOpSelection(prepared.ops, all, 1, false);
    expect([...afterUncheck]).toEqual([0]);

    // Re-checking op 3 automatically re-checks its dependency op 1
    const afterRecheck = toggleOpSelection(prepared.ops, afterUncheck, 3, true);
    expect([...afterRecheck].sort((a, b) => a - b)).toEqual([0, 1, 3]);
  });

  it("detects conflicts on stale baseHash and leaves non-conflicted ops default-selected", () => {
    const baseHash = hashGraph(sampleGraph);
    const ops: Op[] = [
      {
        op: "update_node",
        id: "K3",
        set: { status: "done", conclusion: "AI 调研结论" }
      },
      {
        op: "add_node",
        node: {
          id: "K7",
          parentId: "K",
          type: "task",
          title: "独立新增任务",
          status: "todo"
        },
        after: "K6"
      },
      {
        op: "add_edge",
        source: "K7",
        target: "H10"
      }
    ];

    const prepared = preparePatchOps(sampleGraph, ops);
    const patch: PatchFile = {
      id: "20261125-test-patch",
      graphId: sampleGraph.id,
      baseHash,
      author: "codex",
      title: "K3 调研完成 + 新增 K7",
      rationale: "测试冲突检测",
      state: "pending",
      ops: prepared.ops,
      diagnostics: prepared.warnings
    };

    // Human manually edits K3 status to active before reviewing the patch
    const humanModified = applyOps(sampleGraph, [
      { op: "update_node", id: "K3", set: { status: "active" } }
    ]).graph;

    const evalResult = evaluatePatchAgainstGraph(humanModified, patch);
    expect(evalResult.isStale).toBe(true);
    expect(evalResult.hasConflicts).toBe(true);
    expect(evalResult.conflictCount).toBe(1);
    expect(evalResult.ops[0]!.conflicted).toBe(true);
    expect(evalResult.ops[0]!.defaultSelected).toBe(false);
    expect(evalResult.ops[1]!.conflicted).toBe(false);
    expect(evalResult.ops[1]!.defaultSelected).toBe(true);
    expect(evalResult.ops[2]!.conflicted).toBe(false);
    expect(evalResult.ops[2]!.defaultSelected).toBe(true);
    expect(evalResult.defaultSelectedIndices).toEqual([1, 2]);

    // Applying only non-conflicted ops preserves human's K3 edit and adds K7 + edge
    const applied = applySelectedPatchOps(
      humanModified,
      patch,
      evalResult.defaultSelectedIndices
    );
    expect(applied.graph.nodes.find((n) => n.id === "K3")?.status).toBe("active");
    expect(applied.graph.nodes.find((n) => n.id === "K7")).toBeDefined();
    expect(
      applied.graph.edges.some((e) => e.source === "K7" && e.target === "H10")
    ).toBe(true);

    // Preview highlights identify added node K7 and added edge K7->H10
    const highlights = computePatchPreviewHighlights(
      humanModified,
      applied.graph,
      evalResult.defaultSelectedIndices.map((i) => patch.ops[i]!)
    );
    expect(highlights.addedNodeIds.has("K7")).toBe(true);
    expect(highlights.addedEdgeKeys.has("K7->H10")).toBe(true);
  });

  it("provides graph overview and keyword/status search for MCP tools", () => {
    const overview = getGraphOverview(sampleGraph, 2);
    expect(overview.graphId).toBe("announcement-pipeline");
    expect(overview.focus.activeIds).toEqual(["K1"]);
    expect(overview.parkedRoutes.some((p) => p.id === "C")).toBe(true);
    expect(overview.discardedNodes.some((d) => d.id === "X1")).toBe(true);

    const hits = searchNodes(sampleGraph, "财报");
    expect(hits.some((h) => h.id === "K2")).toBe(true);
    expect(hits.some((h) => h.id === "K3")).toBe(true);

    const activeHits = searchNodes(sampleGraph, "", "active");
    expect(activeHits.some((h) => h.id === "K1")).toBe(true);
  });
});
