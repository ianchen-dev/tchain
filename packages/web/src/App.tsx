import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { CommandPalette } from "./components/CommandPalette.js";
import { InspectorDrawer } from "./components/InspectorDrawer.js";
import { TopBar } from "./components/TopBar.js";
import { WorkbenchCanvas } from "./components/WorkbenchCanvas.js";
import { useWorkbenchStore } from "./store.js";
import type { Diagnostic } from "@tchain/core";

export function App() {
  const bootstrap = useWorkbenchStore((s) => s.bootstrap);
  const refreshActiveGraph = useWorkbenchStore((s) => s.refreshActiveGraph);
  const setSseStatus = useWorkbenchStore((s) => s.setSseStatus);
  const setLastError = useWorkbenchStore((s) => s.setLastError);
  const loading = useWorkbenchStore((s) => s.loading);
  const loadError = useWorkbenchStore((s) => s.loadError);
  const graph = useWorkbenchStore((s) => s.graph);
  const view = useWorkbenchStore((s) => s.view);

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
  }, [refreshActiveGraph, setSseStatus, setLastError]);

  // Global desktop keyboard shortcuts (Ctrl/Cmd+K, Esc, F)
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
        } else if (st.drillRoot) {
          st.popDrill();
        } else if (st.selectedNodeId) {
          st.selectNode(null);
        }
        return;
      }

      if (!inInput && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        useWorkbenchStore.getState().triggerFitView();
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

        <InspectorDrawer />
      </main>

      <CommandPalette />
    </div>
  );
}
