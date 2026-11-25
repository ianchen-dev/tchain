import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { deriveGraph, type Diagnostic, type Status } from "@tchain/core";
import { CommandPalette } from "./components/CommandPalette.js";
import { HistoryDrawer } from "./components/HistoryDrawer.js";
import { InspectorDrawer } from "./components/InspectorDrawer.js";
import { PatchReviewDrawer } from "./components/PatchReviewDrawer.js";
import { TopBar } from "./components/TopBar.js";
import { WorkbenchCanvas } from "./components/WorkbenchCanvas.js";
import { STATUS_META } from "./components/statusMeta.js";
import { useWorkbenchStore } from "./store.js";

const DIGIT_STATUS_MAP: Record<string, Status> = {
  "1": "todo",
  "2": "active",
  "3": "blocked",
  "4": "done",
  "5": "parked",
  "6": "discarded"
};

export function App() {
  const bootstrap = useWorkbenchStore((s) => s.bootstrap);
  const refreshActiveGraph = useWorkbenchStore((s) => s.refreshActiveGraph);
  const refreshPatches = useWorkbenchStore((s) => s.refreshPatches);
  const setSseStatus = useWorkbenchStore((s) => s.setSseStatus);
  const setLastError = useWorkbenchStore((s) => s.setLastError);
  const clearToast = useWorkbenchStore((s) => s.clearToast);
  const loading = useWorkbenchStore((s) => s.loading);
  const loadError = useWorkbenchStore((s) => s.loadError);
  const graph = useWorkbenchStore((s) => s.graph);
  const view = useWorkbenchStore((s) => s.view);
  const toast = useWorkbenchStore((s) => s.toast);

  // Initial workspace load
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Live SSE subscription (PRD §7.6 / §8.1)
  useEffect(() => {
    const es = new EventSource("/api/events");
    setSseStatus("connecting");

    es.addEventListener("hello", () => {
      setSseStatus("connected");
    });

    es.addEventListener("graph:updated", () => {
      void refreshActiveGraph();
    });

    es.addEventListener("graph:removed", () => {
      void refreshActiveGraph();
    });

    es.addEventListener("patches:updated", () => {
      void refreshPatches();
    });

    es.addEventListener("external:changed", () => {
      void refreshActiveGraph();
    });

    es.addEventListener("external:resolved", () => {
      void refreshActiveGraph();
    });

    es.addEventListener("graph:error", (ev: MessageEvent) => {
      try {
        const data = JSON.parse(String(ev.data)) as {
          graphId: string;
          message: string;
          errors: Diagnostic[];
          at: string;
        };
        const activeId = useWorkbenchStore.getState().activeGraphId;
        if (!activeId || data.graphId === activeId) {
          setLastError({
            message: data.message,
            errors: data.errors,
            at: data.at
          });
        }
      } catch {
        // ignore malformed event
      }
    });

    es.onopen = () => {
      setSseStatus("connected");
    };

    es.onerror = () => {
      setSseStatus("reconnecting");
    };

    return () => {
      es.close();
    };
  }, [refreshActiveGraph, refreshPatches, setSseStatus, setLastError]);

  // Global desktop keyboard shortcuts (PRD §6.6: Ctrl+K, Esc, F, Ctrl+Z/Shift+Z, 1-6, Delete)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const st = useWorkbenchStore.getState();
        st.setCommandPaletteOpen(!st.commandPaletteOpen);
        return;
      }

      if (e.key === "Escape") {
        const st = useWorkbenchStore.getState();
        if (st.commandPaletteOpen) {
          st.setCommandPaletteOpen(false);
        } else if (st.previewIndex >= 0) {
          st.closePreviewDoc();
        } else if (st.reviewTarget) {
          st.closeReview();
        } else if (st.historyOpen) {
          st.closeHistory();
        } else if (st.selectedEdge) {
          st.selectEdge(null);
        } else if (st.drillRoot) {
          st.popDrill();
        } else if (st.selectedNodeId) {
          st.selectNode(null);
        }
        return;
      }

      if (inInput) return;

      const st = useWorkbenchStore.getState();
      const canEdit = st.view !== "report" && st.reviewTarget === null;

      // Undo / Redo (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y)
      if (canEdit && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) void st.redo();
        else void st.undo();
        return;
      }
      if (canEdit && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        void st.redo();
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        st.triggerFitView();
        return;
      }

      // 1-6 quick status switch on selected node (PRD §6.6)
      if (canEdit && st.selectedNodeId && e.key in DIGIT_STATUS_MAP) {
        e.preventDefault();
        const nextStatus = DIGIT_STATUS_MAP[e.key]!;
        const nodeId = st.selectedNodeId;
        void st
          .submitOps([{ op: "update_node", id: nodeId, set: { status: nextStatus } }], {
            label: `${nodeId} 状态 → ${STATUS_META[nextStatus].shortLabel}`
          })
          .then((ok) => {
            if (
              ok &&
              (nextStatus === "blocked" ||
                nextStatus === "parked" ||
                nextStatus === "discarded")
            ) {
              useWorkbenchStore.getState().requestFocusStatusNote();
            }
          });
        return;
      }

      // Delete selected edge or node (NEVER Backspace, per PRD §6.6)
      if (canEdit && e.key === "Delete") {
        if (st.selectedEdge) {
          e.preventDefault();
          const { source, target: tgt } = st.selectedEdge;
          void st.submitOps([{ op: "remove_edge", source, target: tgt }], {
            label: `已删除连线 ${source} → ${tgt}`
          });
          return;
        }
        if (st.selectedNodeId && st.graph) {
          e.preventDefault();
          const derived = deriveGraph(st.graph);
          if (derived.isContainer.has(st.selectedNodeId)) {
            st.setConfirmDeleteNodeId(st.selectedNodeId);
          } else {
            const nid = st.selectedNodeId;
            void st.submitOps([{ op: "remove_node", id: nid, cascade: false }], {
              label: `已删除节点 ${nid}`
            });
          }
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className={`tc-app ${view === "report" ? "tc-mode-report" : ""}`}>
      <TopBar />

      <main className="tc-main">
        {loading && !graph ? (
          <div className="tc-empty-state">正在加载本地思维链图谱…</div>
        ) : loadError && !graph ? (
          <div className="tc-empty-state tc-empty-err">
            <h2>无法加载工作区</h2>
            <p>{loadError}</p>
          </div>
        ) : !graph ? (
          <div className="tc-empty-state">
            <h2>当前工作区暂无图谱</h2>
            <p>
              请在 <code>.thoughtchain/graphs/</code> 目录下创建 <code>*.tgraph.json</code>{" "}
              文件，工作台将自动热刷新。
            </p>
          </div>
        ) : (
          <ReactFlowProvider>
            <WorkbenchCanvas />
          </ReactFlowProvider>
        )}

        <PatchReviewDrawer />
        <HistoryDrawer />
        <InspectorDrawer />
      </main>

      {toast && (
        <div
          className={`tc-toast tc-toast-${toast.kind}`}
          role="status"
          onClick={clearToast}
        >
          <div className="tc-toast-msg">{toast.message}</div>
          {toast.hint && <div className="tc-toast-hint">{toast.hint}</div>}
        </div>
      )}

      <CommandPalette />
    </div>
  );
}
