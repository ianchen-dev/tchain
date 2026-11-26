import { beforeEach, describe, expect, it } from "vitest";
import { evaluatePatchAgainstGraph, hashGraph, projectGraph, type Graph, type PatchFile, type PatchOp } from "@tchain/core";
import { reviewNodeIds } from "../src/reviewNavigation.js";
import { useWorkbenchStore } from "../src/store.js";

const graph: Graph = {
  schemaVersion: 1, id: "review-test", title: "Review navigation",
  nodes: [
    { id: "Root", type: "goal", title: "Root", status: "todo" },
    { id: "Group", parentId: "Root", type: "option", title: "Group", status: "todo" },
    { id: "Changed", parentId: "Group", type: "task", title: "Changed", status: "parked" },
    { id: "Other", type: "goal", title: "Other", status: "todo" },
    { id: "OtherChild", parentId: "Other", type: "task", title: "Other child", status: "todo" }
  ],
  edges: [{ source: "Changed", target: "OtherChild" }]
};

function patch(id: string, ops: PatchOp[]): PatchFile {
  return { id, graphId: graph.id, baseHash: hashGraph(graph), author: "codex", title: id,
    rationale: "", state: "pending", diagnostics: [], ops };
}

function queue(...patches: PatchFile[]) {
  useWorkbenchStore.setState({ pendingPatches: patches.map((patch) => ({
    patch, file: `${patch.id}.json`, evaluation: evaluatePatchAgainstGraph(graph, patch)
  })) });
}

beforeEach(() => {
  useWorkbenchStore.setState({ ...useWorkbenchStore.getInitialState(), graph, loading: false });
});

describe("review canvas navigation", () => {
  it("reveals modified nodes outside the drilled, collapsed and filtered view before focusing", () => {
    queue(patch("update", [{ op: "update_node", id: "Changed", set: { title: "Updated" } }]));
    useWorkbenchStore.setState({ view: "focus", drillRoot: "Other", focusHideDimmed: true,
      showParked: false, collapsedByView: { workspace: [], focus: ["Root", "Group", "Other"], report: [] } });
    useWorkbenchStore.getState().openPatchReview();
    const state = useWorkbenchStore.getState();
    expect(state.fitViewTarget).toEqual({ nonce: state.fitViewNonce, nodeIds: ["Changed"] });
    expect(state.drillRoot).toBeNull();
    expect(state.collapsedByView.focus).toEqual(["Other"]);
    expect(state.showParked).toBe(true);
    expect(state.focusHideDimmed).toBe(false);
    expect(projectGraph(graph, { view: state.view, collapsed: state.collapsedByView.focus,
      showParked: state.showParked, focusHideDimmed: state.focusHideDimmed }).nodes.some((n) => n.id === "Changed")).toBe(true);
  });

  it("locates newly added preview nodes without changing the baseline graph", () => {
    queue(patch("add", [{ op: "add_node", node: { id: "New", parentId: "Group", type: "task", title: "New", status: "todo" } }]));
    useWorkbenchStore.getState().openPatchReview();
    useWorkbenchStore.getState().jumpToNode("New");
    const state = useWorkbenchStore.getState();
    expect(state.selectedNodeId).toBe("New");
    expect(state.fitViewTarget?.nodeIds).toEqual(["New"]);
    expect(state.graph).toBe(graph);
    expect(state.graph?.nodes.some((n) => n.id === "New")).toBe(false);
  });

  it("targets both endpoints for edge additions and removals", () => {
    expect(reviewNodeIds(graph, graph, [
      { op: "remove_edge", source: "Changed", target: "OtherChild" },
      { op: "add_edge", source: "Group", target: "OtherChild" }
    ])).toEqual(["Changed", "OtherChild", "Group"]);
  });

  it("locates deletion context at the nearest surviving ancestor", () => {
    queue(patch("delete", [{ op: "remove_node", id: "Group", cascade: true }]));
    useWorkbenchStore.getState().openPatchReview();
    expect(useWorkbenchStore.getState().fitViewTarget?.nodeIds).toEqual(["Root"]);
    useWorkbenchStore.getState().jumpToNode("Changed");
    expect(useWorkbenchStore.getState().selectedNodeId).toBe("Root");
  });

  it("falls back to a surviving neighbour for a deleted top-level node", () => {
    const preview = { ...graph, nodes: graph.nodes.filter((n) => n.id !== "OtherChild"), edges: [] };
    expect(reviewNodeIds(graph, preview, [{ op: "remove_node", id: "OtherChild", cascade: true }])).toEqual(["Other"]);
    const topLevel = { ...graph, nodes: graph.nodes.map((n) => n.id === "OtherChild" ? { ...n, parentId: undefined } : n) };
    expect(reviewNodeIds(topLevel, preview, [{ op: "remove_node", id: "OtherChild", cascade: true }])).toEqual(["Changed"]);
  });

  it("reissues focus when switching proposals or reopening the same proposal", () => {
    queue(patch("first", [{ op: "update_node", id: "Changed", set: { title: "First" } }]),
      patch("second", [{ op: "update_node", id: "OtherChild", set: { title: "Second" } }]));
    useWorkbenchStore.getState().openPatchReview("first");
    const firstNonce = useWorkbenchStore.getState().fitViewNonce;
    useWorkbenchStore.getState().openPatchReview("second");
    expect(useWorkbenchStore.getState().fitViewTarget).toEqual({ nonce: firstNonce + 1, nodeIds: ["OtherChild"] });
    useWorkbenchStore.getState().openPatchReview("second");
    expect(useWorkbenchStore.getState().fitViewNonce).toBe(firstNonce + 2);
  });

  it("updates focus with checked operations and handles an empty selection", () => {
    queue(patch("subset", [
      { op: "update_node", id: "Changed", set: { title: "Updated" } },
      { op: "update_node", id: "OtherChild", set: { title: "Updated too" } }
    ]));
    useWorkbenchStore.getState().openPatchReview();
    useWorkbenchStore.getState().toggleReviewOp(0, false);
    expect(useWorkbenchStore.getState().fitViewTarget?.nodeIds).toEqual(["OtherChild"]);
    useWorkbenchStore.getState().toggleReviewOp(1, false);
    expect(useWorkbenchStore.getState().fitViewTarget).toBeNull();
  });

  it("reveals and focuses external preview changes too", () => {
    useWorkbenchStore.setState({ pendingExternalChange: {
      id: "external", graphId: graph.id, file: "review-test.json", baseHash: "base", nextHash: "next",
      nextGraph: { ...graph, nodes: [...graph.nodes, { id: "External", type: "task", title: "External", status: "todo" }] },
      ops: [{ op: "add_node", node: { id: "External", type: "task", title: "External", status: "todo" } }],
      summary: { totalOps: 1, addedNodes: 1, updatedNodes: 0, removedNodes: 0, statusChanges: 0, addedAttachments: 0, addedEdges: 0, removedEdges: 0 },
      metadataChanged: false, warnings: [], detectedAt: "2026-11-26"
    } });
    useWorkbenchStore.getState().openExternalReview();
    expect(useWorkbenchStore.getState().fitViewTarget?.nodeIds).toEqual(["External"]);
    useWorkbenchStore.getState().jumpToNode("External");
    expect(useWorkbenchStore.getState().selectedNodeId).toBe("External");
  });

  it("lets full-graph fit supersede targeted focus", () => {
    useWorkbenchStore.getState().jumpToNode("Changed");
    useWorkbenchStore.getState().triggerFitView();
    const state = useWorkbenchStore.getState();
    expect(state.fitViewTarget?.nonce).not.toBe(state.fitViewNonce);
    state.closeReview();
    expect(useWorkbenchStore.getState().fitViewTarget).toBeNull();
  });
});
