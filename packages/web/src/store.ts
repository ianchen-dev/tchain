import { create } from "zustand";
import {
  deriveGraph,
  getDefaultCollapsed,
  type Diagnostic,
  type Graph,
  type ViewMode
} from "@tchain/core";
import {
  fetchGraphDetail,
  fetchGraphs,
  type GraphErrorRecord,
  type GraphSummaryItem
} from "./api.js";

export type SseStatus = "connecting" | "connected" | "reconnecting";

export interface PreviewDocState {
  path: string;
  title?: string;
}

interface WorkbenchState {
  workspaceRoot: string;
  graphs: GraphSummaryItem[];
  activeGraphId: string | null;
  graph: Graph | null;
  graphHash: string | null;
  warnings: Diagnostic[];
  lastError: GraphErrorRecord | null;
  loading: boolean;
  loadError: string | null;

  // View & projection controls
  view: ViewMode;
  drillRoot: string | null;
  collapsedByView: Record<ViewMode, string[]>;
  showDiscarded: boolean;
  showParked: boolean;
  focusHideDimmed: boolean;
  dimCrossHierarchyEdges: boolean;

  // Selection, Inspector, Markdown evidence reader
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
  previewHistory: PreviewDocState[];
  previewIndex: number;
  commandPaletteOpen: boolean;

  // Live SSE & layout status
  sseStatus: SseStatus;
  lastLayoutMs: number | null;
  lastLayoutCacheHit: boolean;
  fitViewNonce: number;

  // Actions
  bootstrap: () => Promise<void>;
  selectGraph: (graphId: string) => Promise<void>;
  refreshActiveGraph: () => Promise<void>;
  setLastError: (err: GraphErrorRecord | null) => void;
  setSseStatus: (status: SseStatus) => void;

  setView: (view: ViewMode) => void;
  drillInto: (nodeId: string | null) => void;
  popDrill: () => void;
  toggleCollapse: (nodeId: string) => void;
  setShowDiscarded: (show: boolean) => void;
  setShowParked: (show: boolean) => void;
  setFocusHideDimmed: (hide: boolean) => void;
  setDimCrossHierarchyEdges: (dim: boolean) => void;

  selectNode: (nodeId: string | null) => void;
  setHoveredNode: (nodeId: string | null) => void;
  jumpToNode: (nodeId: string) => void;

  openPreviewDoc: (doc: PreviewDocState) => void;
  navigatePreview: (delta: -1 | 1) => void;
  closePreviewDoc: () => void;

  setCommandPaletteOpen: (open: boolean) => void;
  setLayoutStats: (ms: number, cacheHit: boolean) => void;
  triggerFitView: () => void;
}

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
  workspaceRoot: "",
  graphs: [],
  activeGraphId: null,
  graph: null,
  graphHash: null,
  warnings: [],
  lastError: null,
  loading: true,
  loadError: null,

  view: "workspace",
  drillRoot: null,
  collapsedByView: {
    workspace: [],
    focus: [],
    report: []
  },
  showDiscarded: true,
  showParked: true,
  focusHideDimmed: false,
  dimCrossHierarchyEdges: false,

  selectedNodeId: null,
  hoveredNodeId: null,
  previewHistory: [],
  previewIndex: -1,
  commandPaletteOpen: false,

  sseStatus: "connecting",
  lastLayoutMs: null,
  lastLayoutCacheHit: false,
  fitViewNonce: 0,

  bootstrap: async () => {
    set({ loading: true, loadError: null });
    try {
      const list = await fetchGraphs();
      const firstId = list.graphs[0]?.id ?? null;
      set({
        workspaceRoot: list.workspaceRoot,
        graphs: list.graphs
      });
      if (firstId) {
        await get().selectGraph(firstId);
      } else {
        set({ loading: false });
      }
    } catch (err) {
      set({
        loading: false,
        loadError: err instanceof Error ? err.message : String(err)
      });
    }
  },

  selectGraph: async (graphId: string) => {
    set({ loading: true, loadError: null, activeGraphId: graphId });
    try {
      const detail = await fetchGraphDetail(graphId);
      const reportCollapsed = detail.graph
        ? getDefaultCollapsed(detail.graph, "report")
        : [];
      set({
        workspaceRoot: detail.workspaceRoot,
        graph: detail.graph,
        graphHash: detail.hash,
        warnings: detail.warnings,
        lastError: detail.lastError,
        drillRoot: null,
        selectedNodeId: null,
        previewHistory: [],
        previewIndex: -1,
        collapsedByView: {
          workspace: [],
          focus: [],
          report: reportCollapsed
        },
        loading: false,
        fitViewNonce: get().fitViewNonce + 1
      });
    } catch (err) {
      set({
        loading: false,
        loadError: err instanceof Error ? err.message : String(err)
      });
    }
  },

  refreshActiveGraph: async () => {
    const { activeGraphId } = get();
    try {
      const list = await fetchGraphs();
      set({ workspaceRoot: list.workspaceRoot, graphs: list.graphs });

      const targetId =
        activeGraphId && list.graphs.some((g) => g.id === activeGraphId)
          ? activeGraphId
          : (list.graphs[0]?.id ?? null);

      if (!targetId) {
        set({ activeGraphId: null, graph: null, graphHash: null, lastError: null });
        return;
      }

      const detail = await fetchGraphDetail(targetId);
      set((state) => {
        // Keep current drillRoot only if it still exists as a container
        let nextDrill = state.drillRoot;
        if (nextDrill && detail.graph) {
          const derived = deriveGraph(detail.graph);
          if (!derived.isContainer.has(nextDrill)) {
            nextDrill = null;
          }
        }
        return {
          activeGraphId: targetId,
          workspaceRoot: detail.workspaceRoot,
          graph: detail.graph ?? state.graph,
          graphHash: detail.hash ?? state.graphHash,
          warnings: detail.warnings,
          lastError: detail.lastError,
          drillRoot: nextDrill
        };
      });
    } catch (err) {
      set({
        loadError: err instanceof Error ? err.message : String(err)
      });
    }
  },

  setLastError: (err) => set({ lastError: err }),
  setSseStatus: (status) => set({ sseStatus: status }),

  setView: (view) =>
    set((state) => {
      const nextCollapsedByView = { ...state.collapsedByView };
      if (view === "report" && state.graph && nextCollapsedByView.report.length === 0) {
        nextCollapsedByView.report = getDefaultCollapsed(state.graph, "report");
      }
      return {
        view,
        drillRoot: null,
        collapsedByView: nextCollapsedByView,
        showDiscarded: view === "report" ? false : state.showDiscarded,
        showParked: view === "report" ? false : state.showParked,
        fitViewNonce: state.fitViewNonce + 1
      };
    }),

  drillInto: (nodeId) =>
    set((state) => {
      if (nodeId === null) {
        return { drillRoot: null, fitViewNonce: state.fitViewNonce + 1 };
      }
      if (!state.graph) return {};
      const derived = deriveGraph(state.graph);
      if (!derived.isContainer.has(nodeId)) return {};
      return {
        drillRoot: nodeId,
        fitViewNonce: state.fitViewNonce + 1
      };
    }),

  popDrill: () =>
    set((state) => {
      if (!state.drillRoot || !state.graph) return {};
      const curNode = state.graph.nodes.find((n) => n.id === state.drillRoot);
      return {
        drillRoot: curNode?.parentId ?? null,
        fitViewNonce: state.fitViewNonce + 1
      };
    }),

  toggleCollapse: (nodeId) =>
    set((state) => {
      const cur = state.collapsedByView[state.view];
      const exists = cur.includes(nodeId);
      const next = exists ? cur.filter((id) => id !== nodeId) : [...cur, nodeId];
      return {
        collapsedByView: {
          ...state.collapsedByView,
          [state.view]: next
        }
      };
    }),

  setShowDiscarded: (show) => set({ showDiscarded: show }),
  setShowParked: (show) => set({ showParked: show }),
  setFocusHideDimmed: (hide) => set({ focusHideDimmed: hide }),
  setDimCrossHierarchyEdges: (dim) => set({ dimCrossHierarchyEdges: dim }),

  selectNode: (nodeId) => set({ selectedNodeId: nodeId }),
  setHoveredNode: (nodeId) => set({ hoveredNodeId: nodeId }),

  jumpToNode: (nodeId) =>
    set((state) => {
      if (!state.graph) return { selectedNodeId: nodeId };
      const derived = deriveGraph(state.graph);
      const target = derived.nodeMap.get(nodeId);
      if (!target) return {};

      const ancestors = derived.ancestorsMap.get(nodeId) ?? [];
      const eff = derived.effectiveStatus.get(nodeId);

      // If drilled into a subtree that doesn't contain nodeId, exit drillRoot to LCA or root
      let nextDrill = state.drillRoot;
      if (nextDrill && nodeId !== nextDrill) {
        const desc = derived.descendantsMap.get(nextDrill);
        if (!desc?.has(nodeId)) {
          nextDrill = target.parentId ?? null;
        }
      }

      // Uncollapse any collapsed ancestors of nodeId so it becomes visible
      const curCollapsed = state.collapsedByView[state.view];
      const ancestorSet = new Set(ancestors);
      const nextCollapsed = curCollapsed.filter((id) => !ancestorSet.has(id));

      return {
        drillRoot: nextDrill,
        selectedNodeId: nodeId,
        showDiscarded: eff === "discarded" ? true : state.showDiscarded,
        showParked: eff === "parked" ? true : state.showParked,
        collapsedByView: {
          ...state.collapsedByView,
          [state.view]: nextCollapsed
        },
        fitViewNonce: state.fitViewNonce + 1
      };
    }),

  openPreviewDoc: (doc) =>
    set((state) => {
      const current = state.previewHistory[state.previewIndex];
      if (current && current.path === doc.path) {
        return {};
      }
      const nextHist = [...state.previewHistory.slice(0, state.previewIndex + 1), doc];
      return {
        previewHistory: nextHist,
        previewIndex: nextHist.length - 1
      };
    }),

  navigatePreview: (delta) =>
    set((state) => {
      const nextIdx = state.previewIndex + delta;
      if (nextIdx < 0 || nextIdx >= state.previewHistory.length) return {};
      return { previewIndex: nextIdx };
    }),

  closePreviewDoc: () => set({ previewHistory: [], previewIndex: -1 }),

  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setLayoutStats: (ms, cacheHit) =>
    set({ lastLayoutMs: ms, lastLayoutCacheHit: cacheHit }),
  triggerFitView: () => set((state) => ({ fitViewNonce: state.fitViewNonce + 1 }))
}));
