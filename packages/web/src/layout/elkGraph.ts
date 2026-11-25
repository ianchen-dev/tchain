import type {
  ExternalStub,
  RenderCapsule,
  RenderEdge,
  RenderGraph,
  RenderNode
} from "@tchain/core";
import {
  estimateCapsuleSize,
  estimateNodeSize,
  estimateStubSize,
  getContainerPadding
} from "./sizing.js";

export interface ElkPoint {
  x: number;
  y: number;
}

export interface ElkEdgeSection {
  id: string;
  startPoint: ElkPoint;
  endPoint: ElkPoint;
  bendPoints?: ElkPoint[];
}

export interface ElkEdgeInput {
  id: string;
  sources: string[];
  targets: string[];
  layoutOptions?: Record<string, string>;
}

export interface ElkNodeInput {
  id: string;
  width?: number;
  height?: number;
  layoutOptions?: Record<string, string>;
  children?: ElkNodeInput[];
  edges?: ElkEdgeInput[];
}

export interface ElkEdgeOutput {
  id: string;
  sources: string[];
  targets: string[];
  sections?: ElkEdgeSection[];
}

export interface ElkNodeOutput {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkNodeOutput[];
  edges?: ElkEdgeOutput[];
}

export interface PositionedNode {
  id: string;
  kind: "leaf" | "container" | "stub" | "capsule";
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  zIndex: number;
  renderNode?: RenderNode;
  stub?: ExternalStub;
  capsule?: RenderCapsule;
}

export interface PositionedEdge {
  id: string;
  edge: RenderEdge;
  points: ElkPoint[];
}

export interface LayoutResult {
  renderHash: string;
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  width: number;
  height: number;
  durationMs: number;
}

/**
 * Finds the Lowest Common Ancestor (LCA) container ID for two rendered item IDs,
 * or `"root"` when they live in the top-level scope.
 */
function findLcaContainer(
  a: string,
  b: string,
  parentMap: Map<string, string | undefined>
): string {
  const ancestorsA = new Set<string>();
  let cur: string | undefined = parentMap.get(a);
  while (cur) {
    ancestorsA.add(cur);
    cur = parentMap.get(cur);
  }

  cur = parentMap.get(b);
  while (cur) {
    if (ancestorsA.has(cur)) return cur;
    cur = parentMap.get(cur);
  }
  return "root";
}

/**
 * Builds the hierarchical ELK input graph from a `RenderGraph`:
 * - Uses `INCLUDE_CHILDREN`, model-order preservation, and fixed random seed (PRD §8.3).
 * - Places every edge on the LCA container of its endpoints so ELK routes cross-layer
 *   edges accurately without violating hierarchy constraints.
 */
export function buildElkGraph(renderGraph: RenderGraph): {
  elkGraph: ElkNodeInput;
  edgeLcaMap: Map<string, string>;
} {
  const isReport = renderGraph.view === "report";
  const direction = renderGraph.direction;

  const parentMap = new Map<string, string | undefined>();
  const elkNodeMap = new Map<string, ElkNodeInput>();
  const childrenOrder = new Map<string, ElkNodeInput[]>();
  childrenOrder.set("root", []);

  // 1. Incoming external stubs placed first at root level (so they sit upstream)
  for (const stub of renderGraph.externalStubs) {
    if (stub.direction !== "in") continue;
    const size = estimateStubSize(stub, renderGraph.view);
    const elkNode: ElkNodeInput = {
      id: stub.id,
      width: size.width,
      height: size.height
    };
    elkNodeMap.set(stub.id, elkNode);
    parentMap.set(stub.id, undefined);
    childrenOrder.get("root")!.push(elkNode);
  }

  // 2. RenderNodes (leaves and expanded/collapsed containers) in exact model order
  for (const rn of renderGraph.nodes) {
    const isExpandedContainer = rn.isContainer && !rn.isCollapsed;
    let elkNode: ElkNodeInput;

    if (isExpandedContainer) {
      const pad = getContainerPadding(rn, renderGraph.view);
      elkNode = {
        id: rn.id,
        layoutOptions: {
          "elk.padding": `[top=${pad.top},left=${pad.left},bottom=${pad.bottom},right=${pad.right}]`,
          "elk.nodeSize.constraints": "MINIMUM_SIZE",
          "elk.nodeSize.minimum": isReport ? "(320, 120)" : "(280, 100)",
          "elk.spacing.nodeNode": isReport ? "34" : "24",
          "elk.layered.spacing.nodeNodeBetweenLayers": isReport ? "46" : "34"
        },
        children: [],
        edges: []
      };
      childrenOrder.set(rn.id, elkNode.children!);
    } else {
      const size = estimateNodeSize(rn, renderGraph.view);
      elkNode = {
        id: rn.id,
        width: size.width,
        height: size.height
      };
    }

    elkNodeMap.set(rn.id, elkNode);
    parentMap.set(rn.id, rn.parentId);
    const parentKey = rn.parentId ?? "root";
    const list = childrenOrder.get(parentKey);
    if (list) {
      list.push(elkNode);
    } else {
      childrenOrder.get("root")!.push(elkNode);
    }
  }

  // 3. Discarded / parked capsules placed inside their visible parent
  for (const cap of renderGraph.capsules) {
    const size = estimateCapsuleSize(cap, renderGraph.view);
    const elkNode: ElkNodeInput = {
      id: cap.id,
      width: size.width,
      height: size.height
    };
    elkNodeMap.set(cap.id, elkNode);
    parentMap.set(cap.id, cap.parentId);
    const parentKey = cap.parentId ?? "root";
    const list = childrenOrder.get(parentKey);
    if (list) {
      list.push(elkNode);
    } else {
      childrenOrder.get("root")!.push(elkNode);
    }
  }

  // 4. Outgoing external stubs placed last at root level (so they sit downstream)
  for (const stub of renderGraph.externalStubs) {
    if (stub.direction !== "out") continue;
    const size = estimateStubSize(stub, renderGraph.view);
    const elkNode: ElkNodeInput = {
      id: stub.id,
      width: size.width,
      height: size.height
    };
    elkNodeMap.set(stub.id, elkNode);
    parentMap.set(stub.id, undefined);
    childrenOrder.get("root")!.push(elkNode);
  }

  // 5. Place every edge on the LCA of its endpoints
  const rootEdges: ElkEdgeInput[] = [];
  const edgeLcaMap = new Map<string, string>();

  for (const edge of renderGraph.edges) {
    if (!elkNodeMap.has(edge.source) || !elkNodeMap.has(edge.target)) continue;
    const lca = findLcaContainer(edge.source, edge.target, parentMap);
    edgeLcaMap.set(edge.id, lca);

    const elkEdge: ElkEdgeInput = {
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target]
    };

    if (lca === "root") {
      rootEdges.push(elkEdge);
    } else {
      const container = elkNodeMap.get(lca);
      if (container && container.edges) {
        container.edges.push(elkEdge);
      } else {
        edgeLcaMap.set(edge.id, "root");
        rootEdges.push(elkEdge);
      }
    }
  }

  const elkGraph: ElkNodeInput = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.randomSeed": "42",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
      "elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
      "elk.spacing.nodeNode": isReport ? "42" : "28",
      "elk.spacing.edgeNode": isReport ? "26" : "20",
      "elk.spacing.edgeEdge": "14",
      "elk.layered.spacing.nodeNodeBetweenLayers": isReport ? "58" : "42",
      "elk.layered.spacing.edgeNodeBetweenLayers": isReport ? "24" : "18",
      "elk.padding": "[top=24,left=24,bottom=24,right=24]"
    },
    children: childrenOrder.get("root")!,
    edges: rootEdges
  };

  return { elkGraph, edgeLcaMap };
}

/**
 * Flattens ELK hierarchical output into absolute coordinates (PRD §8.1 & §8.3):
 * - Containers receive low zIndex (`-100 + depth * 5`) so edges render cleanly above them.
 * - Leaf/stub/capsule nodes receive high zIndex (`200 + depth`).
 * - Every edge's section points are offset by the absolute (x, y) of its LCA container!
 */
export function flattenElkOutput(
  renderGraph: RenderGraph,
  elkOut: ElkNodeOutput,
  durationMs: number
): LayoutResult {
  const renderNodeMap = new Map<string, RenderNode>(
    renderGraph.nodes.map((n) => [n.id, n])
  );
  const stubMap = new Map<string, ExternalStub>(
    renderGraph.externalStubs.map((s) => [s.id, s])
  );
  const capsuleMap = new Map<string, RenderCapsule>(
    renderGraph.capsules.map((c) => [c.id, c])
  );
  const renderEdgeMap = new Map<string, RenderEdge>(
    renderGraph.edges.map((e) => [e.id, e])
  );

  const absPosMap = new Map<string, ElkPoint>();
  absPosMap.set("root", { x: 0, y: 0 });

  const positionedNodes: PositionedNode[] = [];
  const positionedEdges: PositionedEdge[] = [];

  const walk = (node: ElkNodeOutput, offsetX: number, offsetY: number, depth: number): void => {
    const absX = offsetX + (node.x ?? 0);
    const absY = offsetY + (node.y ?? 0);
    absPosMap.set(node.id, { x: absX, y: absY });

    if (node.id !== "root") {
      const width = node.width ?? 260;
      const height = node.height ?? 90;
      const rn = renderNodeMap.get(node.id);
      const stub = stubMap.get(node.id);
      const capsule = capsuleMap.get(node.id);

      if (rn) {
        const isExpandedContainer = rn.isContainer && !rn.isCollapsed;
        positionedNodes.push({
          id: rn.id,
          kind: isExpandedContainer ? "container" : "leaf",
          x: absX,
          y: absY,
          width,
          height,
          depth,
          zIndex: isExpandedContainer ? -100 + depth * 5 : 200 + depth,
          renderNode: rn
        });
      } else if (stub) {
        positionedNodes.push({
          id: stub.id,
          kind: "stub",
          x: absX,
          y: absY,
          width,
          height,
          depth,
          zIndex: 210,
          stub
        });
      } else if (capsule) {
        positionedNodes.push({
          id: capsule.id,
          kind: "capsule",
          x: absX,
          y: absY,
          width,
          height,
          depth,
          zIndex: 210 + depth,
          capsule
        });
      }
    }

    // Collect edges owned by this ELK container (offset by this container's absolute origin)
    for (const elkEdge of node.edges ?? []) {
      const re = renderEdgeMap.get(elkEdge.id);
      if (!re) continue;
      const sec = elkEdge.sections?.[0];
      const points: ElkPoint[] = [];
      if (sec) {
        points.push({ x: absX + sec.startPoint.x, y: absY + sec.startPoint.y });
        for (const bp of sec.bendPoints ?? []) {
          points.push({ x: absX + bp.x, y: absY + bp.y });
        }
        points.push({ x: absX + sec.endPoint.x, y: absY + sec.endPoint.y });
      }
      positionedEdges.push({
        id: re.id,
        edge: re,
        points
      });
    }

    for (const child of node.children ?? []) {
      walk(child, absX, absY, node.id === "root" ? 0 : depth + 1);
    }
  };

  walk(elkOut, 0, 0, 0);

  // Order containers outer-to-inner first, then leaves/stubs/capsules
  positionedNodes.sort((a, b) => a.zIndex - b.zIndex);

  return {
    renderHash: renderGraph.renderHash,
    nodes: positionedNodes,
    edges: positionedEdges,
    width: elkOut.width ?? 800,
    height: elkOut.height ?? 600,
    durationMs
  };
}
