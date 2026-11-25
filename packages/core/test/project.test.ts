import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getDefaultCollapsed,
  projectGraph,
  type Graph
} from "../src/index.js";

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../fixtures/announcement-pipeline.tgraph.json"
);

function loadSampleGraph(): Graph {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as Graph;
}

describe("projectGraph() — 0 号样板 & 投影流水线", () => {
  const sample = loadSampleGraph();

  it("renders full workspace view with all nodes when nothing is collapsed or hidden", () => {
    const rg = projectGraph(sample, {
      view: "workspace",
      showDiscarded: true,
      showParked: true
    });

    expect(rg.nodes.length).toBe(sample.nodes.length);
    expect(rg.edges.length).toBe(sample.edges.length);
    expect(rg.externalStubs).toEqual([]);
    expect(rg.capsules).toEqual([]);
    expect(rg.breadcrumbs).toEqual([{ id: null, title: sample.title }]);
    expect(rg.renderHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    // Same input -> identical renderHash
    const rg2 = projectGraph(sample, {
      view: "workspace",
      showDiscarded: true,
      showParked: true
    });
    expect(rg2.renderHash).toBe(rg.renderHash);
  });

  it("lifts cross-container edges and dedupes parallel edges when H2 and K are collapsed", () => {
    const rg = projectGraph(sample, {
      view: "workspace",
      collapsed: ["H2", "K"],
      showDiscarded: true,
      showParked: true
    });

    const nodeIds = new Set(rg.nodes.map((n) => n.id));
    expect(nodeIds.has("H2")).toBe(true);
    expect(nodeIds.has("K")).toBe(true);
    // Descendants of H2 and K are folded
    for (const folded of ["H3", "H4", "H6", "H7", "H8", "H5", "H9", "K1", "K2", "K6"]) {
      expect(nodeIds.has(folded)).toBe(false);
    }

    // H7 -> K1 and H9 -> K5 both lift to H2 -> K and merge with count = 2
    const h2ToK = rg.edges.find((e) => e.source === "H2" && e.target === "K" && e.kind === "flow");
    expect(h2ToK).toBeDefined();
    expect(h2ToK?.lifted).toBe(true);
    expect(h2ToK?.count).toBe(2);
    expect(h2ToK?.originalEdges).toEqual(
      expect.arrayContaining([
        { source: "H7", target: "K1", kind: "flow" },
        { source: "H9", target: "K5", kind: "flow" }
      ])
    );

    // K6 -revises-> H9 lifts to K -revises-> H2
    const kRevH2 = rg.edges.find(
      (e) => e.source === "K" && e.target === "H2" && e.kind === "revises"
    );
    expect(kRevH2).toBeDefined();
    expect(kRevH2?.lifted).toBe(true);

    // No self-loops after lifting internal edges (e.g. H6->H7, K1->K2)
    expect(rg.edges.some((e) => e.source === e.target)).toBe(false);

    // Collapsed container metadata
    const kNode = rg.nodes.find((n) => n.id === "K");
    expect(kNode?.isCollapsed).toBe(true);
    expect(kNode?.childCount).toBe(6);
    expect(kNode?.statusSummary.active).toBe(1);
    expect(kNode?.statusSummary.todo).toBe(5);
  });

  it("drills down into H2 with accurate breadcrumbs and external stubs", () => {
    const rg = projectGraph(sample, {
      view: "workspace",
      drillRoot: "H2",
      showDiscarded: true,
      showParked: true
    });

    expect(rg.drillRoot).toBe("H2");
    expect(rg.breadcrumbs.map((b) => b.id)).toEqual([null, "G", "H", "H2"]);

    const nodeIds = rg.nodes.map((n) => n.id);
    expect(nodeIds).toEqual(["H3", "H4", "H6", "H7", "H8", "H5", "H9"]);
    // Direct children of H2 now have parentId undefined in drilled view
    expect(rg.nodes.find((n) => n.id === "H4")?.parentId).toBeUndefined();
    expect(rg.nodes.find((n) => n.id === "H6")?.parentId).toBe("H4");

    // External stubs: outgoing K1 (from H7), outgoing K5 (from H9), incoming K6 (revises H9)
    expect(rg.externalStubs.map((s) => `${s.direction}:${s.targetNodeId}`).sort()).toEqual([
      "in:K6",
      "out:K1",
      "out:K5"
    ]);

    expect(
      rg.edges.some(
        (e) => e.source === "H7" && e.target === "__ext_out__K1" && e.isExternal
      )
    ).toBe(true);
    expect(
      rg.edges.some(
        (e) =>
          e.source === "__ext_in__K6" &&
          e.target === "H9" &&
          e.kind === "revises" &&
          e.isExternal
      )
    ).toBe(true);
  });

  it("collapses discarded and parked branches into capsules with statusNote items", () => {
    const hideDiscarded = projectGraph(sample, {
      view: "workspace",
      showDiscarded: false,
      showParked: true
    });

    const nodeIds = new Set(hideDiscarded.nodes.map((n) => n.id));
    expect(nodeIds.has("X1")).toBe(false);
    expect(nodeIds.has("X2")).toBe(false);
    expect(nodeIds.has("D")).toBe(true);

    const capD = hideDiscarded.capsules.find(
      (c) => c.parentId === "D" && c.bucket === "discarded"
    );
    expect(capD).toBeDefined();
    expect(capD?.label).toBe("已排除 2 项");
    expect(capD?.items.map((i) => i.id)).toEqual(["X1", "X2"]);
    expect(capD?.items[0]?.statusNote).toContain("巨潮");

    // Incoming fork edges D1 -> capD and D2 -> capD
    expect(
      hideDiscarded.edges.some(
        (e) => e.source === "D1" && e.target === capD?.id && e.isCapsuleEdge
      )
    ).toBe(true);

    // Hide parked branches as well
    const hideBoth = projectGraph(sample, {
      view: "workspace",
      showDiscarded: false,
      showParked: false
    });
    const bothIds = new Set(hideBoth.nodes.map((n) => n.id));
    for (const hidden of ["A", "C", "C1", "C2", "D", "D1", "D2", "D3", "X1", "X2", "I"]) {
      expect(bothIds.has(hidden)).toBe(false);
    }
    expect(
      hideBoth.capsules.find((c) => c.parentId === "B" && c.bucket === "parked")?.label
    ).toBe("已搁置 2 项");
    expect(
      hideBoth.capsules.find((c) => c.parentId === "G" && c.bucket === "parked")?.label
    ).toBe("已搁置 1 项");
    expect(
      hideBoth.capsules.find((c) => c.parentId === undefined && c.bucket === "parked")?.label
    ).toBe("已搁置 1 项");
  });

  it("highlights focus nodes and dims non-focus nodes in Focus View, and hides dimmed when requested", () => {
    const focusDim = projectGraph(sample, {
      view: "focus",
      showDiscarded: true,
      showParked: true,
      focusHideDimmed: false
    });

    const byId = new Map(focusDim.nodes.map((n) => [n.id, n]));
    expect(byId.get("K1")?.focusRole).toBe("active");
    expect(byId.get("K1")?.dimmed).toBe(false);
    expect(byId.get("K2")?.focusRole).toBe("next");
    expect(byId.get("K2")?.dimmed).toBe(false);
    expect(byId.get("H7")?.focusRole).toBe("path");
    expect(byId.get("H7")?.dimmed).toBe(false);
    // Ancestors of H7 (H4, H2) stay non-dimmed so H7 isn't trapped in a dimmed container
    expect(byId.get("H4")?.dimmed).toBe(false);
    expect(byId.get("H2")?.dimmed).toBe(false);
    // Parked / discarded branches are dimmed
    expect(byId.get("C")?.dimmed).toBe(true);
    expect(byId.get("D")?.dimmed).toBe(true);
    expect(byId.get("I")?.dimmed).toBe(true);
    expect(byId.get("X1")?.dimmed).toBe(true);

    // Completely hide dimmed nodes
    const focusHidden = projectGraph(sample, {
      view: "focus",
      showDiscarded: false,
      showParked: false,
      focusHideDimmed: true
    });
    const hiddenIds = new Set(focusHidden.nodes.map((n) => n.id));
    expect(hiddenIds.has("K1")).toBe(true);
    expect(hiddenIds.has("K2")).toBe(true);
    expect(hiddenIds.has("H7")).toBe(true);
    expect(hiddenIds.has("F")).toBe(true);
    expect(hiddenIds.has("E")).toBe(true);
    expect(hiddenIds.has("B")).toBe(true);
    expect(hiddenIds.has("M")).toBe(false);
    expect(hiddenIds.has("N")).toBe(false);
    expect(hiddenIds.has("K6")).toBe(false);
  });

  it("projects Executive Report View cleanly with edgeBypass and full drill-down", () => {
    const defaultCollapsed = getDefaultCollapsed(sample, "report");
    expect(defaultCollapsed).toEqual(expect.arrayContaining(["H2", "K"]));
    expect(defaultCollapsed).not.toContain("G");
    expect(defaultCollapsed).not.toContain("H");

    // Top-level report view with default collapsed containers (B, H2, K collapsed; G, H open)
    const reportCollapsed = projectGraph(sample, {
      view: "report",
      collapsed: defaultCollapsed
    });
    const ids = reportCollapsed.nodes.map((n) => n.id);
    expect(ids).toEqual(["B", "F", "G", "H", "H2", "K", "L", "H10"]);
    // Main storyline stays connected via lifted E -> F (as B -> F) and lifted bypassed H2 -> K (from H9 -> K5 -> K6)
    const h2ToK = reportCollapsed.edges.find(
      (e) => e.source === "H2" && e.target === "K" && e.kind === "flow"
    );
    expect(h2ToK).toBeDefined();
    expect(h2ToK?.lifted).toBe(true);
    expect(h2ToK?.bypassedCount).toBe(1);
    expect(
      reportCollapsed.edges.some((e) => e.source === "B" && e.target === "F" && e.lifted)
    ).toBe(true);
    expect(
      reportCollapsed.edges.some((e) => e.source === "F" && e.target === "G")
    ).toBe(true);
    expect(
      reportCollapsed.edges.some((e) => e.source === "K" && e.target === "L")
    ).toBe(true);
    expect(
      reportCollapsed.edges.some((e) => e.source === "L" && e.target === "H10")
    ).toBe(true);

    // Expanded report view: H9 -> K5(hidden task) -> K6 produces bypassed edge H9 -> K6
    const reportExpanded = projectGraph(sample, {
      view: "report",
      collapsed: []
    });
    const h9ToK6 = reportExpanded.edges.find(
      (e) => e.source === "H9" && e.target === "K6" && e.kind === "flow"
    );
    expect(h9ToK6).toBeDefined();
    expect(h9ToK6?.bypassedCount).toBe(1);

    // Live presentation drill-down into H2 reveals the full derivation subgraph!
    const reportDrilled = projectGraph(sample, {
      view: "report",
      drillRoot: "H2",
      collapsed: defaultCollapsed
    });
    expect(reportDrilled.nodes.map((n) => n.id)).toEqual([
      "H3",
      "H4",
      "H6",
      "H7",
      "H8",
      "H5",
      "H9"
    ]);
  });

  it("edgeBypass bridges multi-hop hidden tasks but never traverses discarded/parked nodes", () => {
    const g: Graph = {
      schemaVersion: 1,
      id: "bypass-test",
      title: "Bypass Test",
      nodes: [
        { id: "G1", type: "goal", title: "Goal", status: "done" },
        { id: "T1", type: "task", title: "Task 1", status: "done" },
        { id: "T2", type: "task", title: "Task 2", status: "done" },
        { id: "M1", type: "milestone", title: "Milestone 1", status: "done" },
        { id: "X1", type: "task", title: "Discarded Task", status: "discarded", statusNote: "no" },
        { id: "M2", type: "milestone", title: "Milestone 2", status: "todo" }
      ],
      edges: [
        { source: "G1", target: "T1" },
        { source: "T1", target: "T2", kind: "depends_on" },
        { source: "T2", target: "M1" },
        { source: "G1", target: "X1" },
        { source: "X1", target: "M2" }
      ]
    };

    const rg = projectGraph(g, { view: "report", showDiscarded: false });
    const g1ToM1 = rg.edges.find((e) => e.source === "G1" && e.target === "M1");
    expect(g1ToM1).toBeDefined();
    expect(g1ToM1?.bypassedCount).toBe(2);
    expect(g1ToM1?.kind).toBe("depends_on");

    // Must NOT bypass through discarded X1 to invent G1 -> M2
    expect(rg.edges.some((e) => e.source === "G1" && e.target === "M2")).toBe(false);
  });
});
