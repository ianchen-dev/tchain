import fs from "node:fs";
import path from "node:path";
import ELK from "elkjs/lib/elk.bundled.js";
import { describe, expect, it } from "vitest";
import { getDefaultCollapsed, projectGraph, type Graph } from "@tchain/core";
import { buildElkGraph, flattenElkOutput, type ElkNodeOutput } from "../src/layout/elkGraph.js";
import { estimateNodeSize } from "../src/layout/sizing.js";

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../fixtures/announcement-pipeline.tgraph.json"
);

function loadSampleGraph(): Graph {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as Graph;
}

describe("Web ELK Layout Engine & Sizing (0 号样板 smoke tests)", () => {
  const sample = loadSampleGraph();
  const elk = new ELK();

  it("estimates larger dimensions in report view and scales with metrics/conclusion", () => {
    const rgWs = projectGraph(sample, { view: "workspace" });
    const rgRep = projectGraph(sample, { view: "report", collapsed: [] });

    const h9Ws = rgWs.nodes.find((n) => n.id === "H9")!;
    const h9Rep = rgRep.nodes.find((n) => n.id === "H9")!;

    const sWs = estimateNodeSize(h9Ws, "workspace");
    const sRep = estimateNodeSize(h9Rep, "report");

    expect(sRep.width).toBeGreaterThan(sWs.width);
    expect(sRep.height).toBeGreaterThan(sWs.height);
    expect(sWs.height).toBeGreaterThanOrEqual(78);
  });

  it("layouts full workspace, report, collapsed, and drilled views with valid absolute edge points in <300ms", async () => {
    const scenarios = [
      {
        name: "workspace-full",
        rg: projectGraph(sample, { view: "workspace", showDiscarded: true, showParked: true })
      },
      {
        name: "workspace-collapsed-H2-K",
        rg: projectGraph(sample, {
          view: "workspace",
          collapsed: ["H2", "K"],
          showDiscarded: false,
          showParked: false
        })
      },
      {
        name: "drill-H2",
        rg: projectGraph(sample, {
          view: "workspace",
          drillRoot: "H2",
          showDiscarded: true,
          showParked: true
        })
      },
      {
        name: "report-default",
        rg: projectGraph(sample, {
          view: "report",
          collapsed: getDefaultCollapsed(sample, "report")
        })
      }
    ];

    for (const sc of scenarios) {
      const { elkGraph } = buildElkGraph(sc.rg);
      const t0 = performance.now();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = (await elk.layout(elkGraph as any)) as ElkNodeOutput;
      const ms = performance.now() - t0;

      const positioned = flattenElkOutput(sc.rg, out, ms);
      expect(positioned.nodes.length).toBe(
        sc.rg.nodes.length + sc.rg.externalStubs.length + sc.rg.capsules.length
      );
      expect(positioned.edges.length).toBe(sc.rg.edges.length);

      for (const n of positioned.nodes) {
        expect(Number.isFinite(n.x)).toBe(true);
        expect(Number.isFinite(n.y)).toBe(true);
        expect(n.width).toBeGreaterThan(0);
        expect(n.height).toBeGreaterThan(0);
      }

      for (const e of positioned.edges) {
        expect(e.points.length).toBeGreaterThanOrEqual(2);
        for (const p of e.points) {
          expect(Number.isFinite(p.x)).toBe(true);
          expect(Number.isFinite(p.y)).toBe(true);
        }
      }

      expect(ms).toBeLessThan(300);
    }
  });
});
