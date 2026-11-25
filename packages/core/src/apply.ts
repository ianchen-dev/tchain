import { canonicalizeGraph } from "./canonicalize.js";
import { edgeKey } from "./derive.js";
import {
  OpSchema,
  type Diagnostic,
  type Edge,
  type Graph,
  type MutableNodeField,
  type Node,
  type NodePatchSet,
  type Op
} from "./schema.js";
import { validateGraph, type ValidateOptions } from "./validate.js";

export class ApplyError extends Error {
  public readonly diagnostics: Diagnostic[];

  constructor(message: string, diagnostics: Diagnostic[]) {
    super(message);
    this.name = "ApplyError";
    this.diagnostics = diagnostics;
  }
}

export interface ApplyResult {
  graph: Graph;
  inverse: Op[];
  warnings: Diagnostic[];
}

function cloneGraph(graph: Graph): Graph {
  return structuredClone(graph);
}

function getSiblings(nodes: Node[], parentId: string | undefined): Node[] {
  return nodes.filter((n) => n.parentId === parentId);
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

/**
 * Computes insertion index in `nodes` for placing a node (or subtree) under `parentId`
 * according to `after`:
 * - `after === null`: before all existing siblings under `parentId` (immediately after parent, or 0 for root)
 * - `after === undefined`: after the last sibling's subtree under `parentId`
 * - `after === string`: immediately after `after`'s subtree
 */
function findInsertionIndex(
  nodes: Node[],
  parentId: string | undefined,
  after: string | null | undefined
): number {
  if (after === null) {
    const siblings = getSiblings(nodes, parentId);
    if (siblings.length > 0) {
      return nodes.findIndex((n) => n.id === siblings[0]!.id);
    }
    if (parentId !== undefined) {
      const parentIdx = nodes.findIndex((n) => n.id === parentId);
      if (parentIdx >= 0) return parentIdx + 1;
    }
    return 0;
  }

  if (typeof after === "string") {
    const subtree = collectSubtreeIds(nodes, after);
    let lastIdx = -1;
    for (let i = 0; i < nodes.length; i++) {
      if (subtree.has(nodes[i]!.id)) lastIdx = i;
    }
    return lastIdx >= 0 ? lastIdx + 1 : nodes.length;
  }

  // after === undefined: append after last sibling's subtree (or after parentId if no siblings)
  const siblings = getSiblings(nodes, parentId);
  if (siblings.length > 0) {
    const lastSibling = siblings[siblings.length - 1]!;
    const subtree = collectSubtreeIds(nodes, lastSibling.id);
    let lastIdx = -1;
    for (let i = 0; i < nodes.length; i++) {
      if (subtree.has(nodes[i]!.id)) lastIdx = i;
    }
    if (lastIdx >= 0) return lastIdx + 1;
  }
  if (parentId !== undefined) {
    const parentIdx = nodes.findIndex((n) => n.id === parentId);
    if (parentIdx >= 0) return parentIdx + 1;
  }
  return nodes.length;
}

function moveSubtreeInArray(
  nodes: Node[],
  rootId: string,
  newParentId: string | undefined,
  after: string | null | undefined
): Node[] {
  const subtreeIds = collectSubtreeIds(nodes, rootId);
  const extracted = nodes.filter((n) => subtreeIds.has(n.id));
  const remaining = nodes.filter((n) => !subtreeIds.has(n.id));
  const insertAt = findInsertionIndex(remaining, newParentId, after);
  return [
    ...remaining.slice(0, insertAt),
    ...extracted,
    ...remaining.slice(insertAt)
  ];
}

const MUTABLE_FIELDS: MutableNodeField[] = [
  "parentId",
  "type",
  "title",
  "status",
  "statusNote",
  "description",
  "conclusion",
  "metrics",
  "attachments",
  "report"
];

export function applyOps(
  baseGraph: Graph,
  ops: Op[],
  options?: ValidateOptions
): ApplyResult {
  const graph = cloneGraph(baseGraph);
  const inverseSteps: Op[][] = [];

  for (let opIndex = 0; opIndex < ops.length; opIndex++) {
    const rawOp = ops[opIndex];
    const parsedOp = OpSchema.safeParse(rawOp);
    if (!parsedOp.success) {
      const diags: Diagnostic[] = parsedOp.error.issues.map((issue) => ({
        level: "error",
        opIndex,
        path: `ops[${opIndex}]${issue.path.length ? "." + issue.path.join(".") : ""}`,
        code: "OP_SCHEMA_ERROR",
        message: issue.message
      }));
      throw new ApplyError(`Invalid op at index ${opIndex}`, diags);
    }

    const op = parsedOp.data;

    if (op.op === "add_node") {
      if (graph.nodes.some((n) => n.id === op.node.id)) {
        throw new ApplyError(`Duplicate node id: ${op.node.id}`, [
          {
            level: "error",
            opIndex,
            path: `ops[${opIndex}].node.id`,
            code: "DUPLICATE_NODE_ID",
            message: `节点 id 已存在：${op.node.id}`,
            hint: "请更换一个新的节点 id"
          }
        ]);
      }

      const newNode = structuredClone(op.node);
      if (newNode.parentId !== undefined && !graph.nodes.some((n) => n.id === newNode.parentId)) {
        throw new ApplyError(`Missing parentId: ${newNode.parentId}`, [
          {
            level: "error",
            opIndex,
            path: `ops[${opIndex}].node.parentId`,
            code: "MISSING_PARENT",
            message: `父节点不存在：${newNode.parentId}`,
            hint: "请先添加父节点或指定已存在的 parentId"
          }
        ]);
      }

      if (typeof op.after === "string") {
        const afterNode = graph.nodes.find((n) => n.id === op.after);
        if (!afterNode) {
          throw new ApplyError(`Missing after sibling: ${op.after}`, [
            {
              level: "error",
              opIndex,
              path: `ops[${opIndex}].after`,
              code: "MISSING_AFTER_NODE",
              message: `after 指向的兄弟节点不存在：${op.after}`
            }
          ]);
        }
        if (afterNode.parentId !== newNode.parentId) {
          throw new ApplyError(`after node is not a sibling`, [
            {
              level: "error",
              opIndex,
              path: `ops[${opIndex}].after`,
              code: "AFTER_NOT_SIBLING",
              message: `after 节点 ${op.after} 与新节点 ${newNode.id} 不在同一父容器下`
            }
          ]);
        }
      }

      const insertAt = findInsertionIndex(graph.nodes, newNode.parentId, op.after);
      graph.nodes.splice(insertAt, 0, newNode);
      inverseSteps.push([{ op: "remove_node", id: newNode.id, cascade: false }]);
      continue;
    }

    if (op.op === "update_node") {
      const idx = graph.nodes.findIndex((n) => n.id === op.id);
      if (idx < 0) {
        throw new ApplyError(`Node not found: ${op.id}`, [
          {
            level: "error",
            opIndex,
            path: `ops[${opIndex}].id`,
            code: "NODE_NOT_FOUND",
            message: `节点不存在：${op.id}`
          }
        ]);
      }

      const node = graph.nodes[idx]!;
      const beforeSnapshot = structuredClone(node);
      const oldParentId = node.parentId;
      const oldPrevSibling = findPrevSiblingId(graph.nodes, node.id, oldParentId);

      const invSet: NodePatchSet = {};
      const invUnset: MutableNodeField[] = [];

      const setObj = op.set ?? {};
      const unsetFields = new Set<MutableNodeField>(op.unset ?? []);

      // Handle parentId change via set.parentId or unset
      let nextParentId = oldParentId;
      let parentChanged = false;
      if (unsetFields.has("parentId") || setObj.parentId === null) {
        nextParentId = undefined;
        parentChanged = oldParentId !== undefined;
      } else if (setObj.parentId !== undefined) {
        nextParentId = setObj.parentId;
        parentChanged = oldParentId !== nextParentId;
      }

      if (parentChanged && nextParentId !== undefined) {
        if (!graph.nodes.some((n) => n.id === nextParentId)) {
          throw new ApplyError(`Missing target parentId: ${nextParentId}`, [
            {
              level: "error",
              opIndex,
              path: `ops[${opIndex}].set.parentId`,
              code: "MISSING_PARENT",
              message: `目标父节点不存在：${nextParentId}`
            }
          ]);
        }
        const subtree = collectSubtreeIds(graph.nodes, node.id);
        if (subtree.has(nextParentId)) {
          throw new ApplyError(`parentId cycle`, [
            {
              level: "error",
              opIndex,
              path: `ops[${opIndex}].set.parentId`,
              code: "PARENT_CYCLE",
              message: `无法将 ${node.id} 移动到其自身或后代 ${nextParentId} 下`
            }
          ]);
        }
      }

      const hasAfterMove = setObj.after !== undefined;
      if (typeof setObj.after === "string") {
        if (setObj.after === node.id) {
          throw new ApplyError(`after cannot reference self`, [
            {
              level: "error",
              opIndex,
              path: `ops[${opIndex}].set.after`,
              code: "INVALID_AFTER_SELF",
              message: `after 不能指向节点自身 ${node.id}`
            }
          ]);
        }
        const afterNode = graph.nodes.find((n) => n.id === setObj.after);
        if (!afterNode || afterNode.parentId !== nextParentId) {
          throw new ApplyError(`Invalid after sibling: ${setObj.after}`, [
            {
              level: "error",
              opIndex,
              path: `ops[${opIndex}].set.after`,
              code: "AFTER_NOT_SIBLING",
              message: `after 节点 ${setObj.after} 不存在或不在目标父容器下`
            }
          ]);
        }
      }

      // Record inverse for all touched fields
      for (const field of MUTABLE_FIELDS) {
        const isUnset = unsetFields.has(field) || (field === "parentId" && setObj.parentId === null);
        const isSet =
          !isUnset &&
          Object.prototype.hasOwnProperty.call(setObj, field) &&
          (setObj as Record<string, unknown>)[field] !== undefined;

        if (!isUnset && !isSet) continue;

        const prevVal = (beforeSnapshot as Record<string, unknown>)[field];
        if (prevVal === undefined) {
          invUnset.push(field);
        } else {
          (invSet as Record<string, unknown>)[field] = prevVal;
        }

        if (isUnset) {
          delete (node as Record<string, unknown>)[field];
        } else {
          (node as Record<string, unknown>)[field] = structuredClone(
            (setObj as Record<string, unknown>)[field]
          );
        }
      }

      // Reorder array if parentChanged or after specified
      if (parentChanged || hasAfterMove) {
        const targetAfter = hasAfterMove ? setObj.after : undefined;
        graph.nodes = moveSubtreeInArray(graph.nodes, node.id, nextParentId, targetAfter);
        invSet.after = oldPrevSibling;
      }

      const invOp: Op = {
        op: "update_node",
        id: node.id,
        ...(Object.keys(invSet).length > 0 ? { set: invSet } : {}),
        ...(invUnset.length > 0 ? { unset: invUnset } : {})
      };
      inverseSteps.push([invOp]);
      continue;
    }

    if (op.op === "remove_node") {
      const idx = graph.nodes.findIndex((n) => n.id === op.id);
      if (idx < 0) {
        throw new ApplyError(`Node not found: ${op.id}`, [
          {
            level: "error",
            opIndex,
            path: `ops[${opIndex}].id`,
            code: "NODE_NOT_FOUND",
            message: `无法删除不存在的节点：${op.id}`
          }
        ]);
      }

      const target = structuredClone(graph.nodes[idx]!);
      const prevSibling = findPrevSiblingId(graph.nodes, target.id, target.parentId);

      if (op.cascade) {
        const subtreeIds = collectSubtreeIds(graph.nodes, target.id);
        const removedNodes = graph.nodes
          .filter((n) => subtreeIds.has(n.id))
          .map((n) => structuredClone(n));
        const removedEdges = graph.edges
          .filter((e) => subtreeIds.has(e.source) || subtreeIds.has(e.target))
          .map((e) => structuredClone(e));

        graph.nodes = graph.nodes.filter((n) => !subtreeIds.has(n.id));
        graph.edges = graph.edges.filter(
          (e) => !subtreeIds.has(e.source) && !subtreeIds.has(e.target)
        );

        // Inverse: re-add root at exact sibling slot, then descendants in preorder, then edges
        const invOps: Op[] = [];
        for (const rn of removedNodes) {
          if (rn.id === target.id) {
            invOps.push({ op: "add_node", node: rn, after: prevSibling });
          } else {
            invOps.push({ op: "add_node", node: rn });
          }
        }
        for (const re of removedEdges) {
          invOps.push({
            op: "add_edge",
            source: re.source,
            target: re.target,
            ...(re.kind ? { kind: re.kind } : {})
          });
        }
        inverseSteps.push(invOps);
      } else {
        // Non-cascading dissolve: direct children keep their exact positions and inherit target.parentId
        const directChildren = graph.nodes.filter((n) => n.parentId === target.id);
        const directChildIds = directChildren.map((c) => c.id);
        const removedEdges = graph.edges
          .filter((e) => e.source === target.id || e.target === target.id)
          .map((e) => structuredClone(e));

        for (const child of directChildren) {
          if (target.parentId === undefined) {
            delete child.parentId;
          } else {
            child.parentId = target.parentId;
          }
        }
        graph.nodes.splice(idx, 1);
        graph.edges = graph.edges.filter(
          (e) => e.source !== target.id && e.target !== target.id
        );

        const invOps: Op[] = [{ op: "add_node", node: target, after: prevSibling }];
        for (let cIdx = 0; cIdx < directChildIds.length; cIdx++) {
          const cid = directChildIds[cIdx]!;
          const afterChild = cIdx === 0 ? null : directChildIds[cIdx - 1]!;
          invOps.push({
            op: "update_node",
            id: cid,
            set: { parentId: target.id, after: afterChild }
          });
        }
        for (const re of removedEdges) {
          invOps.push({
            op: "add_edge",
            source: re.source,
            target: re.target,
            ...(re.kind ? { kind: re.kind } : {})
          });
        }
        inverseSteps.push(invOps);
      }
      continue;
    }

    if (op.op === "add_edge") {
      const existingIdx = graph.edges.findIndex(
        (e) => e.source === op.source && e.target === op.target
      );
      const nextEdge: Edge = {
        source: op.source,
        target: op.target,
        ...(op.kind && op.kind !== "flow" ? { kind: op.kind } : {})
      };

      if (existingIdx >= 0) {
        const prevEdge = structuredClone(graph.edges[existingIdx]!);
        graph.edges[existingIdx] = nextEdge;
        inverseSteps.push([
          {
            op: "add_edge",
            source: prevEdge.source,
            target: prevEdge.target,
            ...(prevEdge.kind ? { kind: prevEdge.kind } : { kind: "flow" })
          }
        ]);
      } else {
        graph.edges.push(nextEdge);
        inverseSteps.push([
          {
            op: "remove_edge",
            source: op.source,
            target: op.target
          }
        ]);
      }
      continue;
    }

    if (op.op === "remove_edge") {
      const existingIdx = graph.edges.findIndex(
        (e) => e.source === op.source && e.target === op.target
      );
      if (existingIdx < 0) {
        throw new ApplyError(`Edge not found: ${edgeKey(op.source, op.target)}`, [
          {
            level: "error",
            opIndex,
            path: `ops[${opIndex}]`,
            code: "EDGE_NOT_FOUND",
            message: `边不存在：${op.source} → ${op.target}`
          }
        ]);
      }
      const prevEdge = structuredClone(graph.edges[existingIdx]!);
      graph.edges.splice(existingIdx, 1);
      inverseSteps.push([
        {
          op: "add_edge",
          source: prevEdge.source,
          target: prevEdge.target,
          ...(prevEdge.kind ? { kind: prevEdge.kind } : {})
        }
      ]);
      continue;
    }
  }

  const canonical = canonicalizeGraph(graph);
  const validation = validateGraph(canonical, options);
  if (!validation.ok) {
    throw new ApplyError(
      `Resulting graph failed validation (${validation.errors.length} error(s))`,
      validation.errors
    );
  }

  const inverse: Op[] = [];
  for (let i = inverseSteps.length - 1; i >= 0; i--) {
    inverse.push(...inverseSteps[i]!);
  }

  return {
    graph: canonical,
    inverse,
    warnings: validation.warnings
  };
}
