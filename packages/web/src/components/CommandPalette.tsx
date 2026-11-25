import { useMemo } from "react";
import { Command } from "cmdk";
import { deriveGraph } from "@tchain/core";
import { Search, X } from "lucide-react";
import { useWorkbenchStore } from "../store.js";
import { NODE_TYPE_META, STATUS_META } from "./statusMeta.js";

export function CommandPalette() {
  const open = useWorkbenchStore((s) => s.commandPaletteOpen);
  const graph = useWorkbenchStore((s) => s.graph);
  const setOpen = useWorkbenchStore((s) => s.setCommandPaletteOpen);
  const jumpToNode = useWorkbenchStore((s) => s.jumpToNode);
  const drillInto = useWorkbenchStore((s) => s.drillInto);

  const items = useMemo(() => {
    if (!graph) return [];
    const derived = deriveGraph(graph);
    return graph.nodes.map((n) => {
      const eff = derived.effectiveStatus.get(n.id) ?? "todo";
      const chain = [...(derived.ancestorsMap.get(n.id) ?? [])]
        .reverse()
        .map((id) => id)
        .join(" > ");
      const searchText = [
        n.id,
        n.title,
        n.description ?? "",
        n.conclusion ?? "",
        n.statusNote ?? "",
        ...(n.attachments ?? []).map((a) => `${a.title ?? ""} ${a.path ?? ""}`)
      ].join(" ");
      return {
        node: n,
        eff,
        chain,
        isContainer: derived.isContainer.has(n.id),
        searchText
      };
    });
  }, [graph]);

  if (!open) return null;

  return (
    <div
      className="tc-cmdk-backdrop"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="快速跳转节点"
    >
      <div className="tc-cmdk-dialog" onClick={(e) => e.stopPropagation()}>
        <Command label="全局节点搜索">
          <div className="tc-cmdk-input-row">
            <Search size={16} className="tc-cmdk-icon" />
            <Command.Input
              autoFocus
              placeholder="搜索节点 ID、标题、结论、状态备注或附件文档…"
              className="tc-cmdk-input"
            />
            <button
              type="button"
              className="tc-icon-btn"
              onClick={() => setOpen(false)}
              aria-label="关闭搜索"
            >
              <X size={15} />
            </button>
          </div>
          <Command.List className="tc-cmdk-list">
            <Command.Empty className="tc-cmdk-empty">未找到匹配的节点</Command.Empty>
            <Command.Group heading={`节点列表 (${items.length})`}>
              {items.map(({ node, eff, chain, isContainer, searchText }) => {
                const statusMeta = STATUS_META[eff];
                const typeMeta = NODE_TYPE_META[node.type];
                return (
                  <Command.Item
                    key={node.id}
                    value={searchText}
                    className="tc-cmdk-item"
                    onSelect={() => {
                      jumpToNode(node.id);
                      setOpen(false);
                    }}
                  >
                    <div className="tc-cmdk-item-main">
                      <span className="tc-id-badge">{node.id}</span>
                      <span
                        className="tc-type-badge"
                        style={{ background: typeMeta.badgeBg, color: typeMeta.badgeText }}
                      >
                        {typeMeta.label}
                      </span>
                      <span className="tc-cmdk-item-title">{node.title}</span>
                      <span
                        className="tc-status-pill"
                        style={{
                          background: statusMeta.bg,
                          color: statusMeta.text,
                          borderColor: statusMeta.border
                        }}
                      >
                        {statusMeta.shortLabel}
                      </span>
                    </div>
                    <div className="tc-cmdk-item-sub">
                      <span>{chain ? `位于 ${chain}` : "顶层节点"}</span>
                      {isContainer && (
                        <button
                          type="button"
                          className="tc-cmdk-drill-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            drillInto(node.id);
                            setOpen(false);
                          }}
                        >
                          直接钻入
                        </button>
                      )}
                    </div>
                  </Command.Item>
                );
              })}
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
