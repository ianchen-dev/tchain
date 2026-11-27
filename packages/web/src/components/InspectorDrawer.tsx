import { useEffect, useMemo, useRef, useState } from "react";
import {
  compileContext,
  deriveGraph,
  type MutableNodeField,
  type NodePatchSet,
  type NodeType,
  type Status
} from "@tchain/core";
import {
  ArrowDownRight,
  ArrowUpLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Code2,
  Copy,
  ExternalLink,
  FileText,
  Info,
  Maximize2,
  Paperclip,
  Save,
  Trash2,
  X
} from "lucide-react";
import { useWorkbenchStore } from "../store.js";
import { copyTextToClipboard } from "../utils/clipboard.js";
import { formatFullLocalTime, formatRelativeTime } from "../utils/time.js";
import { MarkdownPreview } from "./MarkdownPreview.js";
import { NODE_TYPE_META, STATUS_META } from "./statusMeta.js";

const STATUS_ORDER: Array<{ id: Status; key: string }> = [
  { id: "todo", key: "1" },
  { id: "active", key: "2" },
  { id: "blocked", key: "3" },
  { id: "done", key: "4" },
  { id: "parked", key: "5" },
  { id: "discarded", key: "6" }
];

const TYPE_OPTIONS: NodeType[] = ["goal", "decision", "option", "task", "milestone"];

function buildVscodeUrl(workspaceRoot: string, posixPath: string): string {
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const full = `${root}/${posixPath.replace(/^\/+/, "")}`;
  return `${full.startsWith("/") ? "vscode://file" : "vscode://file/"}${encodeURI(full)}`;
}

export function InspectorDrawer() {
  const graph = useWorkbenchStore((s) => s.graph);
  const graphHash = useWorkbenchStore((s) => s.graphHash);
  const workspaceRoot = useWorkbenchStore((s) => s.workspaceRoot);
  const selectedNodeId = useWorkbenchStore((s) => s.selectedNodeId);
  const view = useWorkbenchStore((s) => s.view);
  const collapsed = useWorkbenchStore((s) => s.collapsedByView[s.view]);
  const previewIndex = useWorkbenchStore((s) => s.previewIndex);
  const reviewTarget = useWorkbenchStore((s) => s.reviewTarget);
  const historyOpen = useWorkbenchStore((s) => s.historyOpen);
  const mutating = useWorkbenchStore((s) => s.mutating);
  const focusStatusNoteNonce = useWorkbenchStore((s) => s.focusStatusNoteNonce);
  const confirmDeleteNodeId = useWorkbenchStore((s) => s.confirmDeleteNodeId);

  const selectNode = useWorkbenchStore((s) => s.selectNode);
  const jumpToNode = useWorkbenchStore((s) => s.jumpToNode);
  const drillInto = useWorkbenchStore((s) => s.drillInto);
  const toggleCollapse = useWorkbenchStore((s) => s.toggleCollapse);
  const openPreviewDoc = useWorkbenchStore((s) => s.openPreviewDoc);
  const submitOps = useWorkbenchStore((s) => s.submitOps);
  const showToast = useWorkbenchStore((s) => s.showToast);
  const setConfirmDeleteNodeId = useWorkbenchStore((s) => s.setConfirmDeleteNodeId);

  const derived = useMemo(() => (graph ? deriveGraph(graph) : null), [graph]);
  const node = selectedNodeId && derived ? derived.nodeMap.get(selectedNodeId) : null;
  const hasPreview = previewIndex >= 0;
  const isReport = view === "report";
  const canEdit = !isReport && reviewTarget === null;

  // Local editable form state synced with current node
  const [draftTitle, setDraftTitle] = useState("");
  const [draftType, setDraftType] = useState<NodeType>("task");
  const [draftStatusNote, setDraftStatusNote] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftConclusion, setDraftConclusion] = useState("");
  const [copiedContext, setCopiedContext] = useState(false);

  const statusNoteRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!node) return;
    setDraftTitle(node.title);
    setDraftType(node.type);
    setDraftStatusNote(node.statusNote ?? "");
    setDraftDescription(node.description ?? "");
    setDraftConclusion(node.conclusion ?? "");
    setCopiedContext(false);
  }, [node?.id, graphHash]);

  useEffect(() => {
    if (focusStatusNoteNonce > 0 && canEdit) {
      setTimeout(() => {
        statusNoteRef.current?.focus();
      }, 30);
    }
  }, [focusStatusNoteNonce, canEdit]);

  const isContainer = node && derived ? derived.isContainer.has(node.id) : false;
  const subtreeUpdatedAt =
    node && isContainer && derived ? derived.subtreeUpdatedAt.get(node.id) : undefined;

  const timestampItems = useMemo(() => {
    if (!node) return [];
    const items: Array<{ key: string; label: string; value: string }> = [];
    if (node.createdAt) {
      items.push({ key: "createdAt", label: "创建", value: node.createdAt });
    }
    if (node.updatedAt) {
      items.push({ key: "updatedAt", label: "更新", value: node.updatedAt });
    }
    if (node.statusChangedAt) {
      items.push({ key: "statusChangedAt", label: "状态变更", value: node.statusChangedAt });
    }
    if (isContainer && subtreeUpdatedAt && subtreeUpdatedAt !== node.updatedAt) {
      items.push({ key: "subtreeUpdatedAt", label: "子树更新", value: subtreeUpdatedAt });
    }
    return items;
  }, [node, isContainer, subtreeUpdatedAt]);

  // Yield right dock to PatchReviewDrawer or HistoryDrawer when active
  if (reviewTarget !== null || historyOpen) {
    return hasPreview ? (
      <aside className="tc-right-dock">
        <MarkdownPreview />
      </aside>
    ) : null;
  }

  if (!node && !hasPreview) return null;

  const effStatus = node && derived ? (derived.effectiveStatus.get(node.id) ?? "todo") : "todo";
  const resolvedStatus =
    node && derived ? (derived.resolvedStatus.get(node.id) ?? "todo") : "todo";
  const inheritedFromId =
    node && derived ? derived.inheritedStatusFrom.get(node.id) : undefined;
  const inheritedFromNode =
    inheritedFromId && derived ? derived.nodeMap.get(inheritedFromId) : undefined;
  const isCollapsed = node ? collapsed.includes(node.id) : false;

  const incoming = node && derived ? (derived.incomingEdges.get(node.id) ?? []) : [];
  const outgoing = node && derived ? (derived.outgoingEdges.get(node.id) ?? []) : [];
  const ancestors =
    node && derived ? [...(derived.ancestorsMap.get(node.id) ?? [])].reverse() : [];

  const statusMeta = STATUS_META[effStatus];
  const typeMeta = node ? NODE_TYPE_META[node.type] : null;

  const isDirty =
    node !== null &&
    node !== undefined &&
    (draftTitle.trim() !== node.title ||
      draftType !== node.type ||
      draftStatusNote !== (node.statusNote ?? "") ||
      draftDescription !== (node.description ?? "") ||
      draftConclusion !== (node.conclusion ?? ""));

  const handleSaveFields = async () => {
    if (!node || !canEdit || !isDirty) return;
    const trimmedTitle = draftTitle.trim();
    if (!trimmedTitle) {
      showToast("error", "节点标题不能为空");
      return;
    }

    const setObj: NodePatchSet = {};
    const unset: MutableNodeField[] = [];

    if (trimmedTitle !== node.title) setObj.title = trimmedTitle;
    if (draftType !== node.type) setObj.type = draftType;

    const applyOptionalStr = (
      field: "statusNote" | "description" | "conclusion",
      draft: string,
      orig: string | undefined
    ) => {
      const nextTrim = draft.trim();
      const origVal = orig ?? "";
      if (nextTrim === origVal) return;
      if (nextTrim.length === 0) unset.push(field);
      else setObj[field] = nextTrim;
    };

    applyOptionalStr("statusNote", draftStatusNote, node.statusNote);
    applyOptionalStr("description", draftDescription, node.description);
    applyOptionalStr("conclusion", draftConclusion, node.conclusion);

    if (Object.keys(setObj).length === 0 && unset.length === 0) return;

    await submitOps(
      [
        {
          op: "update_node",
          id: node.id,
          ...(Object.keys(setObj).length > 0 ? { set: setObj } : {}),
          ...(unset.length > 0 ? { unset } : {})
        }
      ],
      { label: `已更新节点 ${node.id}` }
    );
  };

  const handleStatusChange = async (nextStatus: Status) => {
    if (!node || !canEdit) return;
    const ok = await submitOps(
      [{ op: "update_node", id: node.id, set: { status: nextStatus } }],
      { label: `${node.id} 状态 → ${STATUS_META[nextStatus].shortLabel}` }
    );
    if (ok && (nextStatus === "blocked" || nextStatus === "parked" || nextStatus === "discarded")) {
      setTimeout(() => statusNoteRef.current?.focus(), 40);
    }
  };

  const handleClearContainerStatus = async () => {
    if (!node || !canEdit || !isContainer || node.status === undefined) return;
    await submitOps(
      [{ op: "update_node", id: node.id, unset: ["status"] }],
      { label: `${node.id} 已恢复为子节点自动汇总状态` }
    );
  };

  const handleCopyAiContext = async () => {
    if (!graph || !node) return;
    try {
      const compiled = compileContext(graph, node.id, { format: "md" });
      const ok = await copyTextToClipboard(compiled.text);
      if (ok) {
        setCopiedContext(true);
        showToast("success", `已复制节点 ${node.id} 的 AI 上下文（约 ${compiled.estimatedTokens} tokens）`);
        setTimeout(() => setCopiedContext(false), 2000);
      } else {
        showToast("error", "剪贴板写入失败，请检查浏览器权限");
      }
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "上下文编译失败");
    }
  };

  const handleDeleteNode = async (cascade: boolean) => {
    if (!node || !canEdit) return;
    await submitOps(
      [{ op: "remove_node", id: node.id, cascade }],
      {
        label: cascade ? `已级联删除容器 ${node.id} 及其子树` : `已删除节点 ${node.id}`,
        snapshotBefore: cascade
      }
    );
  };

  const isConfirmingDelete = Boolean(node && confirmDeleteNodeId === node.id);

  return (
    <aside className={`tc-right-dock ${hasPreview ? "tc-right-dock-wide" : ""}`}>
      {hasPreview && <MarkdownPreview />}

      {node && (
        <div className="tc-inspector">
          <div className="tc-inspector-header">
            <div className="tc-inspector-badges">
              {typeMeta && (
                <span
                  className="tc-type-badge"
                  style={{ background: typeMeta.badgeBg, color: typeMeta.badgeText }}
                >
                  {typeMeta.label}
                </span>
              )}
              <span className="tc-id-badge">{node.id}</span>
              <span
                className="tc-status-pill"
                style={{
                  background: statusMeta.bg,
                  color: statusMeta.text,
                  borderColor: statusMeta.border
                }}
              >
                {statusMeta.label}
              </span>
            </div>

            <div className="tc-card-actions">
              <button
                type="button"
                className="tc-tool-btn tc-tool-sm"
                title="复制当前节点的 6 段式 AI 上下文（Markdown）"
                onClick={() => void handleCopyAiContext()}
              >
                {copiedContext ? <Check size={12} /> : <Copy size={12} />}
                <span>{copiedContext ? "已复制" : "复制 AI 上下文"}</span>
              </button>

              <button
                type="button"
                className="tc-icon-btn"
                title="关闭详情面板"
                onClick={() => selectNode(null)}
              >
                <X size={15} />
              </button>
            </div>
          </div>

          <div className="tc-inspector-body">
            {ancestors.length > 0 && (
              <div className="tc-insp-chain">
                {ancestors.map((aid, idx) => (
                  <span key={aid}>
                    {idx > 0 && " > "}
                    <button
                      type="button"
                      className="tc-inline-link"
                      onClick={() => jumpToNode(aid)}
                    >
                      {aid} {derived?.nodeMap.get(aid)?.title}
                    </button>
                  </span>
                ))}
              </div>
            )}

            {canEdit ? (
              <div className="tc-edit-title-row">
                <input
                  type="text"
                  className="tc-input tc-input-title"
                  aria-label="节点标题"
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      void handleSaveFields();
                    }
                  }}
                />
                <select
                  className="tc-select-type"
                  aria-label="节点类型"
                  value={draftType}
                  onChange={(e) => setDraftType(e.target.value as NodeType)}
                >
                  {TYPE_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {NODE_TYPE_META[t].label}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <h2 className="tc-insp-title">{node.title}</h2>
            )}

            {isContainer && (
              <div className="tc-insp-actions">
                <button
                  type="button"
                  className="tc-tool-btn tc-tool-sm"
                  onClick={() => drillInto(node.id)}
                >
                  <Maximize2 size={13} />
                  <span>钻入子图</span>
                </button>
                <button
                  type="button"
                  className="tc-tool-btn tc-tool-sm"
                  onClick={() => toggleCollapse(node.id)}
                >
                  {isCollapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
                  <span>{isCollapsed ? "展开容器" : "折叠容器"}</span>
                </button>
              </div>
            )}

            {(timestampItems.length > 0 || !isReport) && (
              <div className="tc-insp-timestamps">
                {timestampItems.length > 0 ? (
                  timestampItems.map((item) => (
                    <span
                      key={item.key}
                      className="tc-insp-time-item"
                      title={`${item.label}：${formatFullLocalTime(item.value)}`}
                    >
                      <Clock size={11} />
                      <span className="tc-insp-time-label">{item.label}</span>
                      <span>{formatRelativeTime(item.value)}</span>
                    </span>
                  ))
                ) : (
                  <span className="tc-insp-time-empty">
                    <Clock size={11} />
                    <span>暂无时间记录（编辑后自动记录）</span>
                  </span>
                )}
              </div>
            )}

            {inheritedFromId && (
              <div className="tc-insp-inherit-banner">
                <Info size={14} />
                <span>
                  有效状态：<strong>{STATUS_META[effStatus].label}</strong>（继承自{" "}
                  <button
                    type="button"
                    className="tc-inline-link"
                    onClick={() => jumpToNode(inheritedFromId)}
                  >
                    {inheritedFromId} {inheritedFromNode?.title}
                  </button>
                  ；节点自身状态为 {STATUS_META[resolvedStatus].label}）
                </span>
              </div>
            )}

            {/* Quick Status Switcher (Phase 2 Manual Editing) */}
            {canEdit && (
              <div className="tc-insp-section">
                <div className="tc-insp-section-head">
                  <span className="tc-insp-section-label">状态切换（快捷键 1–6）</span>
                  {isContainer && node.status !== undefined && (
                    <button
                      type="button"
                      className="tc-inline-link"
                      disabled={mutating}
                      onClick={() => void handleClearContainerStatus()}
                    >
                      恢复自动汇总
                    </button>
                  )}
                </div>
                <div className="tc-status-picker">
                  {STATUS_ORDER.map(({ id, key }) => {
                    const meta = STATUS_META[id];
                    const isActive = (node.status ?? resolvedStatus) === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        disabled={mutating}
                        className={`tc-status-choice ${isActive ? "tc-status-choice-active" : ""}`}
                        style={
                          isActive
                            ? {
                                background: meta.bg,
                                color: meta.text,
                                borderColor: meta.accent
                              }
                            : undefined
                        }
                        onClick={() => void handleStatusChange(id)}
                      >
                        <kbd className="tc-kbd">{key}</kbd>
                        <span>{meta.shortLabel}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* StatusNote / Conclusion / Description (Editable in Workspace/Focus, Read-only in Report) */}
            {canEdit ? (
              <>
                <div className="tc-insp-section">
                  <label className="tc-insp-section-label" htmlFor="tc-field-status-note">
                    {effStatus === "blocked"
                      ? "阻塞原因（statusNote）"
                      : effStatus === "parked"
                        ? "搁置原因与恢复条件（statusNote）"
                        : effStatus === "discarded"
                          ? "否决原因 / 避坑记录（statusNote）"
                          : "状态备注（statusNote）"}
                  </label>
                  <textarea
                    id="tc-field-status-note"
                    ref={statusNoteRef}
                    className="tc-textarea"
                    rows={2}
                    placeholder="填写阻塞原因、搁置恢复条件或否决原因…"
                    value={draftStatusNote}
                    onChange={(e) => setDraftStatusNote(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        void handleSaveFields();
                      }
                    }}
                  />
                </div>

                <div className="tc-insp-section">
                  <label className="tc-insp-section-label" htmlFor="tc-field-conclusion">
                    核心结论（得出了什么）
                  </label>
                  <textarea
                    id="tc-field-conclusion"
                    className="tc-textarea"
                    rows={3}
                    placeholder="1~2 句关键结论，用于汇报卡片与 AI 上下文压缩…"
                    value={draftConclusion}
                    onChange={(e) => setDraftConclusion(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        void handleSaveFields();
                      }
                    }}
                  />
                </div>

                <div className="tc-insp-section">
                  <label className="tc-insp-section-label" htmlFor="tc-field-description">
                    任务说明（做什么 / 为什么）
                  </label>
                  <textarea
                    id="tc-field-description"
                    className="tc-textarea"
                    rows={3}
                    placeholder="说明调研范围、测算口径或判断依据…"
                    value={draftDescription}
                    onChange={(e) => setDraftDescription(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        void handleSaveFields();
                      }
                    }}
                  />
                </div>

                {isDirty && (
                  <div className="tc-edit-save-bar">
                    <button
                      type="button"
                      className="tc-btn tc-btn-primary tc-btn-sm"
                      disabled={mutating}
                      onClick={() => void handleSaveFields()}
                    >
                      <Save size={13} />
                      <span>保存修改 (Ctrl+Enter)</span>
                    </button>
                    <button
                      type="button"
                      className="tc-btn tc-btn-ghost tc-btn-sm"
                      onClick={() => {
                        setDraftTitle(node.title);
                        setDraftType(node.type);
                        setDraftStatusNote(node.statusNote ?? "");
                        setDraftDescription(node.description ?? "");
                        setDraftConclusion(node.conclusion ?? "");
                      }}
                    >
                      重置
                    </button>
                  </div>
                )}
              </>
            ) : (
              <>
                {node.statusNote && (
                  <div className={`tc-insp-callout tc-callout-${effStatus}`}>
                    <div className="tc-insp-section-label">
                      {effStatus === "blocked"
                        ? "阻塞原因"
                        : effStatus === "parked"
                          ? "搁置原因与恢复条件"
                          : effStatus === "discarded"
                            ? "否决原因（避坑记录）"
                            : "状态备注"}
                    </div>
                    <p>{node.statusNote}</p>
                  </div>
                )}

                {node.conclusion && (
                  <div className="tc-insp-section">
                    <div className="tc-insp-section-label">核心结论（得出了什么）</div>
                    <div className="tc-insp-conclusion">{node.conclusion}</div>
                  </div>
                )}

                {node.description && (
                  <div className="tc-insp-section">
                    <div className="tc-insp-section-label">任务说明（做什么 / 为什么）</div>
                    <p className="tc-insp-text">{node.description}</p>
                  </div>
                )}
              </>
            )}

            {node.metrics && node.metrics.length > 0 && (
              <div className="tc-insp-section">
                <div className="tc-insp-section-label">量化指标</div>
                <div className="tc-insp-metrics-grid">
                  {node.metrics.map((m, idx) => (
                    <div
                      key={idx}
                      className={`tc-insp-metric-card tc-metric-${m.tone ?? "neutral"}`}
                    >
                      <div className="tc-insp-metric-label">{m.label}</div>
                      <div className="tc-insp-metric-val">{m.value}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {node.attachments && node.attachments.length > 0 && (
              <div className="tc-insp-section">
                <div className="tc-insp-section-label">
                  <Paperclip size={12} /> 关联证据文档 ({node.attachments.length})
                </div>
                <div className="tc-attach-list">
                  {node.attachments.map((att, idx) => {
                    if (att.path) {
                      return (
                        <div key={idx} className="tc-attach-item">
                          <button
                            type="button"
                            className="tc-attach-open"
                            onClick={() =>
                              openPreviewDoc({
                                path: att.path!,
                                title: att.title
                              })
                            }
                          >
                            <FileText size={14} className="tc-attach-icon" />
                            <div className="tc-attach-meta">
                              <div className="tc-attach-title">
                                {att.title ?? att.path.split("/").pop()}
                              </div>
                              <div className="tc-attach-path">{att.path}</div>
                              {att.note && <div className="tc-attach-note">{att.note}</div>}
                            </div>
                          </button>
                          {workspaceRoot && (
                            <a
                              href={buildVscodeUrl(workspaceRoot, att.path)}
                              className="tc-icon-btn"
                              title="在 VS Code 中打开"
                            >
                              <Code2 size={13} />
                            </a>
                          )}
                        </div>
                      );
                    }
                    if (att.url) {
                      return (
                        <div key={idx} className="tc-attach-item">
                          <a
                            href={att.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="tc-attach-open"
                          >
                            <ExternalLink size={14} className="tc-attach-icon" />
                            <div className="tc-attach-meta">
                              <div className="tc-attach-title">{att.title ?? att.url}</div>
                              <div className="tc-attach-path">{att.url}</div>
                            </div>
                          </a>
                        </div>
                      );
                    }
                    return null;
                  })}
                </div>
              </div>
            )}

            {(incoming.length > 0 || outgoing.length > 0) && (
              <div className="tc-insp-section">
                <div className="tc-insp-section-label">上下游依赖</div>
                {incoming.length > 0 && (
                  <div className="tc-rel-group">
                    <div className="tc-rel-sub">
                      <ArrowUpLeft size={12} /> 前置输入 ({incoming.length})
                    </div>
                    <div className="tc-rel-chips">
                      {incoming.map((e) => {
                        const src = derived?.nodeMap.get(e.source);
                        return (
                          <div key={`${e.source}->${e.target}`} className="tc-rel-chip-wrap">
                            <button
                              type="button"
                              className="tc-rel-chip"
                              onClick={() => jumpToNode(e.source)}
                            >
                              <span className="tc-id-badge">{e.source}</span>
                              <span>{src?.title ?? e.source}</span>
                              {e.kind && e.kind !== "flow" && (
                                <span className="tc-rel-kind">{e.kind}</span>
                              )}
                            </button>
                            {canEdit && (
                              <button
                                type="button"
                                className="tc-rel-del"
                                title={`删除连线 ${e.source} → ${e.target}`}
                                onClick={() =>
                                  void submitOps(
                                    [{ op: "remove_edge", source: e.source, target: e.target }],
                                    { label: `已删除连线 ${e.source} → ${e.target}` }
                                  )
                                }
                              >
                                <X size={11} />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {outgoing.length > 0 && (
                  <div className="tc-rel-group">
                    <div className="tc-rel-sub">
                      <ArrowDownRight size={12} /> 后续输出 ({outgoing.length})
                    </div>
                    <div className="tc-rel-chips">
                      {outgoing.map((e) => {
                        const tgt = derived?.nodeMap.get(e.target);
                        return (
                          <div key={`${e.source}->${e.target}`} className="tc-rel-chip-wrap">
                            <button
                              type="button"
                              className="tc-rel-chip"
                              onClick={() => jumpToNode(e.target)}
                            >
                              <span className="tc-id-badge">{e.target}</span>
                              <span>{tgt?.title ?? e.target}</span>
                              {e.kind && e.kind !== "flow" && (
                                <span className="tc-rel-kind">{e.kind}</span>
                              )}
                            </button>
                            {canEdit && (
                              <button
                                type="button"
                                className="tc-rel-del"
                                title={`删除连线 ${e.source} → ${e.target}`}
                                onClick={() =>
                                  void submitOps(
                                    [{ op: "remove_edge", source: e.source, target: e.target }],
                                    { label: `已删除连线 ${e.source} → ${e.target}` }
                                  )
                                }
                              >
                                <X size={11} />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Danger Zone: Delete Node (with dissolve vs cascade for containers) */}
            {canEdit && (
              <div className="tc-insp-danger-zone">
                {!isConfirmingDelete ? (
                  <button
                    type="button"
                    className="tc-tool-btn tc-tool-sm tc-tool-danger"
                    disabled={mutating}
                    onClick={() => setConfirmDeleteNodeId(node.id)}
                  >
                    <Trash2 size={13} />
                    <span>删除节点 (Delete)</span>
                  </button>
                ) : (
                  <div className="tc-delete-confirm-box">
                    <div className="tc-delete-confirm-msg">
                      {isContainer
                        ? `容器 ${node.id} 包含子节点，请选择删除方式（均支持 Ctrl+Z 撤销）：`
                        : `确认删除节点 ${node.id} 及与其相连的边？（支持 Ctrl+Z 撤销）`}
                    </div>
                    <div className="tc-delete-confirm-actions">
                      {isContainer ? (
                        <>
                          <button
                            type="button"
                            className="tc-btn tc-btn-amber tc-btn-sm"
                            disabled={mutating}
                            onClick={() => void handleDeleteNode(false)}
                          >
                            仅拆散（保留子节点）
                          </button>
                          <button
                            type="button"
                            className="tc-btn tc-btn-danger tc-btn-sm"
                            disabled={mutating}
                            onClick={() => void handleDeleteNode(true)}
                          >
                            级联删除子树
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="tc-btn tc-btn-danger tc-btn-sm"
                          disabled={mutating}
                          onClick={() => void handleDeleteNode(false)}
                        >
                          确认删除
                        </button>
                      )}
                      <button
                        type="button"
                        className="tc-btn tc-btn-ghost tc-btn-sm"
                        onClick={() => setConfirmDeleteNodeId(null)}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
