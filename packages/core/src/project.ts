import { deriveGraph, type DerivedGraph } from "./derive.js";
import { computeFocus, type FocusResult } from "./focus.js";
import type { Edge, EdgeKind, Graph, Node, NodeType, Status } from "./schema.js";
import { sha256Hex } from "./sha256.js";

export type ViewMode = "workspace" | "focus" | "report";

export type FocusRole = "active" | "path" | "next" | "none";

export interface ViewState {
  view: ViewMode;
  drillRoot?: string | null;
  collapsed?: readonly string[] | ReadonlySet<string>;
  showDiscarded?: boolean;
  showParked?: boolean;
  focusHideDimmed?: boolean;
  focusOverride?: readonly string[];
}

export interface RenderNode {
  id: string;
  parentId?: string;
  node: Node;
  isContainer: boolean;
  isCollapsed: boolean;
  depth: number;
  resolvedStatus: Status;
  effectiveStatus: Status;
  inheritedStatusFrom?: string;
  dimmed: boolean;
  focusRole: FocusRole;
  childCount: number;
  descendantCount: number;
  statusSummary: Partial<Record<Status, number>>;
}

export interface ExternalStub {
  id: string;
  direction: "in" | "out";
  targetNodeId: string;
  title: string;
  type: NodeType;
  effectiveStatus: Status;
  parentChain: Array<{ id: string; title: string }>;
}

export interface CapsuleItem {
  id: string;
  title: string;
  type: NodeType;
  status: Status;
  statusNote?: string;
  descendantCount: number;
}

export interface RenderCapsule {
  id: string;
  parentId?: string;
  bucket: "discarded" | "parked";
  label: string;
  count: number;
  items: CapsuleItem[];
}

export interface RenderEdgeOrigin {
  source: string;
  target: string;
  kind: EdgeKind;
}

export interface RenderEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  lifted: boolean;
  bypassedCount: number;
  count: number;
  isCrossHierarchy: boolean;
  isExternal: boolean;
  isCapsuleEdge: boolean;
  targetEffectiveStatus?: Status;
  originalEdges: RenderEdgeOrigin[];
}

export interface BreadcrumbItem {
  id: string | null;
  title: string;
}

export interface RenderGraph {
  graphId: string;
  title: string;
  view: ViewMode;
  direction: "DOWN" | "RIGHT";
  drillRoot: string | null;
  breadcrumbs: BreadcrumbItem[];
  nodes: RenderNode[];
  edges: RenderEdge[];
  externalStubs: ExternalStub[];
  capsules: RenderCapsule[];
  focus: FocusResult;
  renderHash: string;
}

const REPORT_DEFAULT_VISIBLE_TYPES = new Set<NodeType>([
  "goal",
  "decision",
  "option",
  "milestone"
]);

const EXECUTIVE_STRUCTURE_TYPES = new Set<NodeType>(["goal", "decision", "option"]);

function isReportVisibleNode(node: Node): boolean {
  if (node.report === true) return true;
  if (node.report === false) return false;
  return REPORT_DEFAULT_VISIBLE_TYPES.has(node.type);
}

/**
 * Computes sensible default collapsed container IDs for a given view mode.
 * - All views: collapse done/parked/discarded containers, keeping their summary visible.
 * - `report`: collapses detail containers (containers explicitly flagged `report: true`,
 *   or containers whose descendants contain no `goal`/`decision`/`option` structural nodes)
 *   so executive view highlights high-level cards (`conclusion` & `metrics`) while keeping
 *   main decision/option framing open.
 */
export function getDefaultCollapsed(graph: Graph, view: ViewMode): string[] {
  const derived = deriveGraph(graph);
  const collapsed: string[] = [];
  const collapsedSet = new Set<string>();

  for (const node of graph.nodes) {
    if (!derived.isContainer.has(node.id)) continue;
    const eff = derived.effectiveStatus.get(node.id);

    // Do not also collapse nested containers whose ancestor is already collapsed,
    // so drilling into or expanding the outer container immediately reveals its full subgraph.
    const ancestors = derived.ancestorsMap.get(node.id) ?? [];
    if (ancestors.some((a) => collapsedSet.has(a))) continue;

    if (
      eff === "done" || eff === "parked" || eff === "discarded" ||
      (view === "report" && node.report === true)
    ) {
      collapsed.push(node.id);
      collapsedSet.add(node.id);
      continue;
    }

    if (view !== "report") continue;

    const descendants = derived.descendantsMap.get(node.id) ?? new Set<string>();
    let hasExecutiveChild = false;
    for (const did of descendants) {
      const dNode = derived.nodeMap.get(did);
      const dEff = derived.effectiveStatus.get(did);
      if (
        dNode &&
        dEff !== "parked" &&
        dEff !== "discarded" &&
        EXECUTIVE_STRUCTURE_TYPES.has(dNode.type)
      ) {
        hasExecutiveChild = true;
        break;
      }
    }
    if (!hasExecutiveChild) {
      collapsed.push(node.id);
      collapsedSet.add(node.id);
    }
  }

  // Graph storage order need not put parents before children.
  return collapsed.filter((id) =>
    !(derived.ancestorsMap.get(id) ?? []).some((ancestor) => collapsedSet.has(ancestor))
  );
}

function buildStatusSummary(
  containerId: string,
  derived: DerivedGraph
): Partial<Record<Status, number>> {
  const counts: Partial<Record<Status, number>> = {};
  const descendants = derived.descendantsMap.get(containerId);
  if (!descendants) return counts;
  for (const did of descendants) {
    if (derived.isContainer.has(did)) continue;
    const eff = derived.effectiveStatus.get(did) ?? "todo";
    counts[eff] = (counts[eff] ?? 0) + 1;
  }
  return counts;
}

function buildParentChain(
  nodeId: string,
  derived: DerivedGraph
): Array<{ id: string; title: string }> {
  const ancestors = derived.ancestorsMap.get(nodeId) ?? [];
  return [...ancestors].reverse().map((aid) => ({
    id: aid,
    title: derived.nodeMap.get(aid)?.title ?? aid
  }));
}

function getEffectiveKind(edge: Edge): EdgeKind {
  return edge.kind ?? "flow";
}

function normalizeCollapsedSet(
  collapsed: readonly string[] | ReadonlySet<string> | undefined
): Set<string> {
  if (!collapsed) return new Set<string>();
  return new Set<string>(collapsed);
}

/**
 * Pure projection pipeline per PRD §6.1:
 * Graph
 *  → derive
 *  → visibility (workspace / focus / report + showDiscarded / showParked)
 *  → ancestorClose
 *  → edgeBypass (DAG BFS through view-hidden non-discarded/non-parked nodes)
 *  → scope (drillRoot subtree + collapsed containers)
 *  → edgeLift (lift folded endpoints to nearest rendered ancestor; drop self-loops & ancestor edges)
 *  → externalStubs (edges crossing drillRoot boundary)
 *  → capsules (discarded / parked collapsed pills in visible parents)
 *  → dedupe (merge parallel edges with counts & origin refs)
 *  → RenderGraph (+ deterministic renderHash)
 */
export function projectGraph(graph: Graph, viewState: ViewState): RenderGraph {
  const derived = deriveGraph(graph);
  const view = viewState.view;

  // Validate drillRoot: must exist and be a container
  let drillRoot: string | null = null;
  if (
    viewState.drillRoot &&
    derived.nodeMap.has(viewState.drillRoot) &&
    derived.isContainer.has(viewState.drillRoot)
  ) {
    drillRoot = viewState.drillRoot;
  }

  const drillDescendants = drillRoot
    ? (derived.descendantsMap.get(drillRoot) ?? new Set<string>())
    : null;
  const drillAncestorsAndSelf = new Set<string>();
  if (drillRoot) {
    drillAncestorsAndSelf.add(drillRoot);
    for (const anc of derived.ancestorsMap.get(drillRoot) ?? []) {
      drillAncestorsAndSelf.add(anc);
    }
  }

  const showDiscarded =
    viewState.showDiscarded !== undefined ? viewState.showDiscarded : view !== "report";
  const showParked =
    viewState.showParked !== undefined ? viewState.showParked : view !== "report";
  const focusHideDimmed = Boolean(viewState.focusHideDimmed);
  const collapsedSet = normalizeCollapsedSet(viewState.collapsed);
  // Never collapse the current drillRoot itself
  if (drillRoot) {
    collapsedSet.delete(drillRoot);
  }

  // Compute focus result
  const computedFocus = computeFocus(graph);
  const activeSet = new Set<string>(computedFocus.activeIds);
  const pathSet = new Set<string>(computedFocus.pathIds);
  const nextSet = new Set<string>(computedFocus.nextIds);
  const focusSet = new Set<string>(
    viewState.focusOverride && viewState.focusOverride.length > 0
      ? viewState.focusOverride
      : computedFocus.focusIds
  );
  // Ensure ancestors of focus nodes are also considered non-dimmed in focus view
  const focusNonDimmedSet = new Set<string>(focusSet);
  for (const fid of focusSet) {
    for (const anc of derived.ancestorsMap.get(fid) ?? []) {
      focusNonDimmedSet.add(anc);
    }
  }

  // Step 1: Identify nodes excluded by discarded / parked subtree filters.
  // A container explicitly or effectively marked discarded/parked hides its whole subtree
  // (unless we have explicitly drilled into that container or one of its descendants).
  const hiddenByStatusReason = new Map<string, "discarded" | "parked">();
  const topHiddenStatusRoots = new Map<string, "discarded" | "parked">();

  const markStatusHidden = (nodeId: string, inheritedBucket?: "discarded" | "parked"): void => {
    const eff = derived.effectiveStatus.get(nodeId) ?? "todo";
    let bucket: "discarded" | "parked" | undefined = inheritedBucket;

    if (!bucket && !drillAncestorsAndSelf.has(nodeId)) {
      if (!showDiscarded && eff === "discarded") {
        bucket = "discarded";
        topHiddenStatusRoots.set(nodeId, "discarded");
      } else if (!showParked && eff === "parked") {
        bucket = "parked";
        topHiddenStatusRoots.set(nodeId, "parked");
      }
    }

    if (bucket) {
      hiddenByStatusReason.set(nodeId, bucket);
    }

    for (const childId of derived.childrenMap.get(nodeId) ?? []) {
      markStatusHidden(childId, bucket);
    }
  };

  for (const rootId of derived.childrenMap.get(null) ?? []) {
    markStatusHidden(rootId, undefined);
  }

  // Step 2: View visibility predicate (excluding status-hidden subtrees)
  const visibleBeforeClose = new Set<string>();
  for (const node of graph.nodes) {
    if (hiddenByStatusReason.has(node.id)) continue;

    if (view === "workspace") {
      visibleBeforeClose.add(node.id);
    } else if (view === "focus") {
      if (!focusHideDimmed || focusNonDimmedSet.has(node.id)) {
        visibleBeforeClose.add(node.id);
      }
    } else {
      // report view
      // When drilled into a container during presentation (PRD §6.4),
      // reveal the complete derivation subgraph inside drillRoot!
      if (drillRoot && (node.id === drillRoot || drillDescendants?.has(node.id))) {
        if (node.report !== false) {
          visibleBeforeClose.add(node.id);
        }
      } else if (isReportVisibleNode(node)) {
        visibleBeforeClose.add(node.id);
      }
    }
  }

  // Step 3: ancestorClose — every visible node forces its ancestors visible
  const visibleBeforeCollapse = new Set<string>(visibleBeforeClose);
  for (const id of visibleBeforeClose) {
    for (const anc of derived.ancestorsMap.get(id) ?? []) {
      if (!hiddenByStatusReason.has(anc)) {
        visibleBeforeCollapse.add(anc);
      }
    }
  }

  // Nodes hidden strictly by view predicate (e.g., task in report mode, dimmed in focus-hide)
  // are eligible for edgeBypass. Parked/discarded hidden nodes are NOT bypassed through.
  const bypassableHidden = new Set<string>();
  for (const node of graph.nodes) {
    if (!visibleBeforeCollapse.has(node.id) && !hiddenByStatusReason.has(node.id)) {
      bypassableHidden.add(node.id);
    }
  }

  // Step 4: edgeBypass — build effective edges over visibleBeforeCollapse
  interface IntermediateEdge {
    source: string;
    target: string;
    kind: EdgeKind;
    bypassedCount: number;
    origins: RenderEdgeOrigin[];
  }

  const intermediateEdges: IntermediateEdge[] = [];

  // 4a. Direct edges where both endpoints are in visibleBeforeCollapse
  for (const edge of graph.edges) {
    if (visibleBeforeCollapse.has(edge.source) && visibleBeforeCollapse.has(edge.target)) {
      const kind = getEffectiveKind(edge);
      intermediateEdges.push({
        source: edge.source,
        target: edge.target,
        kind,
        bypassedCount: 0,
        origins: [{ source: edge.source, target: edge.target, kind }]
      });
    }
  }

  // 4b. BFS through bypassableHidden along DAG edges (flow / depends_on only)
  if (bypassableHidden.size > 0) {
    const isAncestorOrDescendant = (a: string, b: string): boolean => {
      return (
        (derived.descendantsMap.get(a)?.has(b) ?? false) ||
        (derived.descendantsMap.get(b)?.has(a) ?? false)
      );
    };

    for (const startId of visibleBeforeCollapse) {
      const directOut = derived.dagOutgoing.get(startId) ?? [];
      const queue: Array<{
        nodeId: string;
        steps: number;
        hasDependsOn: boolean;
        firstOrigin: RenderEdgeOrigin;
      }> = [];
      const visitedHidden = new Set<string>();

      for (const edge of directOut) {
        if (bypassableHidden.has(edge.target) && !visitedHidden.has(edge.target)) {
          const kind = getEffectiveKind(edge);
          visitedHidden.add(edge.target);
          queue.push({
            nodeId: edge.target,
            steps: 1,
            hasDependsOn: kind === "depends_on",
            firstOrigin: { source: edge.source, target: edge.target, kind }
          });
        }
      }

      if (queue.length === 0) continue;

      const reachedVisible = new Map<
        string,
        { steps: number; hasDependsOn: boolean; origins: RenderEdgeOrigin[] }
      >();

      let head = 0;
      while (head < queue.length) {
        const cur = queue[head++]!;
        for (const edge of derived.dagOutgoing.get(cur.nodeId) ?? []) {
          const kind = getEffectiveKind(edge);
          const nextHasDep = cur.hasDependsOn || kind === "depends_on";

          if (visibleBeforeCollapse.has(edge.target)) {
            if (
              edge.target !== startId &&
              !isAncestorOrDescendant(startId, edge.target)
            ) {
              const existing = reachedVisible.get(edge.target);
              if (!existing || cur.steps < existing.steps) {
                reachedVisible.set(edge.target, {
                  steps: cur.steps,
                  hasDependsOn: nextHasDep,
                  origins: [
                    cur.firstOrigin,
                    { source: edge.source, target: edge.target, kind }
                  ]
                });
              }
            }
            // Stop at first visible node; do not traverse through visible nodes
          } else if (
            bypassableHidden.has(edge.target) &&
            !visitedHidden.has(edge.target)
          ) {
            visitedHidden.add(edge.target);
            queue.push({
              nodeId: edge.target,
              steps: cur.steps + 1,
              hasDependsOn: nextHasDep,
              firstOrigin: cur.firstOrigin
            });
          }
        }
      }

      for (const [targetId, info] of reachedVisible.entries()) {
        intermediateEdges.push({
          source: startId,
          target: targetId,
          kind: info.hasDependsOn ? "depends_on" : "flow",
          bypassedCount: info.steps,
          origins: info.origins
        });
      }
    }
  }

  // Step 5: scope (drillRoot + collapsed) → determine rendered node set
  const inScopeSet = new Set<string>();
  for (const id of visibleBeforeCollapse) {
    if (drillRoot === null) {
      inScopeSet.add(id);
    } else if (drillDescendants?.has(id)) {
      inScopeSet.add(id);
    }
  }

  const renderedIdSet = new Set<string>();
  for (const id of inScopeSet) {
    let foldedByAncestor = false;
    for (const anc of derived.ancestorsMap.get(id) ?? []) {
      if (anc === drillRoot) break;
      if (inScopeSet.has(anc) && collapsedSet.has(anc)) {
        foldedByAncestor = true;
        break;
      }
    }
    if (!foldedByAncestor) {
      renderedIdSet.add(id);
    }
  }

  // Build RenderNode list preserving model order
  const renderedNodes: RenderNode[] = [];
  const depthOf = (id: string): number => {
    let d = 0;
    for (const anc of derived.ancestorsMap.get(id) ?? []) {
      if (anc === drillRoot) break;
      if (renderedIdSet.has(anc)) d++;
    }
    return d;
  };

  for (const node of graph.nodes) {
    if (!renderedIdSet.has(node.id)) continue;

    const eff = derived.effectiveStatus.get(node.id) ?? "todo";
    const resolved = derived.resolvedStatus.get(node.id) ?? "todo";
    const inheritedFrom = derived.inheritedStatusFrom.get(node.id);
    const isContainer = derived.isContainer.has(node.id);
    const isCollapsed = isContainer && collapsedSet.has(node.id);

    const parentId =
      node.parentId && node.parentId !== drillRoot && renderedIdSet.has(node.parentId)
        ? node.parentId
        : undefined;

    let focusRole: FocusRole = "none";
    if (activeSet.has(node.id)) focusRole = "active";
    else if (nextSet.has(node.id)) focusRole = "next";
    else if (pathSet.has(node.id)) focusRole = "path";

    const dimmed = view === "focus" && !focusNonDimmedSet.has(node.id);

    renderedNodes.push({
      id: node.id,
      ...(parentId !== undefined ? { parentId } : {}),
      node,
      isContainer,
      isCollapsed,
      depth: depthOf(node.id),
      resolvedStatus: resolved,
      effectiveStatus: eff,
      ...(inheritedFrom !== undefined ? { inheritedStatusFrom: inheritedFrom } : {}),
      dimmed,
      focusRole,
      childCount: (derived.childrenMap.get(node.id) ?? []).length,
      descendantCount: (derived.descendantsMap.get(node.id) ?? new Set<string>()).size,
      statusSummary: isContainer ? buildStatusSummary(node.id, derived) : {}
    });
  }

  // Step 6 & 7: edgeLift + externalStubs
  const liftToRendered = (id: string): string | null => {
    if (renderedIdSet.has(id)) return id;
    for (const anc of derived.ancestorsMap.get(id) ?? []) {
      if (anc === drillRoot) return null;
      if (renderedIdSet.has(anc)) return anc;
    }
    return null;
  };

  const isRenderedAncestorOrDescendant = (a: string, b: string): boolean => {
    return (
      (derived.descendantsMap.get(a)?.has(b) ?? false) ||
      (derived.descendantsMap.get(b)?.has(a) ?? false)
    );
  };

  const externalStubMap = new Map<string, ExternalStub>();
  const ensureExternalStub = (
    nodeId: string,
    direction: "in" | "out"
  ): string => {
    const stubId = `__ext_${direction}__${nodeId}`;
    if (!externalStubMap.has(stubId)) {
      const targetNode = derived.nodeMap.get(nodeId)!;
      externalStubMap.set(stubId, {
        id: stubId,
        direction,
        targetNodeId: nodeId,
        title: targetNode.title,
        type: targetNode.type,
        effectiveStatus: derived.effectiveStatus.get(nodeId) ?? "todo",
        parentChain: buildParentChain(nodeId, derived)
      });
    }
    return stubId;
  };

  interface ProjectedEdgeCandidate {
    source: string;
    target: string;
    kind: EdgeKind;
    lifted: boolean;
    bypassedCount: number;
    isExternal: boolean;
    isCapsuleEdge: boolean;
    targetEffectiveStatus?: Status;
    origins: RenderEdgeOrigin[];
  }

  const edgeCandidates: ProjectedEdgeCandidate[] = [];

  for (const edge of intermediateEdges) {
    const lu = liftToRendered(edge.source);
    const lv = liftToRendered(edge.target);

    if (lu !== null && lv !== null) {
      // Self-loop after lifting → discard
      if (lu === lv) continue;
      // Ancestor-descendant after lifting → discard
      if (isRenderedAncestorOrDescendant(lu, lv)) continue;

      edgeCandidates.push({
        source: lu,
        target: lv,
        kind: edge.kind,
        lifted: lu !== edge.source || lv !== edge.target,
        bypassedCount: edge.bypassedCount,
        isExternal: false,
        isCapsuleEdge: false,
        targetEffectiveStatus: derived.effectiveStatus.get(lv),
        origins: edge.origins
      });
    } else if (drillRoot !== null && lu === null && lv !== null) {
      // Incoming edge from outside drillRoot
      const stubId = ensureExternalStub(edge.source, "in");
      edgeCandidates.push({
        source: stubId,
        target: lv,
        kind: edge.kind,
        lifted: lv !== edge.target,
        bypassedCount: edge.bypassedCount,
        isExternal: true,
        isCapsuleEdge: false,
        targetEffectiveStatus: derived.effectiveStatus.get(lv),
        origins: edge.origins
      });
    } else if (drillRoot !== null && lu !== null && lv === null) {
      // Outgoing edge to outside drillRoot
      const stubId = ensureExternalStub(edge.target, "out");
      edgeCandidates.push({
        source: lu,
        target: stubId,
        kind: edge.kind,
        lifted: lu !== edge.source,
        bypassedCount: edge.bypassedCount,
        isExternal: true,
        isCapsuleEdge: false,
        targetEffectiveStatus: derived.effectiveStatus.get(edge.target),
        origins: edge.origins
      });
    }
  }

  // Step 8: Capsules for hidden discarded / parked branches within rendered parents (or root)
  const capsuleGroups = new Map<
    string,
    { parentId: string | undefined; bucket: "discarded" | "parked"; items: CapsuleItem[] }
  >();
  const hiddenRootToCapsuleId = new Map<string, string>();

  for (const node of graph.nodes) {
    const bucket = topHiddenStatusRoots.get(node.id);
    if (!bucket) continue;

    // Only emit capsules whose parent is either the current drillRoot (top-level)
    // or a rendered EXPANDED container.
    let targetParentId: string | undefined;
    if (drillRoot === null) {
      if (node.parentId === undefined) {
        targetParentId = undefined;
      } else if (renderedIdSet.has(node.parentId) && !collapsedSet.has(node.parentId)) {
        targetParentId = node.parentId;
      } else {
        continue;
      }
    } else {
      if (node.parentId === drillRoot) {
        targetParentId = undefined;
      } else if (
        node.parentId &&
        renderedIdSet.has(node.parentId) &&
        !collapsedSet.has(node.parentId)
      ) {
        targetParentId = node.parentId;
      } else {
        continue;
      }
    }

    const groupKey = `${targetParentId ?? "__root__"}::${bucket}`;
    const capsuleId = `__cap_${bucket}__${targetParentId ?? "root"}`;
    hiddenRootToCapsuleId.set(node.id, capsuleId);

    let group = capsuleGroups.get(groupKey);
    if (!group) {
      group = { parentId: targetParentId, bucket, items: [] };
      capsuleGroups.set(groupKey, group);
    }
    group.items.push({
      id: node.id,
      title: node.title,
      type: node.type,
      status: derived.effectiveStatus.get(node.id) ?? bucket,
      ...(node.statusNote ? { statusNote: node.statusNote } : {}),
      descendantCount: (derived.descendantsMap.get(node.id) ?? new Set<string>()).size
    });
  }

  const capsules: RenderCapsule[] = [];
  for (const group of capsuleGroups.values()) {
    const capsuleId = `__cap_${group.bucket}__${group.parentId ?? "root"}`;
    const prefix = group.bucket === "discarded" ? "已排除" : "已搁置";
    capsules.push({
      id: capsuleId,
      ...(group.parentId !== undefined ? { parentId: group.parentId } : {}),
      bucket: group.bucket,
      label: `${prefix} ${group.items.length} 项`,
      count: group.items.length,
      items: group.items
    });
  }

  // Attach subtle incoming fork edges from rendered siblings to capsules (e.g., D1 -> [已排除 2 项])
  for (const edge of graph.edges) {
    if (edge.kind === "revises") continue;
    const capsuleId = hiddenRootToCapsuleId.get(edge.target);
    if (!capsuleId) continue;
    const lu = liftToRendered(edge.source);
    if (!lu) continue;
    const targetNode = derived.nodeMap.get(edge.target);
    const capsuleParent =
      targetNode?.parentId && targetNode.parentId !== drillRoot
        ? targetNode.parentId
        : undefined;
    const sourceRenderedParent = renderedNodes.find((n) => n.id === lu)?.parentId;
    if (sourceRenderedParent !== capsuleParent) continue;

    edgeCandidates.push({
      source: lu,
      target: capsuleId,
      kind: getEffectiveKind(edge),
      lifted: lu !== edge.source,
      bypassedCount: 0,
      isExternal: false,
      isCapsuleEdge: true,
      targetEffectiveStatus: topHiddenStatusRoots.get(edge.target),
      origins: [{ source: edge.source, target: edge.target, kind: getEffectiveKind(edge) }]
    });
  }

  // Step 9: dedupe — merge parallel edges with identical (source, target, kind)
  const parentLookup = new Map<string, string | undefined>();
  for (const rn of renderedNodes) parentLookup.set(rn.id, rn.parentId);
  for (const cap of capsules) parentLookup.set(cap.id, cap.parentId);

  const dedupeMap = new Map<string, RenderEdge>();
  for (const cand of edgeCandidates) {
    const key = `${cand.source}->${cand.target}::${cand.kind}`;
    const existing = dedupeMap.get(key);
    if (!existing) {
      const isCrossHierarchy =
        !cand.isExternal &&
        !cand.isCapsuleEdge &&
        parentLookup.get(cand.source) !== parentLookup.get(cand.target);

      dedupeMap.set(key, {
        id: cand.kind === "flow" ? `${cand.source}->${cand.target}` : key,
        source: cand.source,
        target: cand.target,
        kind: cand.kind,
        lifted: cand.lifted,
        bypassedCount: cand.bypassedCount,
        count: 1,
        isCrossHierarchy,
        isExternal: cand.isExternal,
        isCapsuleEdge: cand.isCapsuleEdge,
        ...(cand.targetEffectiveStatus !== undefined
          ? { targetEffectiveStatus: cand.targetEffectiveStatus }
          : {}),
        originalEdges: [...cand.origins]
      });
    } else {
      existing.count += 1;
      existing.lifted = existing.lifted || cand.lifted;
      if (cand.bypassedCount > 0) {
        existing.bypassedCount =
          existing.bypassedCount === 0
            ? cand.bypassedCount
            : Math.min(existing.bypassedCount, cand.bypassedCount);
      }
      for (const orig of cand.origins) {
        if (
          !existing.originalEdges.some(
            (o) =>
              o.source === orig.source && o.target === orig.target && o.kind === orig.kind
          )
        ) {
          existing.originalEdges.push(orig);
        }
      }
    }
  }

  // Deterministic edge ordering
  const renderedEdges = Array.from(dedupeMap.values()).sort((a, b) =>
    a.id.localeCompare(b.id)
  );
  const externalStubs = Array.from(externalStubMap.values()).sort((a, b) =>
    a.id.localeCompare(b.id)
  );

  // Build breadcrumbs
  const breadcrumbs: BreadcrumbItem[] = [{ id: null, title: graph.title }];
  if (drillRoot) {
    for (const anc of buildParentChain(drillRoot, derived)) {
      breadcrumbs.push(anc);
    }
    breadcrumbs.push({
      id: drillRoot,
      title: derived.nodeMap.get(drillRoot)?.title ?? drillRoot
    });
  }

  const direction = graph.layout?.direction ?? "DOWN";
  const hashPayload = {
    graphId: graph.id,
    view,
    direction,
    drillRoot,
    nodes: renderedNodes.map((n) => ({
      id: n.id,
      parentId: n.parentId,
      title: n.node.title,
      type: n.node.type,
      conclusion: n.node.conclusion,
      description: n.node.description,
      metrics: n.node.metrics,
      attachments: n.node.attachments?.length ?? 0,
      isContainer: n.isContainer,
      isCollapsed: n.isCollapsed,
      effectiveStatus: n.effectiveStatus,
      dimmed: n.dimmed,
      focusRole: n.focusRole
    })),
    edges: renderedEdges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      kind: e.kind,
      lifted: e.lifted,
      bypassedCount: e.bypassedCount,
      count: e.count
    })),
    externalStubs: externalStubs.map((s) => ({
      id: s.id,
      direction: s.direction,
      targetNodeId: s.targetNodeId,
      title: s.title
    })),
    capsules: capsules.map((c) => ({
      id: c.id,
      parentId: c.parentId,
      bucket: c.bucket,
      count: c.count
    }))
  };

  const renderHash = `sha256:${sha256Hex(JSON.stringify(hashPayload))}`;

  return {
    graphId: graph.id,
    title: graph.title,
    view,
    direction,
    drillRoot,
    breadcrumbs,
    nodes: renderedNodes,
    edges: renderedEdges,
    externalStubs,
    capsules,
    focus: computedFocus,
    renderHash
  };
}
