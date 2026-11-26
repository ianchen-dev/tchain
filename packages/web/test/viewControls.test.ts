import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultCollapsed, projectGraph, type Graph, type ViewMode } from "@tchain/core";
import { useWorkbenchStore } from "../src/store.js";
import { fetchGraphDetail, fetchPendingPatches } from "../src/api.js";

vi.mock("../src/api.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/api.js")>(),
  fetchGraphDetail: vi.fn(),
  fetchPendingPatches: vi.fn()
}));

const graph: Graph = {
  schemaVersion: 1, id: "view-controls", title: "View controls",
  nodes: [
    { id: "Root", type: "goal", title: "Root" },
    { id: "Done", parentId: "Root", type: "option", title: "Done" },
    { id: "Child", parentId: "Done", type: "task", title: "Child", status: "done" },
    { id: "Pending", parentId: "Root", type: "task", title: "Pending", status: "todo" }
  ], edges: []
};
const views: ViewMode[] = ["workspace", "focus", "report"];

beforeEach(() => {
  vi.clearAllMocks();
  useWorkbenchStore.setState(useWorkbenchStore.getInitialState());
});

describe("default completed-container collapse", () => {
  it("initializes every view when opening a graph", async () => {
    vi.mocked(fetchGraphDetail).mockResolvedValue({
      ok: true, graphId: graph.id, file: "view-controls.tgraph.json",
      graph, hash: "test-hash", workspaceRoot: "test", warnings: [],
      lastError: null, pendingExternalChange: null
    });
    vi.mocked(fetchPendingPatches).mockResolvedValue({ ok: true, graphId: graph.id, count: 0, patches: [] });
    await useWorkbenchStore.getState().selectGraph(graph.id);
    for (const view of views) {
      const state = useWorkbenchStore.getState();
      expect(state.collapsedByView[view]).toEqual(getDefaultCollapsed(graph, view));
      expect(state.collapsedByView[view]).toContain("Done");
    }
    const state = useWorkbenchStore.getState();
    const rendered = projectGraph(graph, { view: "workspace", collapsed: state.collapsedByView.workspace });
    expect(rendered.nodes.map((n) => n.id)).toEqual(["Root", "Done", "Pending"]);
    expect(rendered.nodes.find((n) => n.id === "Done")?.isCollapsed).toBe(true);
  });

  it.each(views)("preserves manual expansion when returning to %s", (view) => {
    useWorkbenchStore.setState({ graph, view, collapsedByView: {
      workspace: ["Done"], focus: ["Done"], report: ["Done"]
    } });
    useWorkbenchStore.getState().toggleCollapse("Done");
    useWorkbenchStore.getState().setView(view === "workspace" ? "focus" : "workspace");
    useWorkbenchStore.getState().setView(view);
    expect(useWorkbenchStore.getState().collapsedByView[view]).toEqual([]);
  });
});
