import { useMemo, useState } from "react";
import { projectGraph, type ViewMode } from "@tchain/core";
import {
  AlertOctagon,
  Ban,
  ChevronRight,
  Crosshair,
  Eye,
  EyeOff,
  GitBranch,
  Layers,
  Maximize,
  Maximize2,
  Minimize,
  PauseCircle,
  Presentation,
  Search,
  Sparkles,
  X
} from "lucide-react";
import { useWorkbenchStore } from "../store.js";

const VIEW_OPTIONS: Array<{ id: ViewMode; label: string; icon: typeof Layers }> = [
  { id: "workspace", label: "工作态", icon: Layers },
  { id: "focus", label: "焦点态", icon: Crosshair },
  { id: "report", label: "汇报态", icon: Presentation }
];

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
              <span>跨层降噪</span>
            </button>
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
                  ? "实时同步"
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
