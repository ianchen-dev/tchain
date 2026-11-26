import { z } from "zod";
import { applyOps, ApplyError, type ApplyOptions, type ApplyResult } from "./apply.js";
import { hashGraph } from "./canonicalize.js";
import { deriveGraph, edgeKey } from "./derive.js";
import {
  AddEdgeOpSchema,
  AddNodeOpSchema,
  DiagnosticSchema,
  GRAPH_ID_REGEX,
  MUTABLE_NODE_FIELDS,
  RemoveEdgeOpSchema,
  RemoveNodeOpSchema,
  UpdateNodeOpSchema,
  type Diagnostic,
  type Edge,
  type Graph,
  type Node,
  type Op
} from "./schema.js";
import type { ValidateOptions } from "./validate.js";

export const PatchStateSchema = z.enum([
  "pending",
  "applied",
  "partially_applied",
  "rejected"
]);
export type PatchState = z.infer<typeof PatchStateSchema>;

const PatchMetaFields = {
  before: z.record(z.string(), z.unknown()).optional(),
  deps: z.array(z.number().int().nonnegative()).optional()
};

export const PatchOpSchema = z.discriminatedUnion("op", [
  AddNodeOpSchema.extend(PatchMetaFields),
  UpdateNodeOpSchema.extend(PatchMetaFields),
  RemoveNodeOpSchema.extend(PatchMetaFields),
  AddEdgeOpSchema.extend(PatchMetaFields),
  RemoveEdgeOpSchema.extend(PatchMetaFields)
]);
export type PatchOp = z.infer<typeof PatchOpSchema>;

export const PatchFileSchema = z.object({
  id: z.string().min(1),
  graphId: z.string().regex(GRAPH_ID_REGEX),
  baseHash: z.string().min(1),
  author: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string(),
  createdAt: z.string().optional(),
  state: PatchStateSchema,
  ops: z.array(PatchOpSchema),
  diagnostics: z.array(DiagnosticSchema)
});
export type PatchFile = z.infer<typeof PatchFileSchema>;

export const HistorySourceSchema = z.enum([
  "patch",
  "external",
  "manual",
  "rollback",
  "cascade_delete",
  "manual_checkpoint"
]);
export type HistorySource = z.infer<typeof HistorySourceSchema>;

export interface OpSummaryCounts {
  totalOps: number;
  addedNodes: number;
  updatedNodes: number;
  removedNodes: number;
  statusChanges: number;
  addedAttachments: number;
  addedEdges: number;
  removedEdges: number;
}

export interface HistoryEntry {
  rev: number;
  at: string;
  source: HistorySource;
  title: string;
  counts: OpSummaryCounts;
  hash: string;
}

export interface EvaluatedPatchOp {
  index: number;
  op: PatchOp;
  deps: number[];
  conflicted: boolean;
  conflictReason?: string;
  defaultSelected: boolean;
}

export interface PatchEvaluation {
  patchId: string;
  graphId: string;
  baseHash: string;
  currentHash: string;
  isStale: boolean;
  hasConflicts: boolean;
  conflictCount: number;
  ops: EvaluatedPatchOp[];
  defaultSelectedIndices: number[];
  summary: OpSummaryCounts;
}

export interface PreparedPatchOps {
  ops: PatchOp[];
  warnings: Diagnostic[];
  previewGraph: Graph;
  summary: OpSummaryCounts;
}

export function stripPatchOpMeta(op: PatchOp): Op {
  if (op.op === "add_node") {
    return {
      op: "add_node",
      node: structuredClone(op.node),
      ...(op.after !== undefined ? { after: op.after } : {})
    };
  }
  if (op.op === "update_node") {
    return {
      op: "update_node",
      id: op.id,
      ...(op.set !== undefined ? { set: structuredClone(op.set) } : {}),
      ...(op.unset !== undefined ? { unset: [...op.unset] } : {})
    };
  }
  if (op.op === "remove_node") {
    return {
      op: "remove_node",
      id: op.id,
      cascade: op.cascade
    };
  }
  if (op.op === "add_edge") {
    return {
      op: "add_edge",
      source: op.source,
      target: op.target,
      ...(op.kind !== undefined ? { kind: op.kind } : {})
    };
  }
  return {
    op: "remove_edge",
    source: op.source,
    target: op.target
  };
}

export function summarizeOps(ops: ReadonlyArray<Op | PatchOp>): OpSummaryCounts {
  const counts: OpSummaryCounts = {
    totalOps: ops.length,
    addedNodes: 0,
    updatedNodes: 0,
    removedNodes: 0,
    statusChanges: 0,
    addedAttachments: 0,
    addedEdges: 0,
    removedEdges: 0
  };

  for (const op of ops) {
    if (op.op === "add_node") {
      counts.addedNodes += 1;
      if (op.node.attachments && op.node.attachments.length > 0) {
        counts.addedAttachments += op.node.attachments.length;
      }
    } else if (op.op === "update_node") {
      counts.updatedNodes += 1;
      if (op.set?.status !== undefined || op.unset?.includes("status")) {
        counts.statusChanges += 1;
      }
      if (op.set?.attachments) {
        const beforeAtts = Array.isArray((op as PatchOp).before?.attachments)
          ? ((op as PatchOp).before!.attachments as unknown[]).length
          : 0;
        const delta = op.set.attachments.length - beforeAtts;
        if (delta > 0) counts.addedAttachments += delta;
      }
    } else if (op.op === "remove_node") {
      counts.removedNodes += 1;
    } else if (op.op === "add_edge") {
      counts.addedEdges += 1;
    } else if (op.op === "remove_edge") {
      counts.removedEdges += 1;
    }
  }

  return counts;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function findPrevSiblingId(
  nodes: Node[],
  id: string,
  parentId: string | undefined
): string | null {
  let prev: string | null = null;
  for (const n of nodes) {
    if (n.id === id) return prev;
    if (n.parentId === parentId) prev = n.id;
  }
  return prev;
}

function collectSubtreeIds(nodes: Node[], rootId: string): Set<string> {
  const result = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes) {
      if (n.parentId && result.has(n.parentId) && !result.has(n.id)) {
        result.add(n.id);
        changed = true;
      }
    }
  }
  return result;
}

function applySingleOpLight(nodes: Node[], edges: Edge[], op: Op): { nodes: Node[]; edges: Edge[] } {
  const nextNodes = nodes;
  let nextEdges = edges;

  if (op.op === "add_node") {
    nextNodes.push(structuredClone(op.node));
    return { nodes: nextNodes, edges: nextEdges };
  }

  if (op.op === "update_node") {
    const node = nextNodes.find((n) => n.id === op.id);
    if (node) {
      const setObj = op.set ?? {};
      const unsetSet = new Set(op.unset ?? []);
      for (const field of MUTABLE_NODE_FIELDS) {
        if (unsetSet.has(field) || (field === "parentId" && setObj.parentId === null)) {
          delete (node as Record<string, unknown>)[field];
        } else if (
          Object.prototype.hasOwnProperty.call(setObj, field) &&
          (setObj as Record<string, unknown>)[field] !== undefined
        ) {
          (node as Record<string, unknown>)[field] = structuredClone(
            (setObj as Record<string, unknown>)[field]
          );
        }
      }
    }
    return { nodes: nextNodes, edges: nextEdges };
  }

  if (op.op === "remove_node") {
    const target = nextNodes.find((n) => n.id === op.id);
    if (!target) return { nodes: nextNodes, edges: nextEdges };
    if (op.cascade) {
      const subtree = collectSubtreeIds(nextNodes, op.id);
      const kept = nextNodes.filter((n) => !subtree.has(n.id));
      nextEdges = nextEdges.filter((e) => !subtree.has(e.source) && !subtree.has(e.target));
      return { nodes: kept, edges: nextEdges };
    }
    for (const child of nextNodes) {
      if (child.parentId === target.id) {
        if (target.parentId === undefined) delete child.parentId;
        else child.parentId = target.parentId;
      }
    }
    const kept = nextNodes.filter((n) => n.id !== target.id);
    nextEdges = nextEdges.filter((e) => e.source !== target.id && e.target !== target.id);
    return { nodes: kept, edges: nextEdges };
  }

  if (op.op === "add_edge") {
    const idx = nextEdges.findIndex((e) => e.source === op.source && e.target === op.target);
    const edge: Edge = {
      source: op.source,
      target: op.target,
      ...(op.kind && op.kind !== "flow" ? { kind: op.kind } : {})
    };
    if (idx >= 0) nextEdges[idx] = edge;
    else nextEdges.push(edge);
    return { nodes: nextNodes, edges: nextEdges };
  }

  nextEdges = nextEdges.filter((e) => !(e.source === op.source && e.target === op.target));
  return { nodes: nextNodes, edges: nextEdges };
}

/**
 * Validates raw ops against `baseGraph`, computes per-op `before` snapshots
 * and intra-patch `deps` (PRD §7.3). Throws `ApplyError` if invalid.
 */
export function preparePatchOps(
  baseGraph: Graph,
  rawOps: Op[],
  options?: ValidateOptions
): PreparedPatchOps {
  // Full semantic validation via unified applyOps pipeline first
  const applied = applyOps(baseGraph, rawOps, options);

  let simNodes = structuredClone(baseGraph.nodes);
  let simEdges = structuredClone(baseGraph.edges);

  const createdNodeByOp = new Map<string, number>();
  const lastNodeOp = new Map<string, number>();
  const lastEdgeOp = new Map<string, number>();

  const enrichedOps: PatchOp[] = [];

  for (let i = 0; i < rawOps.length; i++) {
    const op = rawOps[i]!;
    const depSet = new Set<number>();
    let before: Record<string, unknown> | undefined;

    if (op.op === "add_node") {
      if (op.node.parentId && createdNodeByOp.has(op.node.parentId)) {
        depSet.add(createdNodeByOp.get(op.node.parentId)!);
      }
      if (typeof op.after === "string" && createdNodeByOp.has(op.after)) {
        depSet.add(createdNodeByOp.get(op.after)!);
      }
      if (lastNodeOp.has(op.node.id)) {
        depSet.add(lastNodeOp.get(op.node.id)!);
      }
      createdNodeByOp.set(op.node.id, i);
      lastNodeOp.set(op.node.id, i);
    } else if (op.op === "update_node") {
      const curNode = simNodes.find((n) => n.id === op.id);
      if (lastNodeOp.has(op.id)) {
        depSet.add(lastNodeOp.get(op.id)!);
      }
      if (typeof op.set?.parentId === "string" && createdNodeByOp.has(op.set.parentId)) {
        depSet.add(createdNodeByOp.get(op.set.parentId)!);
      }
      if (typeof op.set?.after === "string" && createdNodeByOp.has(op.set.after)) {
        depSet.add(createdNodeByOp.get(op.set.after)!);
      }

      if (curNode) {
        before = {};
        const setObj = op.set ?? {};
        for (const key of Object.keys(setObj)) {
          if (key === "after") {
            before.after = findPrevSiblingId(simNodes, curNode.id, curNode.parentId);
          } else {
            const val = (curNode as Record<string, unknown>)[key];
            before[key] = val === undefined ? null : structuredClone(val);
          }
        }
        for (const field of op.unset ?? []) {
          const val = (curNode as Record<string, unknown>)[field];
          before[field] = val === undefined ? null : structuredClone(val);
        }
      }
      lastNodeOp.set(op.id, i);
    } else if (op.op === "remove_node") {
      const curNode = simNodes.find((n) => n.id === op.id);
      if (lastNodeOp.has(op.id)) {
        depSet.add(lastNodeOp.get(op.id)!);
      }
      if (curNode) {
        before = {
          title: curNode.title,
          type: curNode.type,
          status: curNode.status ?? null,
          parentId: curNode.parentId ?? null
        };
      }
      lastNodeOp.set(op.id, i);
      createdNodeByOp.delete(op.id);
    } else if (op.op === "add_edge") {
      if (createdNodeByOp.has(op.source)) {
        depSet.add(createdNodeByOp.get(op.source)!);
      }
      if (createdNodeByOp.has(op.target)) {
        depSet.add(createdNodeByOp.get(op.target)!);
      }
      const key = edgeKey(op.source, op.target);
      if (lastEdgeOp.has(key)) {
        depSet.add(lastEdgeOp.get(key)!);
      }
      const existing = simEdges.find((e) => e.source === op.source && e.target === op.target);
      before = existing
        ? { exists: true, kind: existing.kind ?? "flow" }
        : { exists: false };
      lastEdgeOp.set(key, i);
    } else if (op.op === "remove_edge") {
      const key = edgeKey(op.source, op.target);
      if (lastEdgeOp.has(key)) {
        depSet.add(lastEdgeOp.get(key)!);
      }
      const existing = simEdges.find((e) => e.source === op.source && e.target === op.target);
      before = existing
        ? { exists: true, kind: existing.kind ?? "flow" }
        : { exists: false };
      lastEdgeOp.set(key, i);
    }

    depSet.delete(i);
    const deps = [...depSet].sort((a, b) => a - b);

    const patchOp: PatchOp = {
      ...structuredClone(op),
      ...(before && Object.keys(before).length > 0 ? { before } : {}),
      ...(deps.length > 0 ? { deps } : {})
    };
    enrichedOps.push(patchOp);

    const next = applySingleOpLight(simNodes, simEdges, op);
    simNodes = next.nodes;
    simEdges = next.edges;
  }

  return {
    ops: enrichedOps,
    warnings: applied.warnings,
    previewGraph: applied.graph,
    summary: summarizeOps(enrichedOps)
  };
}

/** Returns all transitive upstream dependencies for `index`. */
export function getTransitiveDeps(ops: ReadonlyArray<PatchOp>, index: number): number[] {
  const visited = new Set<number>();
  const stack = [...(ops[index]?.deps ?? [])];
  while (stack.length > 0) {
    const dep = stack.pop()!;
    if (dep < 0 || dep >= ops.length || visited.has(dep) || dep === index) continue;
    visited.add(dep);
    for (const parentDep of ops[dep]?.deps ?? []) {
      stack.push(parentDep);
    }
  }
  return [...visited].sort((a, b) => a - b);
}

/** Returns all transitive downstream ops that depend on `index`. */
export function getTransitiveDependents(ops: ReadonlyArray<PatchOp>, index: number): number[] {
  const dependentsMap = new Map<number, number[]>();
  for (let i = 0; i < ops.length; i++) {
    for (const dep of ops[i]?.deps ?? []) {
      const list = dependentsMap.get(dep) ?? [];
      list.push(i);
      dependentsMap.set(dep, list);
    }
  }

  const visited = new Set<number>();
  const stack = [...(dependentsMap.get(index) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (visited.has(next) || next === index) continue;
    visited.add(next);
    for (const child of dependentsMap.get(next) ?? []) {
      stack.push(child);
    }
  }
  return [...visited].sort((a, b) => a - b);
}

/**
 * Dependency-linked checkbox toggle (PRD §7.3):
 * - Checking an op automatically checks all its transitive `deps`.
 * - Unchecking an op automatically unchecks all its transitive dependents.
 */
export function toggleOpSelection(
  ops: ReadonlyArray<PatchOp>,
  currentSelected: ReadonlySet<number>,
  index: number,
  nextChecked: boolean
): Set<number> {
  const next = new Set(currentSelected);
  if (nextChecked) {
    next.add(index);
    for (const dep of getTransitiveDeps(ops, index)) {
      next.add(dep);
    }
  } else {
    next.delete(index);
    for (const dependent of getTransitiveDependents(ops, index)) {
      next.delete(dependent);
    }
  }
  return next;
}

function formatShortValue(val: unknown): string {
  if (val === null || val === undefined) return "空";
  if (typeof val === "string") {
    return val.length > 24 ? `${val.slice(0, 24)}…` : val;
  }
  if (typeof val === "boolean" || typeof val === "number") return String(val);
  const s = JSON.stringify(val);
  return s.length > 28 ? `${s.slice(0, 28)}…` : s;
}

/**
 * Evaluates a Patch against the current graph (PRD §7.3 lightweight rebase).
 * If `currentHash !== patch.baseHash`, checks each op's `before` snapshot and
 * structural preconditions; conflicted ops (and ops depending on them) are marked
 * `conflicted: true, defaultSelected: false`.
 */
export function evaluatePatchAgainstGraph(
  currentGraph: Graph,
  patch: PatchFile,
  options?: ValidateOptions
): PatchEvaluation {
  const currentHash = hashGraph(currentGraph);
  const isStale = currentHash !== patch.baseHash;

  let simNodes = structuredClone(currentGraph.nodes);
  let simEdges = structuredClone(currentGraph.edges);

  const conflictedSet = new Set<number>();
  const evaluatedOps: EvaluatedPatchOp[] = [];

  for (let i = 0; i < patch.ops.length; i++) {
    const op = patch.ops[i]!;
    const deps = op.deps ?? [];
    let conflicted = false;
    let conflictReason: string | undefined;

    const failedDep = deps.find((d) => conflictedSet.has(d));
    if (failedDep !== undefined) {
      conflicted = true;
      conflictReason = `依赖的操作 #${failedDep + 1} 存在冲突`;
    } else if (isStale) {
      const nodeMap = new Map(simNodes.map((n) => [n.id, n]));

      if (op.op === "add_node") {
        if (nodeMap.has(op.node.id)) {
          conflicted = true;
          conflictReason = `节点 ${op.node.id} 已存在于当前图谱`;
        } else if (op.node.parentId && !nodeMap.has(op.node.parentId)) {
          conflicted = true;
          conflictReason = `目标父容器 ${op.node.parentId} 已不存在`;
        } else if (typeof op.after === "string" && !nodeMap.has(op.after)) {
          conflicted = true;
          conflictReason = `插入锚点兄弟节点 ${op.after} 已不存在`;
        }
      } else if (op.op === "update_node") {
        const curNode = nodeMap.get(op.id);
        if (!curNode) {
          conflicted = true;
          conflictReason = `节点 ${op.id} 已被删除或不存在`;
        } else {
          if (op.before) {
            for (const [field, expectedVal] of Object.entries(op.before)) {
              const actualVal =
                field === "after"
                  ? findPrevSiblingId(simNodes, curNode.id, curNode.parentId)
                  : ((curNode as Record<string, unknown>)[field] ?? null);
              if (!deepEqual(actualVal, expectedVal)) {
                conflicted = true;
                conflictReason = `节点 ${op.id} 的字段 ${field} 已被修改（提案基线：${formatShortValue(expectedVal)}，当前值：${formatShortValue(actualVal)}）`;
                break;
              }
            }
          }
          if (
            !conflicted &&
            typeof op.set?.parentId === "string" &&
            !nodeMap.has(op.set.parentId)
          ) {
            conflicted = true;
            conflictReason = `目标父容器 ${op.set.parentId} 已不存在`;
          }
          if (
            !conflicted &&
            typeof op.set?.after === "string" &&
            !nodeMap.has(op.set.after)
          ) {
            conflicted = true;
            conflictReason = `排序锚点 ${op.set.after} 已不存在`;
          }
        }
      } else if (op.op === "remove_node") {
        const curNode = nodeMap.get(op.id);
        if (!curNode) {
          conflicted = true;
          conflictReason = `节点 ${op.id} 已不存在`;
        } else if (op.before) {
          for (const [field, expectedVal] of Object.entries(op.before)) {
            const actualVal = (curNode as Record<string, unknown>)[field] ?? null;
            if (!deepEqual(actualVal, expectedVal)) {
              conflicted = true;
              conflictReason = `节点 ${op.id} 的 ${field} 在删除前已被修改`;
              break;
            }
          }
        }
      } else if (op.op === "add_edge") {
        if (!nodeMap.has(op.source) || !nodeMap.has(op.target)) {
          conflicted = true;
          conflictReason = `边端点 ${op.source} → ${op.target} 不存在`;
        } else {
          const existing = simEdges.find(
            (e) => e.source === op.source && e.target === op.target
          );
          if (op.before) {
            const expectedExists = op.before.exists === true;
            const actualExists = Boolean(existing);
            if (expectedExists !== actualExists) {
              conflicted = true;
              conflictReason = actualExists
                ? `边 ${op.source} → ${op.target} 已存在`
                : `原边 ${op.source} → ${op.target} 已被删除`;
            } else if (
              expectedExists &&
              existing &&
              (existing.kind ?? "flow") !== op.before.kind
            ) {
              conflicted = true;
              conflictReason = `边 ${op.source} → ${op.target} 的类型已被修改`;
            }
          }
        }
      } else if (op.op === "remove_edge") {
        const existing = simEdges.find(
          (e) => e.source === op.source && e.target === op.target
        );
        if (!existing) {
          conflicted = true;
          conflictReason = `边 ${op.source} → ${op.target} 已不存在`;
        } else if (
          op.before?.kind !== undefined &&
          (existing.kind ?? "flow") !== op.before.kind
        ) {
          conflicted = true;
          conflictReason = `边 ${op.source} → ${op.target} 的类型已被修改`;
        }
      }
    }

    if (conflicted) {
      conflictedSet.add(i);
    } else {
      const next = applySingleOpLight(simNodes, simEdges, stripPatchOpMeta(op));
      simNodes = next.nodes;
      simEdges = next.edges;
    }

    evaluatedOps.push({
      index: i,
      op,
      deps,
      conflicted,
      ...(conflictReason ? { conflictReason } : {}),
      defaultSelected: !conflicted
    });
  }

  // Verify the default-selected non-conflicted subset still passes full semantic validation
  // (e.g. if an external edit introduced a path that makes a proposed edge create a DAG cycle).
  const candidateIndices = evaluatedOps
    .filter((o) => o.defaultSelected)
    .map((o) => o.index);

  if (candidateIndices.length > 0 && isStale) {
    try {
      const cleanOps = candidateIndices.map((idx) => stripPatchOpMeta(patch.ops[idx]!));
      applyOps(currentGraph, cleanOps, options);
    } catch (err) {
      if (err instanceof ApplyError) {
        // Isolate offending ops by testing incrementally
        const accepted: number[] = [];
        for (const idx of candidateIndices) {
          const trial = [...accepted, idx].map((k) => stripPatchOpMeta(patch.ops[k]!));
          try {
            applyOps(currentGraph, trial, options);
            accepted.push(idx);
          } catch (singleErr) {
            const reason =
              singleErr instanceof ApplyError
                ? (singleErr.diagnostics[0]?.message ?? singleErr.message)
                : String(singleErr);
            const ev = evaluatedOps[idx]!;
            ev.conflicted = true;
            ev.conflictReason = `与当前图谱语义冲突：${reason}`;
            ev.defaultSelected = false;
            for (const depIdx of getTransitiveDependents(patch.ops, idx)) {
              const depEv = evaluatedOps[depIdx];
              if (depEv && !depEv.conflicted) {
                depEv.conflicted = true;
                depEv.conflictReason = `依赖的操作 #${idx + 1} 存在冲突`;
                depEv.defaultSelected = false;
              }
            }
          }
        }
      }
    }
  }

  const defaultSelectedIndices = evaluatedOps
    .filter((o) => o.defaultSelected)
    .map((o) => o.index);
  const conflictCount = evaluatedOps.filter((o) => o.conflicted).length;

  return {
    patchId: patch.id,
    graphId: patch.graphId,
    baseHash: patch.baseHash,
    currentHash,
    isStale,
    hasConflicts: conflictCount > 0,
    conflictCount,
    ops: evaluatedOps,
    defaultSelectedIndices,
    summary: summarizeOps(patch.ops)
  };
}

/**
 * Applies a selected subset of ops from a PatchFile against `currentGraph`.
 * Always re-runs full semantic validation via `applyOps`.
 */
export function applySelectedPatchOps(
  currentGraph: Graph,
  patch: Pick<PatchFile, "ops">,
  selectedIndices: ReadonlyArray<number>,
  options?: ApplyOptions
): ApplyResult {
  const uniqueSorted = [...new Set(selectedIndices)]
    .filter((idx) => idx >= 0 && idx < patch.ops.length)
    .sort((a, b) => a - b);
  const cleanOps = uniqueSorted.map((idx) => stripPatchOpMeta(patch.ops[idx]!));
  return applyOps(currentGraph, cleanOps, options);
}

/**
 * Computes diff highlight metadata (added/modified node ids, status transitions,
 * added edge keys) for Phase 2 Patch Review canvas overlay (PRD §7.6).
 */
export interface PatchPreviewHighlights {
  addedNodeIds: Set<string>;
  modifiedNodeIds: Set<string>;
  removedNodeIds: Set<string>;
  addedEdgeKeys: Set<string>;
  nodeStatusTransitions: Map<string, { before: string; after: string }>;
  nodeFieldChanges: Map<string, Array<{ field: string; before: string; after: string }>>;
}

export function computePatchPreviewHighlights(
  baseGraph: Graph,
  previewGraph: Graph,
  selectedOps: ReadonlyArray<PatchOp>
): PatchPreviewHighlights {
  const baseDerived = deriveGraph(baseGraph);
  const previewDerived = deriveGraph(previewGraph);

  const addedNodeIds = new Set<string>();
  const modifiedNodeIds = new Set<string>();
  const removedNodeIds = new Set<string>();
  const addedEdgeKeys = new Set<string>();
  const nodeStatusTransitions = new Map<string, { before: string; after: string }>();
  const nodeFieldChanges = new Map<
    string,
    Array<{ field: string; before: string; after: string }>
  >();

  for (const op of selectedOps) {
    if (op.op === "add_node") {
      addedNodeIds.add(op.node.id);
    } else if (op.op === "remove_node") {
      removedNodeIds.add(op.id);
    } else if (op.op === "add_edge") {
      addedEdgeKeys.add(edgeKey(op.source, op.target));
    } else if (op.op === "update_node") {
      if (!addedNodeIds.has(op.id)) {
        modifiedNodeIds.add(op.id);
      }
      const prevNode = baseDerived.nodeMap.get(op.id);
      const nextNode = previewDerived.nodeMap.get(op.id);
      if (prevNode && nextNode) {
        const changes = nodeFieldChanges.get(op.id) ?? [];
        const touchedFields = new Set<string>([
          ...Object.keys(op.set ?? {}),
          ...(op.unset ?? [])
        ]);
        for (const field of touchedFields) {
          if (field === "after") continue;
          const bVal = (prevNode as Record<string, unknown>)[field];
          const aVal = (nextNode as Record<string, unknown>)[field];
          if (!deepEqual(bVal, aVal)) {
            changes.push({
              field,
              before: formatShortValue(bVal),
              after: formatShortValue(aVal)
            });
          }
        }
        if (changes.length > 0) {
          nodeFieldChanges.set(op.id, changes);
        }
      }
    }
  }

  for (const nodeId of modifiedNodeIds) {
    const prevEff = baseDerived.effectiveStatus.get(nodeId);
    const nextEff = previewDerived.effectiveStatus.get(nodeId);
    if (prevEff && nextEff && prevEff !== nextEff) {
      nodeStatusTransitions.set(nodeId, { before: prevEff, after: nextEff });
    }
  }

  return {
    addedNodeIds,
    modifiedNodeIds,
    removedNodeIds,
    addedEdgeKeys,
    nodeStatusTransitions,
    nodeFieldChanges
  };
}
