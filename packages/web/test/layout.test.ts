import fs from "node:fs";
import path from "node:path";
import ELK from "elkjs/lib/elk.bundled.js";
import { describe, expect, it } from "vitest";
import { getDefaultCollapsed, projectGraph, type Graph } from "@tchain/core";
import { buildElkGraph, flattenElkOutput, type ElkNodeOutput } from "../src/layout/elkGraph.js";
import { estimateNodeSize } from "../src/layout/sizing.js";
import { getLayoutCacheKey } from "../src/layout/layoutClient.js";

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

  it("allocates the full three-line conclusion and metrics on the workspace K2 card", () => {
    const graph = projectGraph(sample, { view: "workspace" });
    const k2 = graph.nodes.find((node) => node.id === "K2")!;
    const card = {
      ...k2,
      node: {
        ...k2.node,
        conclusion: "据业务人员反馈，私有数据库已有结构化财报数据。财报分析使用已有结构化数据。"
      }
    };

    expect(estimateNodeSize(card, "workspace")).toEqual({ width: 268, height: 163 });
  });

  it.each(["workspace", "focus", "report"] as const)(
    "grows leaf and collapsed cards for every title and conclusion line in %s",
    (view) => {
      const node = projectGraph(sample, { view: "workspace" }).nodes.find((n) => n.id === "K2")!;
      for (const isCollapsed of [false, true]) {
        const short = { ...node, isCollapsed, node: { ...node.node, title: "标题", conclusion: "结论" } };
        const long = {
          ...short,
          node: {
            ...short.node,
            title: Array(12).fill("标题").join("\n"),
            conclusion: Array(12).fill("结论").join("\n")
          }
        };
        const shortSize = estimateNodeSize(short, view);
        const longSize = estimateNodeSize(long, view);
        expect(longSize.width).toBe(shortSize.width);
        expect(longSize.height - shortSize.height).toBe(11 * (view === "report" ? 22 + 19 : 19 + 17));
      }
    }
  );

  it("includes measured heights in layout cache keys regardless of measurement order", () => {
    const graph = projectGraph(sample, { view: "workspace" });
    const heights = new Map([["K2", 350], ["H9", 400]]);
    expect(getLayoutCacheKey(graph, heights)).not.toBe(getLayoutCacheKey(graph));
    expect(getLayoutCacheKey(graph, heights)).toBe(
      getLayoutCacheKey(graph, new Map([...heights].reverse()))
    );
    expect(getLayoutCacheKey(graph, new Map([["K2", 360], ["H9", 400]]))).not.toBe(
      getLayoutCacheKey(graph, heights)
    );
  });

  it("routes edges and sizes containers around measured card heights", async () => {
    const graph: Graph = {
      schemaVersion: 1, id: "long-text", title: "Long text",
      nodes: [
        { id: "Container", type: "goal", title: "Container" },
        { id: "a", parentId: "Container", type: "decision", title: "Long card", status: "done" },
        { id: "b", parentId: "Container", type: "decision", title: "Next card", status: "done" }
      ],
      edges: [{ source: "a", target: "b", kind: "flow" }]
    };
    const renderGraph = projectGraph(graph, { view: "workspace", collapsed: [] });
    const { elkGraph } = buildElkGraph(renderGraph, new Map([["a", 450], ["b", 1], ["Container", 180]]));
    const out = await elk.layout(elkGraph as Parameters<typeof elk.layout>[0]) as ElkNodeOutput;
    const result = flattenElkOutput(renderGraph, out, 0);
    const a = result.nodes.find((n) => n.id === "a")!;
    const b = result.nodes.find((n) => n.id === "b")!;
    const container = result.nodes.find((n) => n.id === "Container")!;
    expect(a.height).toBe(450);
    expect(a.y).toBeGreaterThanOrEqual(container.y + 180);
    expect(b.height).toBeGreaterThanOrEqual(78);
    expect(b.y).toBeGreaterThan(a.y + a.height);
    expect(container.y + container.height).toBeGreaterThan(b.y + b.height);
    expect(result.edges[0]!.points[0]!.y).toBe(a.y + a.height);
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
