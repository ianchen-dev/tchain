import { normalizeAttachmentPath } from "./canonicalize.js";
import { deriveGraph, edgeKey } from "./derive.js";
import {
  GraphSchema,
  type Diagnostic,
  type Graph,
  type Status
} from "./schema.js";

export interface ValidateOptions {
  /** Optional callback provided by IO layer to check relative POSIX path existence. */
  fileExists?: (posixPath: string) => boolean;
}

export interface ValidationResult {
  ok: boolean;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  diagnostics: Diagnostic[];
}

export function isAttachmentPathWithinWorkspace(rawPath: string): boolean {
  if (!rawPath || rawPath.trim().length === 0) return false;
  // Reject absolute UNIX paths, Windows drive letters, UNC paths, and null bytes.
  if (rawPath.includes("\0")) return false;
  if (/^[A-Za-z]:/.test(rawPath)) return false;
  if (rawPath.startsWith("/") || rawPath.startsWith("\\")) return false;

  const posix = normalizeAttachmentPath(rawPath);
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) return false;

  const segments = posix.split("/");
  let depth = 0;
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      depth -= 1;
      if (depth < 0) return false;
    } else {
      depth += 1;
    }
  }
  return depth > 0;
}

function isContainerStatusConflict(explicitStatus: Status, rolledUp: Status): boolean {
  // Explicit `parked` or `discarded` is an intentional container-level override (PRD §5.3.1).
  if (explicitStatus === "parked" || explicitStatus === "discarded") {
    return false;
  }
  return explicitStatus !== rolledUp;
}

export function validateGraph(
  input: unknown,
  options?: ValidateOptions
): ValidationResult {
  const diagnostics: Diagnostic[] = [];

  const parsed = GraphSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "$";
      diagnostics.push({
        level: "error",
        path,
        code: "SCHEMA_ERROR",
        message: issue.message,
        hint: "请检查字段名、类型或枚举值是否符合 tgraph.schema.json 规范"
      });
    }
    return buildResult(diagnostics);
  }

  const graph: Graph = parsed.data;

  // 1. Duplicate node IDs
  const seenNodeIds = new Map<string, number>();
  for (let i = 0; i < graph.nodes.length; i++) {
    const node = graph.nodes[i]!;
    const firstIdx = seenNodeIds.get(node.id);
    if (firstIdx !== undefined) {
      diagnostics.push({
        level: "error",
        path: `nodes[${i}].id`,
        code: "DUPLICATE_NODE_ID",
        message: `节点 id 重复：“${node.id}”（首次出现于 nodes[${firstIdx}]）`,
        hint: "请为每个节点分配全局唯一的 id"
      });
    } else {
      seenNodeIds.set(node.id, i);
    }
  }

  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodeIndex = new Map(graph.nodes.map((n, i) => [n.id, i]));

  // 2. Missing parentId & parentId cycles
  for (let i = 0; i < graph.nodes.length; i++) {
    const node = graph.nodes[i]!;
    if (node.parentId !== undefined) {
      if (!nodeMap.has(node.parentId)) {
        diagnostics.push({
          level: "error",
          path: `nodes[${i}].parentId`,
          code: "MISSING_PARENT",
          message: `节点 ${node.id} 的 parentId “${node.parentId}” 不存在`,
          hint: "请将 parentId 改为已存在的节点 id，或省略 parentId 将其设为顶层节点"
        });
      }
    }
  }

  // Detect parentId cycles (including self-parent)
  const parentVisitState = new Map<string, 0 | 1 | 2>(); // 0=unvisited, 1=visiting, 2=done
  const reportedParentCycles = new Set<string>();

  for (const node of graph.nodes) {
    if (parentVisitState.get(node.id) === 2) continue;
    const chain: string[] = [];
    const chainIndex = new Map<string, number>();
    let cur: string | undefined = node.id;

    while (cur && nodeMap.has(cur)) {
      if (parentVisitState.get(cur) === 2) break;
      const existingPos = chainIndex.get(cur);
      if (existingPos !== undefined) {
        const cycle = [...chain.slice(existingPos), cur];
        const canonicalCycleKey = [...cycle.slice(0, -1)].sort().join(",");
        if (!reportedParentCycles.has(canonicalCycleKey)) {
          reportedParentCycles.add(canonicalCycleKey);
          const idx = nodeIndex.get(cur) ?? 0;
          diagnostics.push({
            level: "error",
            path: `nodes[${idx}].parentId`,
            code: "PARENT_CYCLE",
            message: `parentId 形成环：${cycle.join(" → ")}`,
            hint: `请修改 ${cur} 的 parentId 以打破包含环`
          });
        }
        break;
      }
      chainIndex.set(cur, chain.length);
      chain.push(cur);
      parentVisitState.set(cur, 1);
      cur = nodeMap.get(cur)?.parentId;
    }

    for (const id of chain) {
      parentVisitState.set(id, 2);
    }
  }

  const derived = deriveGraph(graph);

  // 3. Leaf missing status, attachment validation, warnings
  let topGoalCount = 0;
  for (let i = 0; i < graph.nodes.length; i++) {
    const node = graph.nodes[i]!;
    const isContainer = derived.isContainer.has(node.id);

    if (!node.parentId && node.type === "goal") {
      topGoalCount += 1;
    }

    if (!isContainer && node.status === undefined) {
      diagnostics.push({
        level: "error",
        path: `nodes[${i}].status`,
        code: "LEAF_MISSING_STATUS",
        message: `叶子节点 ${node.id}（${node.title}）缺少必填字段 status`,
        hint: "请为叶子节点补充 status（todo / active / blocked / done / parked / discarded）"
      });
    }

    // StatusNote warning for explicit discarded / blocked / parked
    if (
      (node.status === "discarded" ||
        node.status === "blocked" ||
        node.status === "parked") &&
      (!node.statusNote || node.statusNote.trim().length === 0)
    ) {
      diagnostics.push({
        level: "warning",
        path: `nodes[${i}].statusNote`,
        code: "MISSING_STATUS_NOTE",
        message: `节点 ${node.id} 状态为 ${node.status}，但未填写 statusNote`,
        hint: "建议在 statusNote 中说明阻塞原因、搁置恢复条件或否决原因"
      });
    }

    // Container status conflict warning
    if (isContainer && node.status !== undefined) {
      const rolled = derived.rolledUpStatus.get(node.id);
      if (rolled && isContainerStatusConflict(node.status, rolled)) {
        diagnostics.push({
          level: "warning",
          path: `nodes[${i}].status`,
          code: "CONTAINER_STATUS_CONFLICT",
          message: `容器 ${node.id} 显式状态为 ${node.status}，与子节点汇总状态 ${rolled} 冲突`,
          hint: "非整体搁置/否决场景下，建议省略容器的 status 由子节点自动汇总"
        });
      }
    }

    // Attachments validation
    if (node.attachments) {
      for (let j = 0; j < node.attachments.length; j++) {
        const att = node.attachments[j]!;
        const hasPath = att.path !== undefined && att.path.trim().length > 0;
        const hasUrl = att.url !== undefined && att.url.trim().length > 0;

        if (hasPath === hasUrl) {
          diagnostics.push({
            level: "error",
            path: `nodes[${i}].attachments[${j}]`,
            code: "ATTACHMENT_INVALID_SOURCE",
            message: `节点 ${node.id} 的第 ${j} 个附件必须且只能填写 path 或 url 之一`,
            hint: "本地文件请仅填相对 path，网页链接请仅填 url"
          });
          continue;
        }

        if (hasPath && att.path !== undefined) {
          if (!isAttachmentPathWithinWorkspace(att.path)) {
            diagnostics.push({
              level: "error",
              path: `nodes[${i}].attachments[${j}].path`,
              code: "ATTACHMENT_PATH_OUTSIDE_WORKSPACE",
              message: `附件路径 “${att.path}” 非法或越出工作区根目录`,
              hint: "请使用相对工作区根目录的 POSIX 路径（不能包含绝对路径或越界 ..）"
            });
          } else if (options?.fileExists) {
            const posixPath = normalizeAttachmentPath(att.path);
            if (!options.fileExists(posixPath)) {
              diagnostics.push({
                level: "warning",
                path: `nodes[${i}].attachments[${j}].path`,
                code: "ATTACHMENT_NOT_FOUND",
                message: `节点 ${node.id} 挂载的文件不存在：${posixPath}`,
                hint: "请核对相对路径是否正确，或确认文件是否已移动"
              });
            }
          }
        }
      }
    }
  }

  if (topGoalCount > 1) {
    diagnostics.push({
      level: "warning",
      path: "nodes",
      code: "MULTIPLE_TOP_GOALS",
      message: `当前图谱包含 ${topGoalCount} 个顶层 goal 节点`,
      hint: "通常一张思维链图围绕一个主 goal 展开；如确需多目标可忽略此提示"
    });
  }

  // 4. Edge validation
  const seenEdges = new Map<string, number>();
  for (let i = 0; i < graph.edges.length; i++) {
    const edge = graph.edges[i]!;
    const srcExists = nodeMap.has(edge.source);
    const tgtExists = nodeMap.has(edge.target);

    if (!srcExists) {
      diagnostics.push({
        level: "error",
        path: `edges[${i}].source`,
        code: "EDGE_MISSING_ENDPOINT",
        message: `边起点 “${edge.source}” 不存在`,
        hint: "请确认 source 对应已存在的节点 id"
      });
    }
    if (!tgtExists) {
      diagnostics.push({
        level: "error",
        path: `edges[${i}].target`,
        code: "EDGE_MISSING_ENDPOINT",
        message: `边终点 “${edge.target}” 不存在`,
        hint: "请确认 target 对应已存在的节点 id"
      });
    }
    if (!srcExists || !tgtExists) continue;

    if (edge.source === edge.target) {
      diagnostics.push({
        level: "error",
        path: `edges[${i}]`,
        code: "EDGE_SELF_LOOP",
        message: `禁止节点自环边：${edge.source} → ${edge.target}`,
        hint: "请移除该自环边"
      });
      continue;
    }

    const key = edgeKey(edge.source, edge.target);
    const firstEdgeIdx = seenEdges.get(key);
    if (firstEdgeIdx !== undefined) {
      diagnostics.push({
        level: "error",
        path: `edges[${i}]`,
        code: "EDGE_DUPLICATE",
        message: `重复边：${edge.source} → ${edge.target}（首次出现于 edges[${firstEdgeIdx}]）`,
        hint: "(source, target) 为边的主键，请删除重复定义"
      });
      continue;
    }
    seenEdges.set(key, i);

    const srcAncestors = derived.ancestorsMap.get(edge.source) ?? [];
    const tgtAncestors = derived.ancestorsMap.get(edge.target) ?? [];
    if (srcAncestors.includes(edge.target) || tgtAncestors.includes(edge.source)) {
      diagnostics.push({
        level: "error",
        path: `edges[${i}]`,
        code: "EDGE_ANCESTOR_DESCENDANT",
        message: `禁止在祖先与后代节点之间连边：${edge.source} → ${edge.target}`,
        hint: "包含关系已由 parentId 表达，请删除该边"
      });
    }
  }

  // 5. DAG cycle detection (excluding revises edges)
  const color = new Map<string, 0 | 1 | 2>(); // 0=white, 1=gray, 2=black
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();
  const reportedDagCycles = new Set<string>();

  const dfs = (u: string) => {
    color.set(u, 1);
    stackIndex.set(u, stack.length);
    stack.push(u);

    const outEdges = derived.dagOutgoing.get(u) ?? [];
    for (const edge of outEdges) {
      const v = edge.target;
      if (!nodeMap.has(v)) continue;
      const c = color.get(v) ?? 0;
      if (c === 1) {
        const start = stackIndex.get(v)!;
        const cycle = [...stack.slice(start), v];
        const canonicalKey = [...cycle.slice(0, -1)].sort().join(",");
        if (!reportedDagCycles.has(canonicalKey)) {
          reportedDagCycles.add(canonicalKey);
          const edgeIdx = seenEdges.get(edgeKey(u, v)) ?? 0;
          diagnostics.push({
            level: "error",
            path: `edges[${edgeIdx}]`,
            code: "DAG_CYCLE",
            message: `flow / depends_on 边形成环：${cycle.join(" → ")}`,
            hint: "如果这是回流/修正关系，请将回流边的 kind 设为 \"revises\"；否则请打破环路"
          });
        }
      } else if (c === 0) {
        dfs(v);
      }
    }

    stack.pop();
    stackIndex.delete(u);
    color.set(u, 2);
  };

  for (const node of graph.nodes) {
    if ((color.get(node.id) ?? 0) === 0) {
      dfs(node.id);
    }
  }

  return buildResult(diagnostics);
}

function buildResult(diagnostics: Diagnostic[]): ValidationResult {
  const errors = diagnostics.filter((d) => d.level === "error");
  const warnings = diagnostics.filter((d) => d.level === "warning");
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    diagnostics
  };
}
