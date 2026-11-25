import { deriveGraph } from "./derive.js";
import type { Attachment, EdgeKind, Graph, Metric, Node, Status } from "./schema.js";

export interface CompileContextOptions {
  format?: "md" | "json";
  maxTokens?: number;
}

export interface ContextNodeSummary {
  id: string;
  type: Node["type"];
  title: string;
  status: Status;
  effectiveStatus: Status;
  inheritedStatusFrom?: string;
  statusNote?: string;
  description?: string;
  conclusion?: string;
  metrics?: Metric[];
}

export interface ContextEvidenceEntry {
  nodeId: string;
  nodeTitle: string;
  path?: string;
  url?: string;
  title?: string;
  note?: string;
}

export interface ContextNeighbor {
  id: string;
  title: string;
  type: Node["type"];
  effectiveStatus: Status;
  edgeKind: EdgeKind;
  conclusion?: string;
}

export interface CompiledContextData {
  graphId: string;
  graphTitle: string;
  targetNodeId: string;
  goals: ContextNodeSummary[];
  decisionPath: {
    containmentChain: ContextNodeSummary[];
    upstreamDecisions: ContextNodeSummary[];
  };
  avoidConstraints: ContextNodeSummary[];
  parkedRoutes: ContextNodeSummary[];
  currentAndNeighbors: {
    target: ContextNodeSummary;
    predecessors: ContextNeighbor[];
    successors: ContextNeighbor[];
    children: ContextNodeSummary[];
    revisesIncoming: ContextNeighbor[];
    revisesOutgoing: ContextNeighbor[];
  };
  evidencePaths: ContextEvidenceEntry[];
  truncatedSections: string[];
}

export interface CompiledContextResult {
  format: "md" | "json";
  text: string;
  data: CompiledContextData;
  estimatedTokens: number;
}

export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk * 1.2 + other / 4);
}

function summarizeNode(
  node: Node,
  derived: ReturnType<typeof deriveGraph>
): ContextNodeSummary {
  const status = derived.resolvedStatus.get(node.id) ?? node.status ?? "todo";
  const effectiveStatus = derived.effectiveStatus.get(node.id) ?? status;
  const inheritedStatusFrom = derived.inheritedStatusFrom.get(node.id);
  return {
    id: node.id,
    type: node.type,
    title: node.title,
    status,
    effectiveStatus,
    ...(inheritedStatusFrom ? { inheritedStatusFrom } : {}),
    ...(node.statusNote ? { statusNote: node.statusNote } : {}),
    ...(node.description ? { description: node.description } : {}),
    ...(node.conclusion ? { conclusion: node.conclusion } : {}),
    ...(node.metrics && node.metrics.length > 0 ? { metrics: node.metrics } : {})
  };
}

function formatMetricsInline(metrics?: Metric[]): string {
  if (!metrics || metrics.length === 0) return "";
  return ` [${metrics.map((m) => `${m.label}: ${m.value}`).join(" | ")}]`;
}

function renderMarkdown(data: CompiledContextData): string {
  const lines: string[] = [];
  lines.push(`# 上下文包：${data.graphTitle}（目标节点：${data.targetNodeId}）`);
  lines.push("");

  // ① 全局目标
  lines.push("## ① 全局目标");
  if (data.goals.length === 0) {
    lines.push("- （未定义 goal 节点）");
  } else {
    for (const g of data.goals) {
      lines.push(`- **${g.id} ${g.title}** \`[${g.effectiveStatus}]\``);
      if (g.description) lines.push(`  - 说明：${g.description}`);
      if (g.statusNote) lines.push(`  - 状态备注：${g.statusNote}`);
      if (g.conclusion) lines.push(`  - 结论：${g.conclusion}`);
    }
  }
  lines.push("");

  // ② 决策来路
  lines.push("## ② 决策来路");
  if (data.decisionPath.containmentChain.length > 0) {
    const breadcrumb = data.decisionPath.containmentChain
      .map((n) => `${n.id} ${n.title} [${n.effectiveStatus}]`)
      .join(" > ");
    lines.push(`- **所属层级**：${breadcrumb}`);
  }
  if (data.decisionPath.upstreamDecisions.length === 0) {
    lines.push("- **上游关键决策/里程碑**：（无）");
  } else {
    lines.push("- **上游关键决策 / 里程碑**：");
    for (const d of data.decisionPath.upstreamDecisions) {
      lines.push(
        `  - **${d.id} ${d.title}** \`[${d.type} / ${d.effectiveStatus}]\`${formatMetricsInline(d.metrics)}`
      );
      if (d.conclusion) lines.push(`    - 结论：${d.conclusion}`);
      else if (d.description) lines.push(`    - 说明：${d.description}`);
      if (d.statusNote) lines.push(`    - 状态备注：${d.statusNote}`);
    }
  }
  lines.push("");

  // ③ 避坑约束
  lines.push("## ③ 避坑约束（已否决方案）");
  if (data.avoidConstraints.length === 0) {
    lines.push("- （无已否决方案）");
  } else {
    for (const a of data.avoidConstraints) {
      lines.push(`- **${a.id} ${a.title}** \`[discarded]\``);
      if (a.statusNote) lines.push(`  - 否决原因：${a.statusNote}`);
      else if (a.conclusion) lines.push(`  - 结论：${a.conclusion}`);
    }
  }
  lines.push("");

  // ④ 可恢复路线
  lines.push("## ④ 可恢复路线（已搁置方案）");
  if (data.parkedRoutes.length === 0) {
    lines.push("- （无已搁置路线）");
  } else {
    for (const p of data.parkedRoutes) {
      const inheritTag = p.inheritedStatusFrom
        ? `（继承自 ${p.inheritedStatusFrom}，原状态 ${p.status}）`
        : "";
      lines.push(`- **${p.id} ${p.title}** \`[parked]\`${inheritTag}`);
      if (p.statusNote) lines.push(`  - 搁置原因/恢复条件：${p.statusNote}`);
    }
  }
  lines.push("");

  // ⑤ 当前任务与邻接节点
  const cur = data.currentAndNeighbors;
  lines.push("## ⑤ 当前任务与邻接节点");
  lines.push(
    `- **当前节点**：**${cur.target.id} ${cur.target.title}** \`[${cur.target.type} / ${cur.target.effectiveStatus}]\`${formatMetricsInline(cur.target.metrics)}`
  );
  if (cur.target.inheritedStatusFrom) {
    lines.push(
      `  - 状态继承：有效状态为 \`${cur.target.effectiveStatus}\`（继承自 ${cur.target.inheritedStatusFrom}，自身状态为 \`${cur.target.status}\`）`
    );
  }
  if (cur.target.description) lines.push(`  - 任务说明：${cur.target.description}`);
  if (cur.target.conclusion) lines.push(`  - 已有结论：${cur.target.conclusion}`);
  if (cur.target.statusNote) lines.push(`  - 状态备注：${cur.target.statusNote}`);

  if (cur.predecessors.length > 0) {
    lines.push("- **前置依赖**：");
    for (const p of cur.predecessors) {
      lines.push(
        `  - ${p.id} ${p.title} \`[${p.effectiveStatus} via ${p.edgeKind}]\`${p.conclusion ? ` — ${p.conclusion}` : ""}`
      );
    }
  }
  if (cur.successors.length > 0) {
    lines.push("- **直接后续**：");
    for (const s of cur.successors) {
      lines.push(`  - ${s.id} ${s.title} \`[${s.effectiveStatus} via ${s.edgeKind}]\``);
    }
  }
  if (cur.children.length > 0) {
    lines.push("- **包含子节点**：");
    for (const c of cur.children) {
      lines.push(`  - ${c.id} ${c.title} \`[${c.type} / ${c.effectiveStatus}]\``);
    }
  }
  if (cur.revisesIncoming.length > 0) {
    lines.push("- **回流修正（输入）**：");
    for (const r of cur.revisesIncoming) {
      lines.push(`  - ${r.id} ${r.title} \`[${r.effectiveStatus}]\``);
    }
  }
  if (cur.revisesOutgoing.length > 0) {
    lines.push("- **回流修正（输出）**：");
    for (const r of cur.revisesOutgoing) {
      lines.push(`  - ${r.id} ${r.title} \`[${r.effectiveStatus}]\``);
    }
  }
  lines.push("");

  // ⑥ 关联证据路径
  lines.push("## ⑥ 关联证据路径");
  if (data.evidencePaths.length === 0) {
    lines.push("- （无挂载证据）");
  } else {
    for (const ev of data.evidencePaths) {
      const loc = ev.path ?? ev.url ?? "";
      const titlePart = ev.title ? `${ev.title} — ` : "";
      lines.push(`- [${ev.nodeId}] ${titlePart}\`${loc}\`${ev.note ? `（${ev.note}）` : ""}`);
    }
  }

  if (data.truncatedSections.length > 0) {
    lines.push("");
    lines.push(
      `> 注：已按 maxTokens 限制裁剪部分远端内容（涉及分段：${data.truncatedSections.join("、")}）。`
    );
  }

  return `${lines.join("\n")}\n`;
}

export function compileContext(
  graph: Graph,
  nodeId: string,
  options?: CompileContextOptions
): CompiledContextResult {
  const derived = deriveGraph(graph);
  const targetNode = derived.nodeMap.get(nodeId);
  if (!targetNode) {
    throw new Error(`Node not found in graph "${graph.id}": ${nodeId}`);
  }

  // BFS upstream from targetNode + its containment ancestors (along DAG incoming edges + parentId),
  // WITHOUT skipping parked/discarded so we can discover the full historical decision chain,
  // parked alternatives, and rejected dead-ends.
  const upstreamDistance = new Map<string, number>();
  const queue: Array<{ id: string; dist: number }> = [];

  const enqueue = (id: string, dist: number) => {
    const existing = upstreamDistance.get(id);
    if (existing !== undefined && existing <= dist) return;
    upstreamDistance.set(id, dist);
    queue.push({ id, dist });
  };

  enqueue(nodeId, 0);
  const containmentAncestors = derived.ancestorsMap.get(nodeId) ?? [];
  for (let i = 0; i < containmentAncestors.length; i++) {
    enqueue(containmentAncestors[i]!, i + 1);
  }

  let head = 0;
  while (head < queue.length) {
    const { id, dist } = queue[head++]!;

    for (const edge of derived.dagIncoming.get(id) ?? []) {
      enqueue(edge.source, dist + 1);
    }

    const parentId = derived.nodeMap.get(id)?.parentId;
    if (parentId) {
      enqueue(parentId, dist + 1);
    }

    // Also include direct children of visited decision/option containers when scanning upstream
    // so rejected/parked alternatives (like C, D, X1, X2, I) under visited decisions (B, G) are discovered.
    const node = derived.nodeMap.get(id);
    if (node && (node.type === "decision" || node.type === "option")) {
      for (const childId of derived.childrenMap.get(id) ?? []) {
        const childEff = derived.effectiveStatus.get(childId);
        if (childEff === "discarded" || childEff === "parked") {
          enqueue(childId, dist + 1);
        }
      }
    }
  }

  // Also inspect siblings of targetNode and siblings of its containment ancestors
  const siblingScopeIds = new Set<string>([nodeId, ...containmentAncestors]);
  for (const id of siblingScopeIds) {
    const parentId = derived.nodeMap.get(id)?.parentId ?? null;
    for (const sibId of derived.childrenMap.get(parentId) ?? []) {
      if (sibId === id) continue;
      const sibEff = derived.effectiveStatus.get(sibId);
      if (sibEff === "discarded" || sibEff === "parked") {
        enqueue(sibId, (upstreamDistance.get(id) ?? 0) + 1);
      }
    }
  }

  // Expand inside any upstream discarded/parked containers to surface explicit discarded dead-ends (e.g., X1, X2 inside D)
  for (const [id, dist] of [...upstreamDistance.entries()]) {
    for (const descId of derived.descendantsMap.get(id) ?? []) {
      const desc = derived.nodeMap.get(descId);
      if (desc?.status === "discarded" || desc?.status === "blocked") {
        enqueue(descId, dist + 1);
      }
    }
  }

  // ① Goals: upstream goal nodes, or fallback to all top-level goal nodes
  const goalNodes = graph.nodes.filter(
    (n) => n.type === "goal" && (upstreamDistance.has(n.id) || n.parentId === undefined)
  );
  const goals = goalNodes.map((n) => summarizeNode(n, derived));

  // ② Decision path: containment chain (top-down) + upstream decision/milestone nodes (excluding target itself)
  const containmentChain = [...containmentAncestors]
    .reverse()
    .map((id) => summarizeNode(derived.nodeMap.get(id)!, derived));

  const containmentSet = new Set(containmentAncestors);
  const upstreamDecisions = graph.nodes
    .filter(
      (n) =>
        n.id !== nodeId &&
        !containmentSet.has(n.id) &&
        upstreamDistance.has(n.id) &&
        (n.type === "decision" || n.type === "milestone")
    )
    .map((n) => summarizeNode(n, derived));

  // ③ Avoid constraints: all discovered nodes with effectiveStatus === "discarded"
  const avoidConstraints = graph.nodes
    .filter(
      (n) =>
        n.id !== nodeId &&
        upstreamDistance.has(n.id) &&
        derived.effectiveStatus.get(n.id) === "discarded"
    )
    .map((n) => summarizeNode(n, derived));

  // ④ Parked routes: discovered nodes that are explicitly parked, or notable blocked nodes inheriting parked
  const parkedRoutes = graph.nodes
    .filter((n) => {
      if (n.id === nodeId || !upstreamDistance.has(n.id)) return false;
      const eff = derived.effectiveStatus.get(n.id);
      if (eff !== "parked") return false;
      // Avoid listing every done/todo child inside an already-parked container unless it has explicit parked/blocked status
      const inheritedFrom = derived.inheritedStatusFrom.get(n.id);
      if (inheritedFrom && upstreamDistance.has(inheritedFrom)) {
        return n.status === "blocked";
      }
      return true;
    })
    .map((n) => summarizeNode(n, derived));

  // ⑤ Current node & neighbors
  const toNeighbor = (id: string, kind: EdgeKind | undefined): ContextNeighbor => {
    const n = derived.nodeMap.get(id)!;
    return {
      id: n.id,
      title: n.title,
      type: n.type,
      effectiveStatus: derived.effectiveStatus.get(n.id) ?? "todo",
      edgeKind: kind ?? "flow",
      ...(n.conclusion ? { conclusion: n.conclusion } : {})
    };
  };

  const predecessors = (derived.dagIncoming.get(nodeId) ?? []).map((e) =>
    toNeighbor(e.source, e.kind)
  );
  const successors = (derived.dagOutgoing.get(nodeId) ?? []).map((e) =>
    toNeighbor(e.target, e.kind)
  );
  const children = (derived.childrenMap.get(nodeId) ?? []).map((cid) =>
    summarizeNode(derived.nodeMap.get(cid)!, derived)
  );
  const revisesIncoming = (derived.incomingEdges.get(nodeId) ?? [])
    .filter((e) => e.kind === "revises")
    .map((e) => toNeighbor(e.source, e.kind));
  const revisesOutgoing = (derived.outgoingEdges.get(nodeId) ?? [])
    .filter((e) => e.kind === "revises")
    .map((e) => toNeighbor(e.target, e.kind));

  // ⑥ Evidence paths: sorted by distance from targetNode (closest first so truncation trims farthest first!)
  const evidenceNodeCandidates = [...upstreamDistance.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => derived.nodeMap.get(id)!)
    .filter((n): n is Node => Boolean(n && n.attachments && n.attachments.length > 0));

  const seenEvidenceKeys = new Set<string>();
  const evidencePaths: ContextEvidenceEntry[] = [];
  for (const n of evidenceNodeCandidates) {
    for (const att of n.attachments as Attachment[]) {
      const key = `${n.id}::${att.path ?? att.url ?? ""}`;
      if (seenEvidenceKeys.has(key)) continue;
      seenEvidenceKeys.add(key);
      evidencePaths.push({
        nodeId: n.id,
        nodeTitle: n.title,
        ...(att.path ? { path: att.path } : {}),
        ...(att.url ? { url: att.url } : {}),
        ...(att.title ? { title: att.title } : {}),
        ...(att.note ? { note: att.note } : {})
      });
    }
  }

  const data: CompiledContextData = {
    graphId: graph.id,
    graphTitle: graph.title,
    targetNodeId: nodeId,
    goals,
    decisionPath: {
      containmentChain,
      upstreamDecisions
    },
    avoidConstraints,
    parkedRoutes,
    currentAndNeighbors: {
      target: summarizeNode(targetNode, derived),
      predecessors,
      successors,
      children,
      revisesIncoming,
      revisesOutgoing
    },
    evidencePaths,
    truncatedSections: []
  };

  const format = options?.format ?? "md";
  const render = (): string =>
    format === "json" ? `${JSON.stringify(data, null, 2)}\n` : renderMarkdown(data);

  // Enforce maxTokens truncation strictly in PRD §7.5 order: ⑥ → ④ → ②
  const maxTokens = options?.maxTokens;
  if (maxTokens !== undefined && maxTokens > 0) {
    const addTruncated = (label: string) => {
      if (!data.truncatedSections.includes(label)) {
        data.truncatedSections.push(label);
      }
    };

    // Trim ⑥ evidencePaths (farthest from target are at the end)
    while (estimateTokens(render()) > maxTokens && data.evidencePaths.length > 0) {
      data.evidencePaths.pop();
      addTruncated("⑥ 关联证据路径");
    }

    // Trim ④ parkedRoutes (farthest first: sort by distance descending on copy? Pop from start = earliest/farthest!)
    while (estimateTokens(render()) > maxTokens && data.parkedRoutes.length > 0) {
      data.parkedRoutes.shift();
      addTruncated("④ 可恢复路线");
    }

    // Trim ② upstreamDecisions (earliest/farthest first)
    while (
      estimateTokens(render()) > maxTokens &&
      data.decisionPath.upstreamDecisions.length > 0
    ) {
      data.decisionPath.upstreamDecisions.shift();
      addTruncated("② 决策来路");
    }
  }

  const text = render();
  return {
    format,
    text,
    data,
    estimatedTokens: estimateTokens(text)
  };
}
