import type { Attachment, Edge, Graph, Metric, Node } from "./schema.js";
import { sha256Hex } from "./sha256.js";

export function normalizeIsoTimestamp(raw: string): string {
  const trimmed = raw.trim();
  const ms = Date.parse(trimmed);
  if (Number.isFinite(ms)) {
    return new Date(ms).toISOString();
  }
  return trimmed;
}

export function normalizeAttachmentPath(rawPath: string): string {
  let normalized = rawPath.replace(/\\/g, "/");
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep original if percent-encoding is malformed; validate will check further.
  }
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function canonicalizeMetrics(metrics: Metric[] | undefined): Metric[] | undefined {
  if (!metrics || metrics.length === 0) return undefined;
  const cleaned = metrics
    .map((m) => {
      const out: Metric = {
        label: m.label,
        value: m.value
      };
      if (m.tone !== undefined) out.tone = m.tone;
      return out;
    })
    .filter((m) => m.label.length > 0 && m.value.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

function canonicalizeAttachments(
  attachments: Attachment[] | undefined
): Attachment[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  const cleaned = attachments.map((att) => {
    const out: Attachment = {};
    if (att.path !== undefined && att.path !== "") {
      out.path = normalizeAttachmentPath(att.path);
    }
    if (att.url !== undefined && att.url !== "") {
      out.url = att.url;
    }
    if (att.title !== undefined && att.title !== "") {
      out.title = att.title;
    }
    if (att.note !== undefined && att.note !== "") {
      out.note = att.note;
    }
    return out;
  });
  return cleaned.length > 0 ? cleaned : undefined;
}

export function canonicalizeNode(node: Node): Node {
  // Preserve exact canonical key order:
  // id, parentId, type, title, status, statusNote, description, conclusion, metrics, attachments, report, createdAt, updatedAt, statusChangedAt
  const ordered: Record<string, unknown> = {
    id: node.id
  };
  if (node.parentId !== undefined && node.parentId !== "") {
    ordered.parentId = node.parentId;
  }
  ordered.type = node.type;
  ordered.title = node.title;
  if (node.status !== undefined) {
    ordered.status = node.status;
  }
  if (node.statusNote !== undefined && node.statusNote !== "") {
    ordered.statusNote = node.statusNote;
  }
  if (node.description !== undefined && node.description !== "") {
    ordered.description = node.description;
  }
  if (node.conclusion !== undefined && node.conclusion !== "") {
    ordered.conclusion = node.conclusion;
  }
  const metrics = canonicalizeMetrics(node.metrics);
  if (metrics !== undefined) {
    ordered.metrics = metrics;
  }
  const attachments = canonicalizeAttachments(node.attachments);
  if (attachments !== undefined) {
    ordered.attachments = attachments;
  }
  if (node.report !== undefined) {
    ordered.report = node.report;
  }
  if (node.createdAt !== undefined && node.createdAt.trim() !== "") {
    ordered.createdAt = normalizeIsoTimestamp(node.createdAt);
  }
  if (node.updatedAt !== undefined && node.updatedAt.trim() !== "") {
    ordered.updatedAt = normalizeIsoTimestamp(node.updatedAt);
  }
  if (node.statusChangedAt !== undefined && node.statusChangedAt.trim() !== "") {
    ordered.statusChangedAt = normalizeIsoTimestamp(node.statusChangedAt);
  }

  return ordered as unknown as Node;
}

function canonicalizeEdge(edge: Edge): Edge {
  const ordered: Edge = {
    source: edge.source,
    target: edge.target
  };
  if (edge.kind !== undefined && edge.kind !== "flow") {
    ordered.kind = edge.kind;
  }
  return ordered;
}

/**
 * Produces a canonical deep copy of `graph`:
 * - Fixed property ordering at root, node, and edge levels
 * - Omits empty strings, empty arrays, undefined fields, and default edge kind ("flow")
 * - Preserves `nodes` model order (sibling relative order intact)
 * - Sorts `edges` by source position in `nodes`, then target position in `nodes`
 */
export function canonicalizeGraph(graph: Graph): Graph {
  const nodes = graph.nodes.map(canonicalizeNode);
  const nodeIndex = new Map<string, number>();
  nodes.forEach((n, idx) => nodeIndex.set(n.id, idx));

  const edges = graph.edges.map(canonicalizeEdge).sort((a, b) => {
    const aSrc = nodeIndex.get(a.source) ?? Number.MAX_SAFE_INTEGER;
    const bSrc = nodeIndex.get(b.source) ?? Number.MAX_SAFE_INTEGER;
    if (aSrc !== bSrc) return aSrc - bSrc;
    const aTgt = nodeIndex.get(a.target) ?? Number.MAX_SAFE_INTEGER;
    const bTgt = nodeIndex.get(b.target) ?? Number.MAX_SAFE_INTEGER;
    if (aTgt !== bTgt) return aTgt - bTgt;
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    return a.target.localeCompare(b.target);
  });

  const ordered: Record<string, unknown> = {};
  if (graph.$schema !== undefined && graph.$schema !== "") {
    ordered.$schema = graph.$schema;
  }
  ordered.schemaVersion = graph.schemaVersion;
  ordered.id = graph.id;
  ordered.title = graph.title;
  if (graph.layout?.direction !== undefined) {
    ordered.layout = { direction: graph.layout.direction };
  }
  ordered.nodes = nodes;
  ordered.edges = edges;

  return ordered as unknown as Graph;
}

export function serializeGraph(graph: Graph): string {
  const canonical = canonicalizeGraph(graph);
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export function hashGraph(graph: Graph): string {
  return `sha256:${sha256Hex(serializeGraph(graph))}`;
}
