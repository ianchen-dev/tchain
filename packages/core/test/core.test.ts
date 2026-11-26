import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyOps,
  canonicalizeGraph,
  compileContext,
  computeFocus,
  deriveGraph,
  diffGraphs,
  exportGraphJsonSchema,
  hashGraph,
  reconcileExternalTimestamps,
  serializeGraph,
  sha256Hex,
  validateGraph,
  type Graph
} from "../src/index.js";

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../fixtures/announcement-pipeline.tgraph.json"
);

function loadSampleGraph(): Graph {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as Graph;
}

describe("sha256Hex", () => {
  it("matches node:crypto sha256 on ASCII and UTF-8 Chinese text", () => {
    const samples = ["", "hello world", "公告采集解析方案决策链 🚀", JSON.stringify(loadSampleGraph())];
    for (const s of samples) {
      const expected = crypto.createHash("sha256").update(s, "utf8").digest("hex");
      expect(sha256Hex(s)).toBe(expected);
    }
  });
});

describe("exportGraphJsonSchema", () => {
  it("exports draft-2020-12 JSON Schema with Graph properties", () => {
    const schema = exportGraphJsonSchema();
    expect(schema.$id).toBe("https://tchain.local/schemas/tgraph.schema.json");
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
  });
});

describe("0 号样板 announcement-pipeline.tgraph.json", () => {
  const sample = loadSampleGraph();

  it("passes validation with zero errors and zero warnings", () => {
    const res = validateGraph(sample);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it("is already canonical and canonicalize is idempotent", () => {
    const raw = fs.readFileSync(FIXTURE_PATH, "utf8").replace(/\r\n/g, "\n");
    const serialized = serializeGraph(sample);
    expect(serialized).toBe(raw);
    expect(serializeGraph(canonicalizeGraph(sample))).toBe(serialized);
    expect(hashGraph(canonicalizeGraph(sample))).toBe(hashGraph(sample));
  });

  it("derives container status rollups and effectiveStatus inheritance accurately", () => {
    const derived = deriveGraph(sample);

    // B contains C(parked), D(parked), E(done) -> rolled up to done
    expect(derived.isContainer.has("B")).toBe(true);
    expect(derived.resolvedStatus.get("B")).toBe("done");
    expect(derived.effectiveStatus.get("B")).toBe("done");

    // D is explicitly parked; D1 is blocked -> effectiveStatus inherited as parked
    expect(derived.resolvedStatus.get("D")).toBe("parked");
    expect(derived.resolvedStatus.get("D1")).toBe("blocked");
    expect(derived.effectiveStatus.get("D1")).toBe("parked");
    expect(derived.inheritedStatusFrom.get("D1")).toBe("D");

    // Done & discarded descendants inside parked container D retain own status
    expect(derived.effectiveStatus.get("D2")).toBe("done");
    expect(derived.effectiveStatus.get("X1")).toBe("discarded");
    expect(derived.effectiveStatus.get("X2")).toBe("discarded");

    // H2 children all done -> done; K has K1 active -> active; H & G -> active
    expect(derived.effectiveStatus.get("H2")).toBe("done");
    expect(derived.effectiveStatus.get("K")).toBe("active");
    expect(derived.effectiveStatus.get("H")).toBe("active");
    expect(derived.effectiveStatus.get("G")).toBe("active");
  });

  it("computes Focus View accurately for sample graph", () => {
    const focus = computeFocus(sample);
    expect(focus.isFallback).toBe(false);
    expect(focus.activeIds).toEqual(["K1"]);
    expect(focus.nextIds).toEqual(["K2"]);
    expect(focus.pathIds).toContain("K");
    expect(focus.pathIds).toContain("H");
    expect(focus.pathIds).toContain("G");
    expect(focus.pathIds).toContain("H7");
    expect(focus.pathIds).toContain("F");
    expect(focus.pathIds).toContain("E");
    expect(focus.pathIds).toContain("B");

    // Parked & discarded branches must never appear in Focus
    for (const excluded of ["A", "C", "D", "D1", "X1", "X2", "I"]) {
      expect(focus.focusIds).not.toContain(excluded);
    }
  });

  it("compiles complete 6-section AI context for node K3", () => {
    const ctx = compileContext(sample, "K3", { format: "md" });
    expect(ctx.data.goals.map((g) => g.id)).toEqual(["A"]);
    expect(ctx.data.decisionPath.containmentChain.map((n) => n.id)).toEqual(["G", "H", "K"]);
    expect(ctx.data.decisionPath.upstreamDecisions.map((n) => n.id)).toEqual(
      expect.arrayContaining(["B", "E", "F"])
    );
    expect(ctx.data.avoidConstraints.map((n) => n.id)).toEqual(
      expect.arrayContaining(["X1", "X2"])
    );
    expect(ctx.data.parkedRoutes.map((n) => n.id)).toEqual(
      expect.arrayContaining(["A", "C", "D", "D1", "I"])
    );
    expect(ctx.data.currentAndNeighbors.target.id).toBe("K3");
    expect(ctx.data.currentAndNeighbors.predecessors.map((p) => p.id)).toEqual(["K2"]);
    expect(ctx.data.currentAndNeighbors.successors.map((s) => s.id)).toEqual(["K4"]);
    expect(ctx.data.evidencePaths.length).toBeGreaterThan(0);

    expect(ctx.text).toContain("## ① 全局目标");
    expect(ctx.text).toContain("## ② 决策来路");
    expect(ctx.text).toContain("## ③ 避坑约束");
    expect(ctx.text).toContain("## ④ 可恢复路线");
    expect(ctx.text).toContain("## ⑤ 当前任务与邻接节点");
    expect(ctx.text).toContain("## ⑥ 关联证据路径");
    expect(ctx.text).toContain("Tushare");
    expect(ctx.text).toMatchSnapshot();
  });

  it("truncates context in strict ⑥ → ④ → ② order when maxTokens is tight", () => {
    const full = compileContext(sample, "K3", { format: "md" });
    const medium = compileContext(sample, "K3", {
      format: "md",
      maxTokens: Math.floor(full.estimatedTokens * 0.65)
    });
    expect(medium.data.truncatedSections[0]).toBe("⑥ 关联证据路径");
    expect(medium.data.evidencePaths.length).toBeLessThan(full.data.evidencePaths.length);

    const tiny = compileContext(sample, "K3", { format: "md", maxTokens: 280 });
    expect(tiny.data.truncatedSections).toEqual(
      expect.arrayContaining(["⑥ 关联证据路径", "④ 可恢复路线"])
    );
  });
});

describe("validateGraph error & warning diagnostics", () => {
  const base: Graph = {
    schemaVersion: 1,
    id: "test-graph",
    title: "测试图谱",
    nodes: [
      { id: "A", type: "goal", title: "目标", status: "active" },
      { id: "B", type: "task", title: "任务B", status: "todo" }
    ],
    edges: [{ source: "A", target: "B" }]
  };

  it("detects parentId cycle with structured error code, path, and hint", () => {
    const g: Graph = {
      ...base,
      nodes: [
        { id: "K", parentId: "K3", type: "task", title: "K", status: "todo" },
        { id: "K3", parentId: "K", type: "task", title: "K3", status: "todo" }
      ],
      edges: []
    };
    const res = validateGraph(g);
    expect(res.ok).toBe(false);
    const err = res.errors.find((e) => e.code === "PARENT_CYCLE");
    expect(err).toBeDefined();
    expect(err?.path).toMatch(/^nodes\[\d+\]\.parentId$/);
    expect(err?.hint).toBeTruthy();
  });

  it("detects ancestor-descendant edges", () => {
    const g: Graph = {
      ...base,
      nodes: [
        { id: "P", type: "option", title: "容器" },
        { id: "C", parentId: "P", type: "task", title: "子任务", status: "todo" }
      ],
      edges: [{ source: "P", target: "C" }]
    };
    const res = validateGraph(g);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === "EDGE_ANCESTOR_DESCENDANT")).toBe(true);
  });

  it("detects non-revises DAG cycles while allowing revises feedback cycles", () => {
    const cyclicFlow: Graph = {
      ...base,
      edges: [
        { source: "A", target: "B" },
        { source: "B", target: "A" }
      ]
    };
    expect(validateGraph(cyclicFlow).errors.some((e) => e.code === "DAG_CYCLE")).toBe(true);

    const allowedRevises: Graph = {
      ...base,
      edges: [
        { source: "A", target: "B" },
        { source: "B", target: "A", kind: "revises" }
      ]
    };
    expect(validateGraph(allowedRevises).ok).toBe(true);
  });

  it("rejects attachment path escaping workspace or invalid source XOR", () => {
    const badPath: Graph = {
      ...base,
      nodes: [
        {
          id: "A",
          type: "goal",
          title: "目标",
          status: "active",
          attachments: [
            { path: "../outside.md" },
            { path: "/etc/passwd" },
            { path: "C:\\Windows\\win.ini" },
            { path: "a.md", url: "https://example.com" }
          ]
        }
      ],
      edges: []
    };
    const res = validateGraph(badPath);
    expect(res.ok).toBe(false);
    expect(
      res.errors.filter((e) => e.code === "ATTACHMENT_PATH_OUTSIDE_WORKSPACE")
    ).toHaveLength(3);
    expect(res.errors.filter((e) => e.code === "ATTACHMENT_INVALID_SOURCE")).toHaveLength(1);
  });

  it("detects leaf missing status, duplicate node ids, self loops, and warnings", () => {
    const g: Graph = {
      ...base,
      nodes: [
        { id: "G1", type: "goal", title: "目标1", status: "discarded" },
        { id: "G2", type: "goal", title: "目标2", status: "done" },
        { id: "Leaf", type: "task", title: "缺状态叶子" },
        { id: "P", type: "option", title: "冲突容器", status: "done" },
        {
          id: "C1",
          parentId: "P",
          type: "task",
          title: "子任务",
          status: "active",
          attachments: [{ path: "docs/missing.md" }]
        }
      ],
      edges: [{ source: "G1", target: "G1" }]
    };
    const res = validateGraph(g, { fileExists: () => false });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === "LEAF_MISSING_STATUS")).toBe(true);
    expect(res.errors.some((e) => e.code === "EDGE_SELF_LOOP")).toBe(true);
    expect(res.warnings.some((w) => w.code === "MISSING_STATUS_NOTE")).toBe(true);
    expect(res.warnings.some((w) => w.code === "MULTIPLE_TOP_GOALS")).toBe(true);
    expect(res.warnings.some((w) => w.code === "CONTAINER_STATUS_CONFLICT")).toBe(true);
    expect(res.warnings.some((w) => w.code === "ATTACHMENT_NOT_FOUND")).toBe(true);
  });
});

describe("applyOps & diffGraphs targeted scenarios", () => {
  it("handles container dissolve (cascade: false) and exact undo", () => {
    const sample = loadSampleGraph();
    const { graph: dissolved, inverse } = applyOps(sample, [
      { op: "remove_node", id: "K", cascade: false }
    ]);
    expect(dissolved.nodes.some((n) => n.id === "K")).toBe(false);
    expect(dissolved.nodes.find((n) => n.id === "K1")?.parentId).toBe("H");

    const { graph: restored } = applyOps(dissolved, inverse);
    expect(serializeGraph(restored)).toBe(serializeGraph(sample));
  });

  it("handles cascade delete and exact undo", () => {
    const sample = loadSampleGraph();
    const { graph: afterDel, inverse } = applyOps(sample, [
      { op: "remove_node", id: "H2", cascade: true }
    ]);
    expect(afterDel.nodes.some((n) => n.id === "H2" || n.id === "H9")).toBe(false);

    const { graph: restored } = applyOps(afterDel, inverse);
    expect(serializeGraph(restored)).toBe(serializeGraph(sample));
  });

  it("diffGraphs transforms modified graph back and forth cleanly", () => {
    const sample = loadSampleGraph();
    const { graph: modified } = applyOps(sample, [
      { op: "update_node", id: "K1", set: { status: "done", conclusion: "统计完成" } },
      { op: "update_node", id: "K2", set: { status: "active" } },
      {
        op: "add_node",
        node: { id: "K7", parentId: "K", type: "task", title: "复核脚本", status: "todo" },
        after: "K6"
      },
      { op: "add_edge", source: "K6", target: "K7" }
    ]);

    const forwardOps = diffGraphs(sample, modified);
    expect(serializeGraph(applyOps(sample, forwardOps).graph)).toBe(
      serializeGraph(modified)
    );

    const backwardOps = diffGraphs(modified, sample);
    expect(serializeGraph(applyOps(modified, backwardOps).graph)).toBe(
      serializeGraph(sample)
    );
  });

  it("computeFocus falls back gracefully when no node is active", () => {
    const g: Graph = {
      schemaVersion: 1,
      id: "fallback-test",
      title: "Fallback",
      nodes: [
        { id: "A", type: "goal", title: "G", status: "done" },
        { id: "B", type: "task", title: "Next", status: "todo" },
        { id: "C", type: "task", title: "Later", status: "todo" }
      ],
      edges: [
        { source: "A", target: "B" },
        { source: "B", target: "C" }
      ]
    };
    const focus = computeFocus(g);
    expect(focus.isFallback).toBe(true);
    expect(focus.message).toBe("当前没有进行中的节点");
    expect(focus.nextIds).toEqual(["B"]);
  });
});

describe("node-level timestamps (createdAt, updatedAt, statusChangedAt)", () => {
  it("validates ISO timestamps, normalizes timezone offsets to UTC, and rejects invalid dates", () => {
    const validGraph: Graph = {
      schemaVersion: 1,
      id: "ts-valid",
      title: "Timestamp Validation",
      nodes: [
        {
          id: "A",
          type: "task",
          title: "Offset timestamp",
          status: "todo",
          createdAt: "2026-11-26T18:00:00+08:00",
          updatedAt: "2026-11-26T10:05:00.500Z",
          statusChangedAt: "2026-11-26T18:00:00+08:00"
        }
      ],
      edges: []
    };
    expect(validateGraph(validGraph).ok).toBe(true);
    const canon = canonicalizeGraph(validGraph);
    expect(canon.nodes[0]?.createdAt).toBe("2026-11-26T10:00:00.000Z");
    expect(canon.nodes[0]?.updatedAt).toBe("2026-11-26T10:05:00.500Z");
    expect(canon.nodes[0]?.statusChangedAt).toBe("2026-11-26T10:00:00.000Z");

    const invalidGraph = {
      ...validGraph,
      nodes: [
        {
          id: "A",
          type: "task",
          title: "Bad timestamp",
          status: "todo",
          createdAt: "not-a-timestamp"
        }
      ]
    };
    const invalidRes = validateGraph(invalidGraph);
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.errors.some((e) => e.path.includes("createdAt"))).toBe(true);
  });

  it("auto-maintains timestamps on add_node and update_node, skips no-op/reorder/reparent, and restores exact state on undo", () => {
    const t1 = "2026-11-26T08:00:00.000Z";
    const t2 = "2026-11-26T09:00:00.000Z";
    const t3 = "2026-11-26T10:00:00.000Z";
    const t4 = "2026-11-26T11:00:00.000Z";

    const base: Graph = {
      schemaVersion: 1,
      id: "ts-ops",
      title: "Timestamp Ops",
      nodes: [
        { id: "G", type: "goal", title: "Goal" },
        { id: "T1", parentId: "G", type: "task", title: "Legacy Task", status: "todo" }
      ],
      edges: []
    };

    // 1. add_node: leaf gets createdAt/updatedAt/statusChangedAt; container without status omits statusChangedAt
    const added = applyOps(
      base,
      [
        {
          op: "add_node",
          node: { id: "C1", parentId: "G", type: "option", title: "Container" }
        },
        {
          op: "add_node",
          node: { id: "T2", parentId: "C1", type: "task", title: "Task 2", status: "active" }
        }
      ],
      { now: t1 }
    );

    const c1 = added.graph.nodes.find((n) => n.id === "C1")!;
    expect(c1.createdAt).toBe(t1);
    expect(c1.updatedAt).toBe(t1);
    expect(c1.statusChangedAt).toBeUndefined();

    const t2Node = added.graph.nodes.find((n) => n.id === "T2")!;
    expect(t2Node.createdAt).toBe(t1);
    expect(t2Node.updatedAt).toBe(t1);
    expect(t2Node.statusChangedAt).toBe(t1);

    // Legacy T1 untouched
    const t1Node = added.graph.nodes.find((n) => n.id === "T1")!;
    expect(t1Node.createdAt).toBeUndefined();
    expect(t1Node.updatedAt).toBeUndefined();

    // 2. Content-only update bumps updatedAt but NOT statusChangedAt
    const contentUpdated = applyOps(
      added.graph,
      [{ op: "update_node", id: "T2", set: { conclusion: "Initial finding" } }],
      { now: t2 }
    );
    const t2AfterContent = contentUpdated.graph.nodes.find((n) => n.id === "T2")!;
    expect(t2AfterContent.createdAt).toBe(t1);
    expect(t2AfterContent.updatedAt).toBe(t2);
    expect(t2AfterContent.statusChangedAt).toBe(t1);

    // 3. Status change bumps both updatedAt and statusChangedAt
    const statusUpdated = applyOps(
      contentUpdated.graph,
      [{ op: "update_node", id: "T2", set: { status: "done" } }],
      { now: t3 }
    );
    const t2AfterStatus = statusUpdated.graph.nodes.find((n) => n.id === "T2")!;
    expect(t2AfterStatus.updatedAt).toBe(t3);
    expect(t2AfterStatus.statusChangedAt).toBe(t3);

    // 4. Undo even when passing a later `now` restores exact prior timestamps (t2, t1)
    const undoneStatus = applyOps(statusUpdated.graph, statusUpdated.inverse, { now: t4 });
    expect(serializeGraph(undoneStatus.graph)).toBe(serializeGraph(contentUpdated.graph));

    // 5. Undo on legacy node clears newly stamped updatedAt/statusChangedAt
    const legacyEdited = applyOps(
      base,
      [{ op: "update_node", id: "T1", set: { status: "active" } }],
      { now: t2 }
    );
    expect(legacyEdited.graph.nodes.find((n) => n.id === "T1")?.updatedAt).toBe(t2);
    expect(legacyEdited.graph.nodes.find((n) => n.id === "T1")?.statusChangedAt).toBe(t2);

    const legacyUndone = applyOps(legacyEdited.graph, legacyEdited.inverse, { now: t4 });
    expect(serializeGraph(legacyUndone.graph)).toBe(serializeGraph(base));

    // 6. No-op update, sibling reorder (`after`), reparent (`parentId`), and container dissolve do NOT bump updatedAt
    const reordered = applyOps(
      contentUpdated.graph,
      [
        { op: "update_node", id: "T2", set: { conclusion: "Initial finding" } },
        { op: "update_node", id: "T1", set: { after: null } },
        { op: "update_node", id: "C1", set: { after: "T1" } }
      ],
      { now: t4 }
    );
    expect(reordered.graph.nodes.find((n) => n.id === "T2")?.updatedAt).toBe(t2);
    expect(reordered.graph.nodes.find((n) => n.id === "T1")?.updatedAt).toBeUndefined();
    expect(reordered.graph.nodes.find((n) => n.id === "C1")?.updatedAt).toBe(t1);

    const dissolved = applyOps(
      contentUpdated.graph,
      [{ op: "remove_node", id: "C1", cascade: false }],
      { now: t4 }
    );
    expect(dissolved.graph.nodes.find((n) => n.id === "T2")?.parentId).toBe("G");
    expect(dissolved.graph.nodes.find((n) => n.id === "T2")?.updatedAt).toBe(t2);
  });

  it("derives subtreeUpdatedAt as the latest timestamp across descendants", () => {
    const g: Graph = {
      schemaVersion: 1,
      id: "subtree-ts",
      title: "Subtree Timestamps",
      nodes: [
        { id: "Root", type: "goal", title: "Root", createdAt: "2026-11-20T00:00:00.000Z" },
        { id: "ChildA", parentId: "Root", type: "task", title: "A", status: "done", updatedAt: "2026-11-22T12:00:00.000Z" },
        { id: "ChildB", parentId: "Root", type: "task", title: "B", status: "active", statusChangedAt: "2026-11-25T15:30:00.000Z" }
      ],
      edges: []
    };
    const derived = deriveGraph(g);
    expect(derived.subtreeUpdatedAt.get("Root")).toBe("2026-11-25T15:30:00.000Z");
    expect(derived.subtreeUpdatedAt.get("ChildA")).toBe("2026-11-22T12:00:00.000Z");
    expect(derived.subtreeUpdatedAt.get("ChildB")).toBe("2026-11-25T15:30:00.000Z");
  });

  it("reconciles timestamps on external edits without fabricating timestamps for untouched nodes", () => {
    const now = "2026-11-26T12:00:00.000Z";
    const base: Graph = {
      schemaVersion: 1,
      id: "ext-ts",
      title: "External",
      nodes: [
        { id: "A", type: "goal", title: "Untouched", status: "active" },
        {
          id: "B",
          type: "task",
          title: "Content Edited",
          status: "todo",
          createdAt: "2026-11-20T00:00:00.000Z",
          updatedAt: "2026-11-20T00:00:00.000Z"
        },
        { id: "C", type: "task", title: "Explicit Ts", status: "todo" }
      ],
      edges: []
    };

    const next: Graph = {
      ...base,
      nodes: [
        base.nodes[0]!,
        { ...base.nodes[1]!, title: "Content Edited v2", status: "done" },
        {
          ...base.nodes[2]!,
          title: "Explicit Ts v2",
          updatedAt: "2026-11-25T08:00:00.000Z"
        },
        { id: "D", type: "task", title: "New External Node", status: "todo" }
      ]
    };

    const res = reconcileExternalTimestamps(base, next, now);
    expect(res.changed).toBe(true);

    const a = res.graph.nodes.find((n) => n.id === "A")!;
    expect(a.createdAt).toBeUndefined();
    expect(a.updatedAt).toBeUndefined();

    const b = res.graph.nodes.find((n) => n.id === "B")!;
    expect(b.createdAt).toBe("2026-11-20T00:00:00.000Z");
    expect(b.updatedAt).toBe(now);
    expect(b.statusChangedAt).toBe(now);

    const c = res.graph.nodes.find((n) => n.id === "C")!;
    expect(c.updatedAt).toBe("2026-11-25T08:00:00.000Z");

    const d = res.graph.nodes.find((n) => n.id === "D")!;
    expect(d.createdAt).toBe(now);
    expect(d.updatedAt).toBe(now);
    expect(d.statusChangedAt).toBe(now);
  });
});
