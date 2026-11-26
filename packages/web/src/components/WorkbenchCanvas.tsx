import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  getNodesBounds,
  getViewportForBounds,
  useReactFlow,
  useStore,
  type Connection,
  type Edge as RfEdge,
  type Node as RfNode
} from "@xyflow/react";
import {
  applySelectedPatchOps,
  computePatchPreviewHighlights,
  edgeKey,
  projectGraph,
  type EdgeKind,
  type Graph,
  type PatchPreviewHighlights,
  type RenderEdge,
  type RenderGraph
} from "@tchain/core";
import { GitPullRequest, Info, Trash2, X } from "lucide-react";
import { runElkLayout, type LayoutResult } from "../layout/layoutClient.js";
import { useWorkbenchStore } from "../store.js";
import { CapsuleNode } from "./CapsuleNode.js";
import { ContainerNode } from "./ContainerNode.js";
import { ElkEdge } from "./ElkEdge.js";
import { ExternalStubNode } from "./ExternalStubNode.js";
import { ThoughtNode } from "./ThoughtNode.js";

const nodeTypes = {
  thought: ThoughtNode,
  container: ContainerNode,
  stub: ExternalStubNode,
  capsule: CapsuleNode
};

const edgeTypes = {
  elk: ElkEdge
};

const EDGE_KIND_OPTIONS: Array<{ id: EdgeKind; label: string }> = [
  { id: "flow", label: "主推进 (flow)" },
  { id: "depends_on", label: "前置依赖 (depends_on)" },
  { id: "revises", label: "回流修正 (revises)" }
];

export function WorkbenchCanvas() {
  const graph = useWorkbenchStore((s) => s.graph);
  const view = useWorkbenchStore((s) => s.view);
  const drillRoot = useWorkbenchStore((s) => s.drillRoot);
  const collapsed = useWorkbenchStore((s) => s.collapsedByView[s.view]);
  const showDiscarded = useWorkbenchStore((s) => s.showDiscarded);
  const showParked = useWorkbenchStore((s) => s.showParked);
  const focusHideDimmed = useWorkbenchStore((s) => s.focusHideDimmed);
  const dimCrossHierarchyEdges = useWorkbenchStore((s) => s.dimCrossHierarchyEdges);

  const reviewTarget = useWorkbenchStore((s) => s.reviewTarget);
  const pendingPatches = useWorkbenchStore((s) => s.pendingPatches);
  const pendingExternalChange = useWorkbenchStore((s) => s.pendingExternalChange);
  const reviewSelectedIndices = useWorkbenchStore((s) => s.reviewSelectedIndices);

  const selectedNodeId = useWorkbenchStore((s) => s.selectedNodeId);
  const selectedEdge = useWorkbenchStore((s) => s.selectedEdge);
  const hoveredNodeId = useWorkbenchStore((s) => s.hoveredNodeId);
  const fitViewNonce = useWorkbenchStore((s) => s.fitViewNonce);
  const fitViewTarget = useWorkbenchStore((s) => s.fitViewTarget);
  const mutating = useWorkbenchStore((s) => s.mutating);

  const selectNode = useWorkbenchStore((s) => s.selectNode);
  const selectEdge = useWorkbenchStore((s) => s.selectEdge);
  const setHoveredNode = useWorkbenchStore((s) => s.setHoveredNode);
  const toggleCollapse = useWorkbenchStore((s) => s.toggleCollapse);
  const drillInto = useWorkbenchStore((s) => s.drillInto);
  const jumpToNode = useWorkbenchStore((s) => s.jumpToNode);
  const openPreviewDoc = useWorkbenchStore((s) => s.openPreviewDoc);
  const setShowDiscarded = useWorkbenchStore((s) => s.setShowDiscarded);
  const setShowParked = useWorkbenchStore((s) => s.setShowParked);
  const setLayoutStats = useWorkbenchStore((s) => s.setLayoutStats);
  const submitOps = useWorkbenchStore((s) => s.submitOps);

  const reactFlow = useReactFlow();
  const viewportWidth = useStore((s) => s.width);
  const viewportHeight = useStore((s) => s.height);
  const [layoutResult, setLayoutResult] = useState<LayoutResult | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const latestReqRef = useRef(0);

  const canEdit = view !== "report" && reviewTarget === null;

  // Compute effective preview graph & diff highlights when in Review Mode (PRD §7.6)
  const { displayGraph, previewHighlights, reviewLabel } = useMemo<{
    displayGraph: Graph | null;
    previewHighlights: PatchPreviewHighlights | null;
    reviewLabel: string | null;
  }>(() => {
    if (!graph) {
      return { displayGraph: null, previewHighlights: null, reviewLabel: null };
    }
    if (!reviewTarget) {
      return { displayGraph: graph, previewHighlights: null, reviewLabel: null };
    }

    if (reviewTarget.kind === "external" && pendingExternalChange) {
      const highlights = computePatchPreviewHighlights(
        graph,
        pendingExternalChange.nextGraph,
        pendingExternalChange.ops
      );
      return {
        displayGraph: pendingExternalChange.nextGraph,
        previewHighlights: highlights,
        reviewLabel: `正在预览外部修改（${pendingExternalChange.file}）`
      };
    }

    if (reviewTarget.kind === "patch") {
      const item = pendingPatches.find((p) => p.patch.id === reviewTarget.patchId);
      if (item) {
        if (reviewSelectedIndices.length === 0) {
          return {
            displayGraph: graph,
            previewHighlights: null,
            reviewLabel: `正在审查 AI 提案「${item.patch.title}」（未勾选任何变更）`
          };
        }
        try {
          const applied = applySelectedPatchOps(graph, item.patch, reviewSelectedIndices);
          const selectedOps = reviewSelectedIndices.map((i) => item.patch.ops[i]!);
          const highlights = computePatchPreviewHighlights(graph, applied.graph, selectedOps);
          return {
            displayGraph: applied.graph,
            previewHighlights: highlights,
            reviewLabel: `正在预览 AI 提案「${item.patch.title}」（绿色虚线 = 新增，琥珀光晕 = 修改）`
          };
        } catch {
          return {
            displayGraph: graph,
            previewHighlights: null,
            reviewLabel: `正在审查 AI 提案「${item.patch.title}」（当前勾选存在校验错误）`
          };
        }
      }
    }

    return { displayGraph: graph, previewHighlights: null, reviewLabel: null };
  }, [graph, reviewTarget, pendingPatches, pendingExternalChange, reviewSelectedIndices]);

  const renderGraph: RenderGraph | null = useMemo(() => {
    if (!displayGraph) return null;
    return projectGraph(displayGraph, {
      view,
      drillRoot,
      collapsed,
      showDiscarded,
      showParked,
      focusHideDimmed
    });
  }, [displayGraph, view, drillRoot, collapsed, showDiscarded, showParked, focusHideDimmed]);

  useEffect(() => {
    if (!renderGraph) {
      setLayoutResult(null);
      return;
    }

    const reqId = ++latestReqRef.current;
    let cancelled = false;

    runElkLayout(renderGraph)
      .then(({ result, cacheHit }) => {
        if (cancelled || reqId !== latestReqRef.current) return;
        setLayoutResult(result);
        setLayoutError(null);
        setLayoutStats(result.durationMs, cacheHit);
      })
      .catch((err) => {
        if (cancelled || reqId !== latestReqRef.current) return;
        setLayoutError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [renderGraph, setLayoutStats]);

  const prevFitTriggerRef = useRef<string>("");
  useEffect(() => {
    // Never consume a focus request using coordinates from the previous projection.
    if (
      !layoutResult || layoutResult.renderHash !== renderGraph?.renderHash ||
      !viewportWidth || !viewportHeight || !reactFlow.viewportInitialized
    ) return;
    const targetIds = fitViewTarget?.nonce === fitViewNonce ? fitViewTarget.nodeIds : null;
    const key = JSON.stringify([
      renderGraph.graphId, view, drillRoot, fitViewNonce, targetIds,
      targetIds ? [layoutResult.renderHash, viewportWidth, viewportHeight] : null
    ]);
    if (prevFitTriggerRef.current === key) return;
    const targets = targetIds ? new Set(targetIds) : null;
    const focusedNodes = layoutResult.nodes.filter((node) => !targets || targets.has(node.id));
    const nodes = focusedNodes.length > 0 ? focusedNodes : layoutResult.nodes;
    if (nodes.length === 0) return;
    // ELK already provides absolute positions and dimensions. Using these directly
    // avoids racing React Flow's asynchronous internal node/measurement updates.
    const bounds = getNodesBounds(nodes.map((node) => ({
      id: node.id, position: { x: node.x, y: node.y },
      width: node.width, height: node.height, data: {}
    })));
    let cancelled = false;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const viewport = getViewportForBounds(bounds, viewportWidth, viewportHeight,
          0.05, targetIds ? 1 : 2, targetIds ? 0.2 : view === "report" ? 0.14 : 0.12);
        void reactFlow.setViewport(viewport, { duration: 220 }).then((applied) => {
          if (applied && !cancelled) prevFitTriggerRef.current = key;
        });
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [layoutResult, renderGraph, view, drillRoot, fitViewNonce, fitViewTarget,
    viewportWidth, viewportHeight, reactFlow]);

  const handleOpenFirstAttachment = useCallback(
    (nodeId: string) => {
      selectNode(nodeId);
      const node = displayGraph?.nodes.find((n) => n.id === nodeId);
      const firstLocal = node?.attachments?.find((a) => a.path);
      if (firstLocal?.path) {
        openPreviewDoc({ path: firstLocal.path, title: firstLocal.title });
      }
    },
    [displayGraph, selectNode, openPreviewDoc]
  );

  const handleRevealBucket = useCallback(
    (bucket: "discarded" | "parked") => {
      if (bucket === "discarded") setShowDiscarded(true);
      else setShowParked(true);
    },
    [setShowDiscarded, setShowParked]
  );

  // Handle-to-handle semantic edge creation (PRD §6.6)
  const handleConnect = useCallback(
    (conn: Connection) => {
      if (!canEdit || !conn.source || !conn.target || conn.source === conn.target) return;
      void submitOps(
        [
          {
            op: "add_edge",
            source: conn.source,
            target: conn.target,
            kind: "flow"
          }
        ],
        { label: `已新增连线 ${conn.source} → ${conn.target}` }
      );
    },
    [canEdit, submitOps]
  );

  const activeFocusTarget = hoveredNodeId ?? selectedNodeId;

  const rfNodes: RfNode[] = useMemo(() => {
    if (!layoutResult) return [];
    return layoutResult.nodes.map((pn) => {
      const diffState = previewHighlights?.addedNodeIds.has(pn.id)
        ? ("added" as const)
        : previewHighlights?.modifiedNodeIds.has(pn.id)
          ? ("modified" as const)
          : undefined;
      const statusTransition = previewHighlights?.nodeStatusTransitions.get(pn.id);
      const fieldChanges = previewHighlights?.nodeFieldChanges.get(pn.id);
      const diffTooltip =
        fieldChanges && fieldChanges.length > 0
          ? fieldChanges.map((c) => `${c.field}: ${c.before} → ${c.after}`).join("\n")
          : undefined;

      if (pn.kind === "container" && pn.renderNode) {
        return {
          id: pn.id,
          type: "container",
          position: { x: pn.x, y: pn.y },
          width: pn.width,
          height: pn.height,
          style: { width: pn.width, height: pn.height },
          zIndex: pn.zIndex,
          selected: selectedNodeId === pn.id,
          draggable: false,
          selectable: true,
          data: {
            renderNode: pn.renderNode,
            view,
            connectable: canEdit,
            diffState,
            statusTransition,
            diffTooltip,
            onToggleCollapse: toggleCollapse,
            onDrillInto: drillInto,
            onOpenFirstAttachment: handleOpenFirstAttachment
          }
        };
      }
      if (pn.kind === "stub" && pn.stub) {
        return {
          id: pn.id,
          type: "stub",
          position: { x: pn.x, y: pn.y },
          width: pn.width,
          height: pn.height,
          style: { width: pn.width, height: pn.height },
          zIndex: pn.zIndex,
          draggable: false,
          selectable: false,
          data: {
            stub: pn.stub,
            onJumpToNode: jumpToNode
          }
        };
      }
      if (pn.kind === "capsule" && pn.capsule) {
        return {
          id: pn.id,
          type: "capsule",
          position: { x: pn.x, y: pn.y },
          width: pn.width,
          height: pn.height,
          style: { width: pn.width, height: pn.height },
          zIndex: pn.zIndex,
          draggable: false,
          selectable: false,
          data: {
            capsule: pn.capsule,
            onRevealBucket: handleRevealBucket
          }
        };
      }
      return {
        id: pn.id,
        type: "thought",
        position: { x: pn.x, y: pn.y },
        width: pn.width,
        height: pn.height,
        style: { width: pn.width, height: pn.height },
        zIndex: pn.zIndex,
        selected: selectedNodeId === pn.id,
        draggable: false,
        selectable: true,
        data: {
          renderNode: pn.renderNode!,
          view,
          selected: selectedNodeId === pn.id,
          connectable: canEdit,
          diffState,
          statusTransition,
          diffTooltip,
          onToggleCollapse: toggleCollapse,
          onDrillInto: drillInto,
          onOpenFirstAttachment: handleOpenFirstAttachment
        }
      };
    });
  }, [
    layoutResult,
    selectedNodeId,
    view,
    canEdit,
    previewHighlights,
    toggleCollapse,
    drillInto,
    handleOpenFirstAttachment,
    jumpToNode,
    handleRevealBucket
  ]);

  const rfEdges: RfEdge[] = useMemo(() => {
    if (!layoutResult || !renderGraph) return [];
    const nodeDimMap = new Map(renderGraph.nodes.map((n) => [n.id, n.dimmed]));

    return layoutResult.edges.map((pe) => {
      const re = pe.edge;
      const connectedToActive =
        activeFocusTarget !== null &&
        (re.source === activeFocusTarget || re.target === activeFocusTarget);

      const isSelected =
        selectedEdge !== null &&
        re.originalEdges.some(
          (oe) => oe.source === selectedEdge.source && oe.target === selectedEdge.target
        );

      const diffAdded =
        previewHighlights !== null &&
        re.originalEdges.some((oe) =>
          previewHighlights.addedEdgeKeys.has(edgeKey(oe.source, oe.target))
        );

      const endpointDimmed =
        view === "focus" &&
        (nodeDimMap.get(re.source) === true || nodeDimMap.get(re.target) === true);

      const crossLayerDimmed =
        dimCrossHierarchyEdges && re.isCrossHierarchy && !connectedToActive && !isSelected;

      return {
        id: pe.id,
        source: re.source,
        target: re.target,
        type: "elk",
        zIndex: isSelected || connectedToActive || diffAdded ? 150 : 50,
        data: {
          renderEdge: re,
          points: pe.points,
          highlighted: connectedToActive,
          selected: isSelected,
          diffAdded,
          clickable: canEdit && !re.isCapsuleEdge && re.originalEdges.length > 0,
          dimmed: endpointDimmed || crossLayerDimmed
        }
      };
    });
  }, [
    layoutResult,
    renderGraph,
    activeFocusTarget,
    selectedEdge,
    previewHighlights,
    view,
    canEdit,
    dimCrossHierarchyEdges
  ]);

  return (
    <div className={`tc-canvas-shell ${view === "report" ? "tc-canvas-report" : ""}`}>
      {/* SVG Arrowhead marker defs shared by all ElkEdge instances */}
      <svg className="tc-svg-defs" aria-hidden="true">
        <defs>
          <marker
            id="tc-arrow-default"
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 1 1.5 L 9 5 L 1 8.5 z" fill="#64748b" />
          </marker>
          <marker
            id="tc-arrow-highlight"
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="7.5"
            markerHeight="7.5"
            orient="auto-start-reverse"
          >
            <path d="M 1 1.5 L 9 5 L 1 8.5 z" fill="#2563eb" />
          </marker>
          <marker
            id="tc-arrow-added"
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="7.5"
            markerHeight="7.5"
            orient="auto-start-reverse"
          >
            <path d="M 1 1.5 L 9 5 L 1 8.5 z" fill="#10b981" />
          </marker>
          <marker
            id="tc-arrow-revises"
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="7.5"
            markerHeight="7.5"
            orient="auto-start-reverse"
          >
            <path d="M 1 1.5 L 9 5 L 1 8.5 z" fill="#d97706" />
          </marker>
          <marker
            id="tc-arrow-muted"
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="6.5"
            markerHeight="6.5"
            orient="auto-start-reverse"
          >
            <path d="M 1 1.5 L 9 5 L 1 8.5 z" fill="#94a3b8" />
          </marker>
        </defs>
      </svg>

      {reviewLabel && (
        <div className="tc-canvas-notice tc-canvas-notice-review">
          <GitPullRequest size={14} />
          <span>{reviewLabel}</span>
        </div>
      )}

      {!reviewLabel && selectedEdge && canEdit && (
        <div className="tc-edge-toolbar" role="toolbar" aria-label="编辑选中连线">
          <span className="tc-edge-toolbar-label">
            连线 <code>{selectedEdge.source}</code> → <code>{selectedEdge.target}</code>
          </span>
          <div className="tc-edge-kind-group">
            {EDGE_KIND_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                disabled={mutating}
                className={`tc-tool-btn tc-tool-sm ${
                  selectedEdge.kind === opt.id ? "tc-tool-active" : ""
                }`}
                onClick={() => {
                  void submitOps(
                    [
                      {
                        op: "add_edge",
                        source: selectedEdge.source,
                        target: selectedEdge.target,
                        kind: opt.id
                      }
                    ],
                    { label: `连线类型已切换为 ${opt.id}` }
                  ).then((ok) => {
                    if (ok) selectEdge({ ...selectedEdge, kind: opt.id });
                  });
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={mutating}
            className="tc-tool-btn tc-tool-sm tc-tool-danger"
            title="删除该连线 (Delete)"
            onClick={() => {
              void submitOps(
                [
                  {
                    op: "remove_edge",
                    source: selectedEdge.source,
                    target: selectedEdge.target
                  }
                ],
                { label: `已删除连线 ${selectedEdge.source} → ${selectedEdge.target}` }
              );
            }}
          >
            <Trash2 size={13} />
            <span>删除</span>
          </button>
          <button
            type="button"
            className="tc-icon-btn"
            title="取消选中"
            onClick={() => selectEdge(null)}
          >
            <X size={13} />
          </button>
        </div>
      )}

      {!reviewLabel && !selectedEdge && view === "focus" && renderGraph?.focus.isFallback && (
        <div className="tc-canvas-notice">
          <Info size={14} />
          <span>
            {renderGraph.focus.message ?? "当前没有进行中的节点"} — 已展示就绪前沿与阻塞节点
          </span>
        </div>
      )}

      {layoutError && (
        <div className="tc-canvas-notice tc-canvas-notice-err">
          布局计算失败：{layoutError}
        </div>
      )}

      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={canEdit}
        elementsSelectable={true}
        panOnScroll={false}
        zoomOnDoubleClick={false}
        minZoom={0.05}
        maxZoom={2.0}
        onConnect={handleConnect}
        onNodeClick={(_, node) => {
          if (node.type === "thought" || node.type === "container") {
            selectNode(node.id);
          }
        }}
        onEdgeClick={(_, edge) => {
          if (!canEdit) return;
          const re = (edge.data as { renderEdge?: RenderEdge } | undefined)?.renderEdge;
          const first = re?.originalEdges[0];
          if (first) {
            selectEdge({
              source: first.source,
              target: first.target,
              kind: first.kind ?? "flow"
            });
          }
        }}
        onNodeMouseEnter={(_, node) => {
          if (node.type === "thought" || node.type === "container") {
            setHoveredNode(node.id);
          }
        }}
        onNodeMouseLeave={() => setHoveredNode(null)}
        onPaneClick={() => {
          selectNode(null);
          selectEdge(null);
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={view === "report" ? 28 : 20}
          size={1.2}
          color={view === "report" ? "#e2e8f0" : "#cbd5e1"}
        />
        <Controls showInteractive={false} position="bottom-left" />
        {view !== "report" && (
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            nodeStrokeWidth={2}
            nodeColor={(n) => {
              if (n.type === "container") return "#e2e8f0";
              if (n.type === "stub") return "#bfdbfe";
              if (n.type === "capsule") return "#cbd5e1";
              return "#94a3b8";
            }}
          />
        )}
      </ReactFlow>
    </div>
  );
}
