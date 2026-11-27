import { useMemo, useState } from "react";
import { projectGraph, type OpSummaryCounts, type ViewMode } from "@tchain/core";
import {
  AlertOctagon,
  Ban,
  ChevronRight,
  Crosshair,
  Eye,
  EyeOff,
  ChevronsUpDown,
  FileWarning,
  GitBranch,
  GitPullRequest,
  History,
  Layers,
  Maximize,
  Maximize2,
  Minimize,
  PauseCircle,
  Presentation,
  Redo2,
  RotateCcw,
  Search,
  Sparkles,
  Undo2,
  X
} from "lucide-react";
import { useWorkbenchStore } from "../store.js";
import { ActivityReportMenu } from "./ActivityReportMenu.js";

const VIEW_OPTIONS: Array<{ id: ViewMode; label: string; icon: typeof Layers }> = [
  { id: "workspace", label: "工作态", icon: Layers },
  { id: "focus", label: "焦点态", icon: Crosshair },
  { id: "report", label: "汇报态", icon: Presentation }
];

function formatSummaryBadges(s?: OpSummaryCounts): string {
  if (!s) return "";
  const parts: string[] = [];
  if (s.addedNodes > 0) parts.push(`+${s.addedNodes} 节点`);
  if (s.removedNodes > 0) parts.push(`-${s.removedNodes} 节点`);
  if (s.statusChanges > 0) parts.push(`${s.statusChanges} 状态变更`);
  if (s.updatedNodes > s.statusChanges) {
    parts.push(`${s.updatedNodes - s.statusChanges} 内容修改`);
  }
  if (s.addedAttachments > 0) parts.push(`+${s.addedAttachments} 文档挂载`);
  if (s.addedEdges > 0) parts.push(`+${s.addedEdges} 连线`);
  if (s.removedEdges > 0) parts.push(`-${s.removedEdges} 连线`);
  return parts.length > 0 ? parts.join(" / ") : `${s.totalOps} 项操作`;
}

export function TopBar() {
  const graphs = useWorkbenchStore((s) => s.graphs);
  const activeGraphId = useWorkbenchStore((s) => s.activeGraphId);
  const graph = useWorkbenchStore((s) => s.graph);
  const lastError = useWorkbenchStore((s) => s.lastError);
  const warnings = useWorkbenchStore((s) => s.warnings);
  const view = useWorkbenchStore((s) => s.view);
  const drillRoot = useWorkbenchStore((s) => s.drillRoot);
  const collapsed = useWorkbenchStore((s) => s.collapsedByView[s.view]);
  const showDiscarded = useWorkbenchStore((s) => s.showDiscarded);
  const showParked = useWorkbenchStore((s) => s.showParked);
  const focusHideDimmed = useWorkbenchStore((s) => s.focusHideDimmed);
  const dimCrossHierarchyEdges = useWorkbenchStore((s) => s.dimCrossHierarchyEdges);
  const sseStatus = useWorkbenchStore((s) => s.sseStatus);
  const lastLayoutMs = useWorkbenchStore((s) => s.lastLayoutMs);
  const lastLayoutCacheHit = useWorkbenchStore((s) => s.lastLayoutCacheHit);

  const pendingPatches = useWorkbenchStore((s) => s.pendingPatches);
  const pendingExternalChange = useWorkbenchStore((s) => s.pendingExternalChange);
  const reviewTarget = useWorkbenchStore((s) => s.reviewTarget);
  const historyOpen = useWorkbenchStore((s) => s.historyOpen);
  const undoStack = useWorkbenchStore((s) => s.undoStack);
  const redoStack = useWorkbenchStore((s) => s.redoStack);
  const mutating = useWorkbenchStore((s) => s.mutating);

  const selectGraph = useWorkbenchStore((s) => s.selectGraph);
  const setView = useWorkbenchStore((s) => s.setView);
  const drillInto = useWorkbenchStore((s) => s.drillInto);
  const selectNode = useWorkbenchStore((s) => s.selectNode);
  const setShowDiscarded = useWorkbenchStore((s) => s.setShowDiscarded);
  const setShowParked = useWorkbenchStore((s) => s.setShowParked);
  const setFocusHideDimmed = useWorkbenchStore((s) => s.setFocusHideDimmed);
  const setDimCrossHierarchyEdges = useWorkbenchStore((s) => s.setDimCrossHierarchyEdges);
  const setCommandPaletteOpen = useWorkbenchStore((s) => s.setCommandPaletteOpen);
  const triggerFitView = useWorkbenchStore((s) => s.triggerFitView);
  const expandAll = useWorkbenchStore((s) => s.expandAll);
  const undo = useWorkbenchStore((s) => s.undo);
  const redo = useWorkbenchStore((s) => s.redo);
  const openPatchReview = useWorkbenchStore((s) => s.openPatchReview);
  const openExternalReview = useWorkbenchStore((s) => s.openExternalReview);
  const revertExternalChange = useWorkbenchStore((s) => s.revertExternalChange);
  const openHistory = useWorkbenchStore((s) => s.openHistory);
  const closeHistory = useWorkbenchStore((s) => s.closeHistory);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [errorExpanded, setErrorExpanded] = useState(false);

  const breadcrumbs = useMemo(() => {
    if (!graph) return [];
    return projectGraph(graph, {
      view,
      drillRoot,
      collapsed,
      showDiscarded,
      showParked,
      focusHideDimmed
    }).breadcrumbs;
  }, [graph, view, drillRoot, collapsed, showDiscarded, showParked, focusHideDimmed]);

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch {
      // Ignore fullscreen denial in restricted contexts
    }
  };

  const isReport = view === "report";
  const latestPatch = pendingPatches[0] ?? null;

  return (
    <header className={`tc-topbar-wrap ${isReport ? "tc-topbar-report" : ""}`}>
      <div className="tc-topbar">
        <div className="tc-topbar-left">
          <div className="tc-brand" title="ThoughtChain Decision Workbench">
            <span className="tc-brand-mark">
              <GitBranch size={15} />
            </span>
            <span className="tc-brand-name">tchain</span>
          </div>

          {graphs.length > 1 ? (
            <select
              className="tc-graph-select"
              aria-label="选择图谱"
              value={activeGraphId ?? ""}
              onChange={(e) => void selectGraph(e.target.value)}
            >
              {graphs.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title} ({g.id})
                </option>
              ))}
            </select>
          ) : graph ? (
            <span className="tc-graph-title-pill" title={graph.id}>
              {graph.title}
            </span>
          ) : null}
        </div>

        <div className="tc-topbar-center">
          <div className="tc-segmented" role="tablist" aria-label="视图切换">
            {VIEW_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const active = view === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`tc-seg-btn ${active ? "tc-seg-active" : ""}`}
                  onClick={() => setView(opt.id)}
                >
                  <Icon size={14} />
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="tc-topbar-right">
          <button
            type="button"
            className="tc-tool-btn"
            disabled={!graph}
            title="展开当前视图全部容器，显示已搁置/已否决分支并返回全图"
            onClick={expandAll}
          >
            <ChevronsUpDown size={14} />
            <span>全部展开</span>
          </button>

          {view === "focus" && (
            <button
              type="button"
              className={`tc-tool-btn ${focusHideDimmed ? "tc-tool-active" : ""}`}
              title="切换：降噪透明显示 vs 完全隐藏非焦点节点"
              onClick={() => setFocusHideDimmed(!focusHideDimmed)}
            >
              {focusHideDimmed ? <EyeOff size={14} /> : <Eye size={14} />}
              <span>{focusHideDimmed ? "仅焦点" : "降噪态"}</span>
            </button>
          )}

          <button
            type="button"
            className={`tc-tool-btn ${showParked ? "tc-tool-active" : ""}`}
            title={showParked ? "点击收起已搁置分支为胶囊" : "点击展开已搁置分支"}
            onClick={() => setShowParked(!showParked)}
          >
            <PauseCircle size={14} />
            <span>已搁置</span>
          </button>

          <button
            type="button"
            className={`tc-tool-btn ${showDiscarded ? "tc-tool-active" : ""}`}
            title={showDiscarded ? "点击收起已否决分支为胶囊" : "点击展开已否决分支"}
            onClick={() => setShowDiscarded(!showDiscarded)}
          >
            <Ban size={14} />
            <span>已否决</span>
          </button>

          {!isReport && (
            <button
              type="button"
              className={`tc-tool-btn ${dimCrossHierarchyEdges ? "tc-tool-active" : ""}`}
              title="跨层级边仅在选中或悬浮关联节点时高亮"
              onClick={() => setDimCrossHierarchyEdges(!dimCrossHierarchyEdges)}
            >
              <Sparkles size={14} />
              <span>跨层</span>
            </button>
          )}

          {!isReport && (
            <>
              <button
                type="button"
                className="tc-tool-btn"
                disabled={undoStack.length === 0 || mutating}
                title={
                  undoStack.length > 0
                    ? `撤销：${undoStack[undoStack.length - 1]!.label} (Ctrl+Z)`
                    : "暂无可撤销操作 (Ctrl+Z)"
                }
                onClick={() => void undo()}
              >
                <Undo2 size={14} />
              </button>

              <button
                type="button"
                className="tc-tool-btn"
                disabled={redoStack.length === 0 || mutating}
                title={
                  redoStack.length > 0
                    ? `重做：${redoStack[redoStack.length - 1]!.label} (Ctrl+Shift+Z)`
                    : "暂无可重做操作 (Ctrl+Shift+Z)"
                }
                onClick={() => void redo()}
              >
                <Redo2 size={14} />
              </button>

              <button
                type="button"
                className={`tc-tool-btn ${historyOpen ? "tc-tool-active" : ""}`}
                title="查看版本历史快照与一键回退"
                onClick={() => (historyOpen ? closeHistory() : void openHistory())}
              >
                <History size={14} />
                <span>历史</span>
              </button>

              <ActivityReportMenu />

              {pendingPatches.length > 0 && (
                <button
                  type="button"
                  className={`tc-tool-btn tc-tool-patch-badge ${
                    reviewTarget?.kind === "patch" ? "tc-tool-primary" : ""
                  }`}
                  title={`有 ${pendingPatches.length} 份待审 AI 变更提案`}
                  onClick={() => openPatchReview()}
                >
                  <GitPullRequest size={14} />
                  <span>待审 {pendingPatches.length}</span>
                </button>
              )}
            </>
          )}

          <button
            type="button"
            className="tc-tool-btn"
            title="快速搜索任意层级节点 (Ctrl/Cmd + K)"
            onClick={() => setCommandPaletteOpen(true)}
          >
            <Search size={14} />
            <kbd className="tc-kbd">⌘K</kbd>
          </button>

          <button
            type="button"
            className="tc-tool-btn"
            title="自适应画布 (F)"
            onClick={triggerFitView}
          >
            <Maximize2 size={14} />
          </button>

          {isReport && (
            <button
              type="button"
              className="tc-tool-btn tc-tool-primary"
              title="切换全屏投屏"
              onClick={() => void toggleFullscreen()}
            >
              {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
              <span>{isFullscreen ? "退出全屏" : "全屏投屏"}</span>
            </button>
          )}

          {!isReport && warnings.length > 0 && (
            <span
              className="tc-warn-pill"
              title={warnings.map((w) => `${w.code}: ${w.message}`).join("\n")}
            >
              {warnings.length} 警告
            </span>
          )}

          <span
            className={`tc-sse-pill tc-sse-${sseStatus}`}
            title={
              lastLayoutMs !== null
                ? `实时监听: ${sseStatus} | 最近布局: ${lastLayoutMs}ms${
                    lastLayoutCacheHit ? " (命中缓存)" : ""
                  }`
                : `实时监听: ${sseStatus}`
            }
          >
            <span className="tc-sse-dot" />
            {!isReport && (
              <span>
                {sseStatus === "connected"
                  ? "同步"
                  : sseStatus === "reconnecting"
                    ? "重连中"
                    : "连接中"}
              </span>
            )}
          </span>
        </div>
      </div>

      {breadcrumbs.length > 1 && (
        <div className="tc-breadcrumb-bar">
          <nav className="tc-breadcrumbs" aria-label="层级面包屑">
            {breadcrumbs.map((crumb, idx) => {
              const isLast = idx === breadcrumbs.length - 1;
              return (
                <span key={crumb.id ?? "root"} className="tc-crumb-item">
                  {idx > 0 && <ChevronRight size={13} className="tc-crumb-sep" />}
                  <button
                    type="button"
                    className={`tc-crumb-btn ${isLast ? "tc-crumb-current" : ""}`}
                    onClick={() => {
                      if (isLast && crumb.id) {
                        selectNode(crumb.id);
                      } else {
                        drillInto(crumb.id);
                      }
                    }}
                  >
                    {crumb.id ? `${crumb.id} ` : ""}
                    {crumb.title}
                  </button>
                </span>
              );
            })}
          </nav>
          <span className="tc-crumb-hint">按 Esc 返回上一层</span>
        </div>
      )}

      {/* Pending External File Edit Banner (PRD §7.6) */}
      {!isReport && pendingExternalChange && reviewTarget?.kind !== "external" && (
        <div className="tc-review-banner tc-review-banner-ext" role="status">
          <div className="tc-review-banner-text">
            <FileWarning size={15} />
            <strong>检测到外部直接修改「{pendingExternalChange.file}」</strong>
            <span>
              （{formatSummaryBadges(pendingExternalChange.summary)}
              {pendingExternalChange.metadataChanged ? " / 元数据变更" : ""}）
            </span>
          </div>
          <div className="tc-review-banner-actions">
            <button
              type="button"
              className="tc-btn tc-btn-amber tc-btn-sm"
              onClick={openExternalReview}
            >
              审查外部变更
            </button>
            <button
              type="button"
              className="tc-btn tc-btn-ghost tc-btn-sm"
              disabled={mutating}
              onClick={() => void revertExternalChange()}
            >
              <RotateCcw size={12} />
              <span>一键还原</span>
            </button>
          </div>
        </div>
      )}

      {/* Pending AI Patch Notification Banner (PRD §7.6) */}
      {!isReport && latestPatch && reviewTarget === null && (
        <div className="tc-review-banner tc-review-banner-patch" role="status">
          <div className="tc-review-banner-text">
            <GitPullRequest size={15} />
            <strong>收到 AI 变更提案「{latestPatch.patch.title}」</strong>
            <span>
              （{formatSummaryBadges(latestPatch.evaluation?.summary)}
              {latestPatch.evaluation?.hasConflicts
                ? ` · ${latestPatch.evaluation.conflictCount} 项冲突`
                : ""}
              ）
            </span>
            {pendingPatches.length > 1 && (
              <span className="tc-id-badge">共 {pendingPatches.length} 份待审</span>
            )}
          </div>
          <div className="tc-review-banner-actions">
            <button
              type="button"
              className="tc-btn tc-btn-primary tc-btn-sm"
              onClick={() => openPatchReview(latestPatch.patch.id)}
            >
              审查变更
            </button>
          </div>
        </div>
      )}

      {lastError && (
        <div className="tc-error-banner" role="alert">
          <div className="tc-error-banner-row">
            <AlertOctagon size={16} />
            <strong>图谱文件存在错误，画布已保留上一份合法版本：</strong>
            <span className="tc-error-msg">{lastError.message}</span>
            <button
              type="button"
              className="tc-error-detail-btn"
              onClick={() => setErrorExpanded((v) => !v)}
            >
              {errorExpanded ? "收起详情" : `查看 ${lastError.errors.length} 条诊断`}
            </button>
            <button
              type="button"
              className="tc-error-close-btn"
              aria-label="隐藏错误提示"
              onClick={() => setErrorExpanded(false)}
            >
              <X size={14} />
            </button>
          </div>
          {errorExpanded && (
            <ul className="tc-error-list">
              {lastError.errors.map((err, idx) => (
                <li key={idx}>
                  <code>{err.code}</code> <span>({err.path})</span>：{err.message}
                  {err.hint ? <em className="tc-error-hint"> — {err.hint}</em> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </header>
  );
}
