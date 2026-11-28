import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultCollapsed, projectGraph, type Graph, type ViewMode } from "@tchain/core";
import { isAllExpanded, useWorkbenchStore } from "../src/store.js";
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
  it.each(["parked", "discarded"] as const)("defaults %s branches to collapsed and allows expansion", async (status) => {
    const branchGraph: Graph = { ...graph, nodes: [...graph.nodes,
      { id: "Branch", parentId: "Root", type: "option", title: "Branch", status },
      { id: "Nested", parentId: "Branch", type: "option", title: "Nested", status: "todo" },
      { id: "NestedChild", parentId: "Nested", type: "task", title: "Nested child", status: "todo" },
      { id: "RolledUp", parentId: "Root", type: "option", title: "Rolled up" },
      { id: "StatusChild", parentId: "RolledUp", type: "task", title: "Status child", status }
    ] };
    vi.mocked(fetchGraphDetail).mockResolvedValue({
      ok: true, graphId: graph.id, file: "view-controls.tgraph.json",
      graph: branchGraph, hash: "test-hash", workspaceRoot: "test", warnings: [],
      lastError: null, pendingExternalChange: null
    });
    vi.mocked(fetchPendingPatches).mockResolvedValue({ ok: true, graphId: graph.id, count: 0, patches: [] });
    await useWorkbenchStore.getState().selectGraph(graph.id);
    for (const view of views) {
      const state = useWorkbenchStore.getState();
      expect(state.collapsedByView[view]).toContain("Branch");
      expect(state.collapsedByView[view]).toContain("RolledUp");
      expect(state.collapsedByView[view]).not.toContain("Nested");
      expect(state.collapsedByView[view]).not.toContain("StatusChild");
      const rendered = projectGraph(branchGraph, { view, collapsed: state.collapsedByView[view],
        showParked: true, showDiscarded: true });
      expect(rendered.nodes.find((n) => n.id === "Branch")?.isCollapsed).toBe(true);
      expect(rendered.nodes.map((n) => n.id)).not.toContain("NestedChild");
    }
    useWorkbenchStore.getState().toggleCollapse("Branch");
    expect(useWorkbenchStore.getState().collapsedByView.workspace).not.toContain("Branch");
    useWorkbenchStore.getState().expandAll();
    const state = useWorkbenchStore.getState();
    const expanded = projectGraph(branchGraph, { view: "workspace", collapsed: state.collapsedByView.workspace,
      showParked: state.showParked, showDiscarded: state.showDiscarded });
    expect(expanded.nodes.map((n) => n.id)).toContain("NestedChild");
    expect(expanded.nodes.map((n) => n.id)).toContain("StatusChild");
    expect(expanded.nodes.every((n) => !n.isCollapsed)).toBe(true);
  });

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

describe("expand all", () => {
  it.each(views)("expands nested containers and resets visibility in %s", (view) => {
    const withHidden: Graph = { ...graph, nodes: [...graph.nodes,
      { id: "Parked", parentId: "Root", type: "task", title: "Parked", status: "parked" },
      { id: "Discarded", parentId: "Root", type: "task", title: "Discarded", status: "discarded" }
    ] };
    const collapsedByView = { workspace: ["Root", "Done"], focus: ["Root", "Done"], report: ["Root", "Done"] };
    useWorkbenchStore.setState({ graph: withHidden, view, collapsedByView, drillRoot: "Done",
      showParked: false, showDiscarded: false, focusHideDimmed: true,
      fitViewTarget: { nonce: 0, nodeIds: ["Child"] } });
    const nonce = useWorkbenchStore.getState().fitViewNonce;
    useWorkbenchStore.getState().expandAll();
    const state = useWorkbenchStore.getState();
    expect(state.collapsedByView[view]).toEqual([]);
    for (const other of views.filter((v) => v !== view)) {
      expect(state.collapsedByView[other]).toEqual(collapsedByView[other]);
    }
    expect(state.drillRoot).toBeNull();
    expect(state.showParked).toBe(true);
    expect(state.showDiscarded).toBe(true);
    expect(state.focusHideDimmed).toBe(false);
    expect(state.fitViewTarget).toBeNull();
    expect(state.fitViewNonce).toBe(nonce + 1);
    const rendered = projectGraph(withHidden, { view, collapsed: state.collapsedByView[view],
      showParked: state.showParked, showDiscarded: state.showDiscarded, focusHideDimmed: state.focusHideDimmed });
    expect(rendered.nodes.every((n) => !n.isCollapsed)).toBe(true);
    if (view !== "report") {
      expect(rendered.nodes.map((n) => n.id).sort()).toEqual(withHidden.nodes.map((n) => n.id).sort());
    }
    useWorkbenchStore.getState().setView(view === "workspace" ? "focus" : "workspace");
    useWorkbenchStore.getState().setView(view);
    expect(useWorkbenchStore.getState().collapsedByView[view]).toEqual([]);
  });

  it("does nothing before a graph is loaded", () => {
    const before = useWorkbenchStore.getState();
    before.expandAll();
    expect(useWorkbenchStore.getState()).toBe(before);
  });
});


describe("expand/collapse all toggle", () => {
  it.each(views)("cycles and follows manual state in %s", (view) => {
    const collapsedByView = { workspace: ["Done"], focus: ["Done"], report: ["Done"] };
    useWorkbenchStore.setState({ graph, view, collapsedByView, drillRoot: "Done" });
    const toggle = () => useWorkbenchStore.getState().toggleExpandAll();
    const expanded = () => isAllExpanded(useWorkbenchStore.getState());
    expect(expanded()).toBe(false);
    toggle();
    expect(expanded()).toBe(true);
    const nonce = useWorkbenchStore.getState().fitViewNonce;
    toggle();
    let state = useWorkbenchStore.getState();
    expect(expanded()).toBe(false);
    expect(state.collapsedByView[view].sort()).toEqual(["Done", "Root"]);
    expect(state.showDiscarded).toBe(false);
    expect(state.showParked).toBe(false);
    expect(state.drillRoot).toBeNull();
    expect(state.fitViewTarget).toBeNull();
    expect(state.fitViewNonce).toBe(nonce + 1);
    for (const other of views.filter((v) => v !== view)) {
      expect(state.collapsedByView[other]).toEqual(collapsedByView[other]);
    }
    state.toggleCollapse("Root");
    state = useWorkbenchStore.getState();
    const rendered = projectGraph(graph, { view, collapsed: state.collapsedByView[view] });
    expect(rendered.nodes.find((n) => n.id === "Done")?.isCollapsed).toBe(true);
    toggle();
    expect(expanded()).toBe(true);
    useWorkbenchStore.getState().toggleCollapse("Done");
    expect(expanded()).toBe(false);
    toggle();
    expect(expanded()).toBe(true);
    useWorkbenchStore.getState().drillInto("Done");
    expect(expanded()).toBe(false);
    toggle();
    useWorkbenchStore.getState().setShowParked(false);
    expect(expanded()).toBe(false);
    toggle();
    expect(expanded()).toBe(true);
  });

  it("does nothing without a graph", () => {
    const before = useWorkbenchStore.getState();
    before.toggleExpandAll();
    expect(useWorkbenchStore.getState()).toBe(before);
    expect(isAllExpanded(before)).toBe(false);
  });
});
