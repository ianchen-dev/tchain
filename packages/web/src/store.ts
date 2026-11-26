import { create } from "zustand";
import {
  patchPreviewGraph,
  resolveReviewNodeIds,
  revealReviewNodes,
  reviewNodeIds
} from "./reviewNavigation.js";
import {
  deriveGraph,
  getDefaultCollapsed,
  toggleOpSelection,
  type Diagnostic,
  type EdgeKind,
  type Graph,
  type HistoryEntry,
  type Op,
  type ViewMode
} from "@tchain/core";
import {
  acceptExternalChangeApi,
  ApiRequestError,
  applyPatchApi,
  createCheckpointApi,
  fetchGraphDetail,
  fetchGraphs,
  fetchHistory,
  fetchPendingPatches,
  postGraphOps,
  rejectPatchApi,
  revertExternalChangeApi,
  rollbackGraphApi,
  type GraphErrorRecord,
  type GraphSummaryItem,
  type PendingExternalChange,
  type PendingPatchItem
} from "./api.js";

export type SseStatus = "connecting" | "connected" | "reconnecting";

export interface PreviewDocState {
  path: string;
  title?: string;
}

export interface SelectedEdgeState {
  source: string;
  target: string;
  kind: EdgeKind;
}

export interface UndoStackEntry {
  label: string;
  inverse: Op[];
  forward: Op[];
}

export type ReviewTarget =
  | { kind: "patch"; patchId: string }
  | { kind: "external" }
  | null;

export interface ToastNotice {
  id: number;
  kind: "info" | "success" | "error";
  message: string;
  hint?: string;
}

let toastSeq = 0;

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

  // Phase 2: Pending patches, external change review, version history, undo/redo
  pendingPatches: PendingPatchItem[];
  pendingExternalChange: PendingExternalChange | null;
  reviewTarget: ReviewTarget;
  reviewSelectedIndices: number[];
  historyOpen: boolean;
  historyEntries: HistoryEntry[];
  historyLoading: boolean;
  undoStack: UndoStackEntry[];
  redoStack: UndoStackEntry[];
  mutating: boolean;
  toast: ToastNotice | null;
  focusStatusNoteNonce: number;
  confirmDeleteNodeId: string | null;

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
  selectedEdge: SelectedEdgeState | null;
  hoveredNodeId: string | null;
  previewHistory: PreviewDocState[];
  previewIndex: number;
  commandPaletteOpen: boolean;

  // Live SSE & layout status
  sseStatus: SseStatus;
  lastLayoutMs: number | null;
  lastLayoutCacheHit: boolean;
  fitViewNonce: number;
  fitViewTarget: { nonce: number; nodeIds: string[] } | null;

  // Actions
  bootstrap: () => Promise<void>;
  selectGraph: (graphId: string) => Promise<void>;
  refreshActiveGraph: () => Promise<void>;
  refreshPatches: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  setLastError: (err: GraphErrorRecord | null) => void;
  setSseStatus: (status: SseStatus) => void;

  // Phase 2 mutations & trust defenses
  submitOps: (
    ops: Op[],
    opts?: { label?: string; snapshotBefore?: boolean; recordUndo?: boolean }
  ) => Promise<boolean>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  openPatchReview: (patchId?: string) => void;
  openExternalReview: () => void;
  closeReview: () => void;
  toggleReviewOp: (index: number, checked: boolean) => void;
  applyActivePatch: () => Promise<void>;
  rejectActivePatch: () => Promise<void>;
  acceptExternalChange: () => Promise<void>;
  revertExternalChange: () => Promise<void>;
  openHistory: () => Promise<void>;
  closeHistory: () => void;
  createCheckpoint: (title?: string) => Promise<void>;
  rollbackToRev: (rev: number) => Promise<void>;

  showToast: (kind: ToastNotice["kind"], message: string, hint?: string) => void;
  clearToast: () => void;
  requestFocusStatusNote: () => void;
  setConfirmDeleteNodeId: (nodeId: string | null) => void;

  setView: (view: ViewMode) => void;
  drillInto: (nodeId: string | null) => void;
  popDrill: () => void;
  toggleCollapse: (nodeId: string) => void;
  setShowDiscarded: (show: boolean) => void;
  setShowParked: (show: boolean) => void;
  setFocusHideDimmed: (hide: boolean) => void;
  setDimCrossHierarchyEdges: (dim: boolean) => void;

  selectNode: (nodeId: string | null) => void;
  selectEdge: (edge: SelectedEdgeState | null) => void;
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

  pendingPatches: [],
  pendingExternalChange: null,
  reviewTarget: null,
  reviewSelectedIndices: [],
  historyOpen: false,
  historyEntries: [],
  historyLoading: false,
  undoStack: [],
  redoStack: [],
  mutating: false,
  toast: null,
  focusStatusNoteNonce: 0,
  confirmDeleteNodeId: null,

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
  selectedEdge: null,
  hoveredNodeId: null,
  previewHistory: [],
  previewIndex: -1,
  commandPaletteOpen: false,

  sseStatus: "connecting",
  lastLayoutMs: null,
  lastLayoutCacheHit: false,
  fitViewNonce: 0,
  fitViewTarget: null,

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
      const [detail, patchesRes] = await Promise.all([
        fetchGraphDetail(graphId),
        fetchPendingPatches(graphId).catch(() => ({ patches: [] as PendingPatchItem[] }))
      ]);
      set({
        workspaceRoot: detail.workspaceRoot,
        graph: detail.graph,
        graphHash: detail.hash,
        warnings: detail.warnings,
        lastError: detail.lastError,
        pendingExternalChange: detail.pendingExternalChange,
        pendingPatches: patchesRes.patches,
        reviewTarget: null,
        reviewSelectedIndices: [],
        historyOpen: false,
        historyEntries: [],
        undoStack: [],
        redoStack: [],
        drillRoot: null,
        selectedNodeId: null,
        selectedEdge: null,
        confirmDeleteNodeId: null,
        previewHistory: [],
        previewIndex: -1,
        collapsedByView: {
          workspace: detail.graph ? getDefaultCollapsed(detail.graph, "workspace") : [],
          focus: detail.graph ? getDefaultCollapsed(detail.graph, "focus") : [],
          report: detail.graph ? getDefaultCollapsed(detail.graph, "report") : []
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
        set({
          activeGraphId: null,
          graph: null,
          graphHash: null,
          lastError: null,
          pendingExternalChange: null,
          pendingPatches: []
        });
        return;
      }

      const [detail, patchesRes] = await Promise.all([
        fetchGraphDetail(targetId),
        fetchPendingPatches(targetId).catch(() => ({ patches: [] as PendingPatchItem[] }))
      ]);

      set((state) => {
        let nextDrill = state.drillRoot;
        if (nextDrill && detail.graph) {
          const derived = deriveGraph(detail.graph);
          if (!derived.isContainer.has(nextDrill)) {
            nextDrill = null;
          }
        }

        let nextReview = state.reviewTarget;
        let nextSelectedIndices = state.reviewSelectedIndices;
        if (nextReview?.kind === "external" && !detail.pendingExternalChange) {
          nextReview = null;
          nextSelectedIndices = [];
        } else if (nextReview?.kind === "patch") {
          const targetPatchId = nextReview.patchId;
          const found = patchesRes.patches.find((p) => p.patch.id === targetPatchId);
          if (!found) {
            nextReview = null;
            nextSelectedIndices = [];
          } else if (found.evaluation && detail.hash !== state.graphHash) {
            nextSelectedIndices = found.evaluation.defaultSelectedIndices;
          }
        }

        return {
          activeGraphId: targetId,
          workspaceRoot: detail.workspaceRoot,
          graph: detail.graph ?? state.graph,
          graphHash: detail.hash ?? state.graphHash,
          warnings: detail.warnings,
          lastError: detail.lastError,
          pendingExternalChange: detail.pendingExternalChange,
          pendingPatches: patchesRes.patches,
          reviewTarget: nextReview,
          reviewSelectedIndices: nextSelectedIndices,
          drillRoot: nextDrill
        };
      });

      if (get().historyOpen) {
        void get().refreshHistory();
      }
    } catch (err) {
      set({
        loadError: err instanceof Error ? err.message : String(err)
      });
    }
  },

  refreshPatches: async () => {
    const { activeGraphId } = get();
    if (!activeGraphId) return;
    try {
      const res = await fetchPendingPatches(activeGraphId);
      set((state) => {
        let nextReview = state.reviewTarget;
        let nextSelected = state.reviewSelectedIndices;
        if (nextReview?.kind === "patch") {
          const targetPatchId = nextReview.patchId;
          const found = res.patches.find((p) => p.patch.id === targetPatchId);
          if (!found) {
            nextReview = null;
            nextSelected = [];
          }
        }
        return {
          pendingPatches: res.patches,
          reviewTarget: nextReview,
          reviewSelectedIndices: nextSelected
        };
      });
    } catch {
      // ignore transient errors
    }
  },

  refreshHistory: async () => {
    const { activeGraphId } = get();
    if (!activeGraphId) return;
    set({ historyLoading: true });
    try {
      const res = await fetchHistory(activeGraphId);
      set({ historyEntries: res.entries, historyLoading: false });
    } catch {
      set({ historyLoading: false });
    }
  },

  setLastError: (err) => set({ lastError: err }),
  setSseStatus: (status) => set({ sseStatus: status }),

  showToast: (kind, message, hint) => {
    const id = ++toastSeq;
    set({ toast: { id, kind, message, hint } });
    setTimeout(() => {
      if (get().toast?.id === id) {
        set({ toast: null });
      }
    }, kind === "error" ? 5000 : 2800);
  },

  clearToast: () => set({ toast: null }),
  requestFocusStatusNote: () =>
    set((state) => ({ focusStatusNoteNonce: state.focusStatusNoteNonce + 1 })),
  setConfirmDeleteNodeId: (nodeId) => set({ confirmDeleteNodeId: nodeId }),

  submitOps: async (ops, opts) => {
    const { activeGraphId, graphHash, mutating } = get();
    if (!activeGraphId || !graphHash || ops.length === 0 || mutating) return false;
    set({ mutating: true });
    try {
      const res = await postGraphOps(activeGraphId, {
        baseHash: graphHash,
        ops,
        source: "manual",
        title: opts?.label,
        snapshotBefore: opts?.snapshotBefore
      });

      set((state) => {
        const nextUndo =
          opts?.recordUndo === false
            ? state.undoStack
            : [
                ...state.undoStack.slice(-49),
                {
                  label: opts?.label ?? "编辑图谱",
                  inverse: res.inverse,
                  forward: ops
                }
              ];

        // Clear selectedNodeId if that node was deleted
        const stillHasSelected =
          state.selectedNodeId !== null &&
          res.graph.nodes.some((n) => n.id === state.selectedNodeId);

        const stillHasEdge =
          state.selectedEdge !== null &&
          res.graph.edges.some(
            (e) =>
              e.source === state.selectedEdge!.source &&
              e.target === state.selectedEdge!.target
          );

        return {
          graph: res.graph,
          graphHash: res.hash,
          warnings: res.warnings,
          lastError: null,
          undoStack: nextUndo,
          redoStack: opts?.recordUndo === false ? state.redoStack : [],
          selectedNodeId: stillHasSelected ? state.selectedNodeId : null,
          selectedEdge: stillHasEdge ? state.selectedEdge : null,
          confirmDeleteNodeId: null,
          mutating: false
        };
      });

      void get().refreshPatches();
      if (get().historyOpen) void get().refreshHistory();
      if (opts?.label) {
        get().showToast("success", opts.label);
      }
      return true;
    } catch (err) {
      set({ mutating: false });
      if (err instanceof ApiRequestError) {
        if (err.code === "STALE_BASE") {
          get().showToast("error", "图谱已被其他修改更新，已自动刷新最新版本，请重试");
          void get().refreshActiveGraph();
          return false;
        }
        const firstDiag = err.diagnostics?.[0];
        get().showToast("error", firstDiag?.message ?? err.message, firstDiag?.hint);
        return false;
      }
      get().showToast("error", err instanceof Error ? err.message : String(err));
      return false;
    }
  },

  undo: async () => {
    const { activeGraphId, graphHash, undoStack, mutating } = get();
    if (!activeGraphId || !graphHash || undoStack.length === 0 || mutating) return;
    const entry = undoStack[undoStack.length - 1]!;
    set({ mutating: true });
    try {
      const res = await postGraphOps(activeGraphId, {
        baseHash: graphHash,
        ops: entry.inverse,
        source: "manual",
        title: `撤销：${entry.label}`
      });
      set((state) => ({
        graph: res.graph,
        graphHash: res.hash,
        warnings: res.warnings,
        lastError: null,
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [
          ...state.redoStack.slice(-49),
          {
            label: entry.label,
            inverse: entry.inverse,
            forward: res.inverse
          }
        ],
        mutating: false
      }));
      void get().refreshPatches();
      get().showToast("info", `已撤销：${entry.label}`);
    } catch (err) {
      set({ mutating: false });
      if (err instanceof ApiRequestError && err.code === "STALE_BASE") {
        void get().refreshActiveGraph();
      }
      get().showToast("error", err instanceof Error ? err.message : "撤销失败");
    }
  },

  redo: async () => {
    const { activeGraphId, graphHash, redoStack, mutating } = get();
    if (!activeGraphId || !graphHash || redoStack.length === 0 || mutating) return;
    const entry = redoStack[redoStack.length - 1]!;
    set({ mutating: true });
    try {
      const res = await postGraphOps(activeGraphId, {
        baseHash: graphHash,
        ops: entry.forward,
        source: "manual",
        title: `重做：${entry.label}`
      });
      set((state) => ({
        graph: res.graph,
        graphHash: res.hash,
        warnings: res.warnings,
        lastError: null,
        redoStack: state.redoStack.slice(0, -1),
        undoStack: [
          ...state.undoStack.slice(-49),
          {
            label: entry.label,
            inverse: res.inverse,
            forward: entry.forward
          }
        ],
        mutating: false
      }));
      void get().refreshPatches();
      get().showToast("info", `已重做：${entry.label}`);
    } catch (err) {
      set({ mutating: false });
      if (err instanceof ApiRequestError && err.code === "STALE_BASE") {
        void get().refreshActiveGraph();
      }
      get().showToast("error", err instanceof Error ? err.message : "重做失败");
    }
  },

  openPatchReview: (patchId) => {
    const state = get();
    const { pendingPatches, graph } = state;
    const target = patchId
      ? pendingPatches.find((p) => p.patch.id === patchId)
      : pendingPatches[0];
    if (!target) return;
    const defaultIndices =
      target.evaluation?.defaultSelectedIndices ?? target.patch.ops.map((_, i) => i);
    const preview = graph ? patchPreviewGraph(graph, target.patch, defaultIndices) : null;
    const navigation = graph && preview
      ? revealReviewNodes(preview, reviewNodeIds(graph, preview,
          defaultIndices.map((i) => target.patch.ops[i]!)), state)
      : {};
    set({
      ...navigation,
      reviewTarget: { kind: "patch", patchId: target.patch.id },
      reviewSelectedIndices: defaultIndices,
      historyOpen: false,
      selectedNodeId: null,
      selectedEdge: null,
      confirmDeleteNodeId: null,
      view: state.view === "report" ? "workspace" : state.view
    });
  },

  openExternalReview: () => {
    const state = get();
    const { pendingExternalChange, graph } = state;
    if (!pendingExternalChange) return;
    const navigation = graph
      ? revealReviewNodes(pendingExternalChange.nextGraph,
          reviewNodeIds(graph, pendingExternalChange.nextGraph, pendingExternalChange.ops), state)
      : {};
    set({
      ...navigation,
      reviewTarget: { kind: "external" },
      reviewSelectedIndices: pendingExternalChange.ops.map((_, i) => i),
      historyOpen: false,
      selectedNodeId: null,
      selectedEdge: null,
      confirmDeleteNodeId: null,
      view: state.view === "report" ? "workspace" : state.view
    });
  },

  closeReview: () =>
    set({
      reviewTarget: null,
      reviewSelectedIndices: [],
      fitViewTarget: null
    }),

  toggleReviewOp: (index, checked) => {
    const { reviewTarget, pendingPatches, reviewSelectedIndices } = get();
    if (reviewTarget?.kind !== "patch") return;
    const item = pendingPatches.find((p) => p.patch.id === reviewTarget.patchId);
    if (!item) return;
    const nextSet = toggleOpSelection(
      item.patch.ops,
      new Set(reviewSelectedIndices),
      index,
      checked
    );
    const indices = [...nextSet].sort((a, b) => a - b);
    const state = get();
    const preview = state.graph ? patchPreviewGraph(state.graph, item.patch, indices) : null;
    const navigation = state.graph && preview
      ? revealReviewNodes(preview, reviewNodeIds(state.graph, preview,
          indices.map((i) => item.patch.ops[i]!)), state)
      : {};
    set({
      ...navigation,
      reviewSelectedIndices: indices
    });
  },

  applyActivePatch: async () => {
    const { activeGraphId, reviewTarget, reviewSelectedIndices, pendingPatches, mutating } =
      get();
    if (!activeGraphId || reviewTarget?.kind !== "patch" || mutating) return;
    const item = pendingPatches.find((p) => p.patch.id === reviewTarget.patchId);
    if (!item) return;
    if (reviewSelectedIndices.length === 0) {
      get().showToast("error", "请至少勾选一条要应用的变更操作");
      return;
    }

    set({ mutating: true });
    try {
      const res = await applyPatchApi(
        activeGraphId,
        item.patch.id,
        reviewSelectedIndices
      );
      set((state) => ({
        graph: res.graph,
        graphHash: res.hash,
        warnings: res.warnings,
        lastError: null,
        reviewTarget: null,
        reviewSelectedIndices: [],
        undoStack: [
          ...state.undoStack.slice(-49),
          {
            label: `应用提案「${item.patch.title}」`,
            inverse: res.inverse,
            forward: []
          }
        ],
        redoStack: [],
        mutating: false,
        fitViewNonce: state.fitViewNonce + 1
      }));
      await get().refreshPatches();
      if (get().historyOpen) await get().refreshHistory();
      get().showToast(
        "success",
        `已应用提案「${item.patch.title}」（${res.appliedIndices.length}/${item.patch.ops.length} 项；快照 rev-${String(res.savedRev.rev).padStart(4, "0")} 已留存）`
      );
    } catch (err) {
      set({ mutating: false });
      const msg =
        err instanceof ApiRequestError
          ? (err.diagnostics?.[0]?.message ?? err.message)
          : String(err);
      get().showToast("error", `应用提案失败：${msg}`);
    }
  },

  rejectActivePatch: async () => {
    const { activeGraphId, reviewTarget, pendingPatches, mutating } = get();
    if (!activeGraphId || reviewTarget?.kind !== "patch" || mutating) return;
    const item = pendingPatches.find((p) => p.patch.id === reviewTarget.patchId);
    if (!item) return;
    set({ mutating: true });
    try {
      await rejectPatchApi(activeGraphId, item.patch.id);
      set({ reviewTarget: null, reviewSelectedIndices: [], mutating: false });
      await get().refreshPatches();
      get().showToast("info", `已驳回提案「${item.patch.title}」并归档`);
    } catch (err) {
      set({ mutating: false });
      get().showToast("error", err instanceof Error ? err.message : "驳回失败");
    }
  },

  acceptExternalChange: async () => {
    const { activeGraphId, mutating } = get();
    if (!activeGraphId || mutating) return;
    set({ mutating: true });
    try {
      const res = await acceptExternalChangeApi(activeGraphId);
      set((state) => ({
        graph: res.graph,
        graphHash: res.hash,
        warnings: res.warnings,
        pendingExternalChange: null,
        reviewTarget: null,
        reviewSelectedIndices: [],
        mutating: false,
        fitViewNonce: state.fitViewNonce + 1
      }));
      await get().refreshPatches();
      if (get().historyOpen) await get().refreshHistory();
      get().showToast(
        "success",
        `已接受外部变更并更新基线（原版本已留存为 rev-${String(res.savedRev.rev).padStart(4, "0")}）`
      );
    } catch (err) {
      set({ mutating: false });
      get().showToast("error", err instanceof Error ? err.message : "接受外部变更失败");
    }
  },

  revertExternalChange: async () => {
    const { activeGraphId, mutating } = get();
    if (!activeGraphId || mutating) return;
    set({ mutating: true });
    try {
      const res = await revertExternalChangeApi(activeGraphId);
      set({
        graph: res.graph,
        graphHash: res.hash,
        warnings: res.warnings,
        lastError: null,
        pendingExternalChange: null,
        reviewTarget: null,
        reviewSelectedIndices: [],
        mutating: false
      });
      await get().refreshPatches();
      get().showToast("success", "已一键还原文件至上一份受控基线");
    } catch (err) {
      set({ mutating: false });
      get().showToast("error", err instanceof Error ? err.message : "还原文件失败");
    }
  },

  openHistory: async () => {
    set({
      historyOpen: true,
      reviewTarget: null,
      reviewSelectedIndices: [],
      selectedEdge: null
    });
    await get().refreshHistory();
  },

  closeHistory: () => set({ historyOpen: false }),

  createCheckpoint: async (title) => {
    const { activeGraphId, mutating } = get();
    if (!activeGraphId || mutating) return;
    set({ mutating: true });
    try {
      const res = await createCheckpointApi(activeGraphId, title);
      set({ mutating: false });
      await get().refreshHistory();
      get().showToast(
        "success",
        `已保存还原点 rev-${String(res.entry.rev).padStart(4, "0")}`
      );
    } catch (err) {
      set({ mutating: false });
      get().showToast("error", err instanceof Error ? err.message : "保存还原点失败");
    }
  },

  rollbackToRev: async (rev) => {
    const { activeGraphId, mutating } = get();
    if (!activeGraphId || mutating) return;
    set({ mutating: true });
    try {
      const res = await rollbackGraphApi(activeGraphId, rev);
      set((state) => ({
        graph: res.graph,
        graphHash: res.hash,
        warnings: res.warnings,
        lastError: null,
        undoStack: [],
        redoStack: [],
        selectedNodeId: null,
        selectedEdge: null,
        mutating: false,
        fitViewNonce: state.fitViewNonce + 1
      }));
      await Promise.all([get().refreshHistory(), get().refreshPatches()]);
      get().showToast(
        "success",
        `已回退至 rev-${String(rev).padStart(4, "0")}（回退前状态已留存为 rev-${String(
          res.savedRev.rev
        ).padStart(4, "0")}，可随时反向回退）`
      );
    } catch (err) {
      set({ mutating: false });
      get().showToast("error", err instanceof Error ? err.message : "版本回退失败");
    }
  },

  setView: (view) =>
    set((state) => {
      return {
        view,
        drillRoot: null,
        reviewTarget: view === "report" ? null : state.reviewTarget,
        historyOpen: view === "report" ? false : state.historyOpen,
        selectedEdge: view === "report" ? null : state.selectedEdge,
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

  selectNode: (nodeId) =>
    set({
      selectedNodeId: nodeId,
      selectedEdge: nodeId ? null : get().selectedEdge,
      confirmDeleteNodeId: null
    }),

  selectEdge: (edge) =>
    set({
      selectedEdge: edge,
      selectedNodeId: edge ? null : get().selectedNodeId,
      confirmDeleteNodeId: null
    }),

  setHoveredNode: (nodeId) => set({ hoveredNodeId: nodeId }),

  jumpToNode: (nodeId) =>
    set((state) => {
      if (!state.graph) return { selectedNodeId: nodeId };
      let preview = state.graph;
      if (state.reviewTarget?.kind === "external" && state.pendingExternalChange) {
        preview = state.pendingExternalChange.nextGraph;
      } else if (state.reviewTarget?.kind === "patch") {
        const patchId = state.reviewTarget.patchId;
        const item = state.pendingPatches.find((p) => p.patch.id === patchId);
        if (item) preview = patchPreviewGraph(state.graph, item.patch, state.reviewSelectedIndices);
      }
      const ids = resolveReviewNodeIds(state.graph, preview, [nodeId]);
      if (ids.length === 0) return {};
      return {
        ...revealReviewNodes(preview, ids, state),
        selectedNodeId: ids[0]!,
        selectedEdge: null,
        confirmDeleteNodeId: null
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
