import ELK from "elkjs/lib/elk-api.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import type { RenderGraph } from "@tchain/core";
import {
  buildElkGraph,
  flattenElkOutput,
  type ElkNodeOutput,
  type LayoutResult
} from "./elkGraph.js";

export type { LayoutResult };

const layoutCache = new Map<string, LayoutResult>();
const MAX_CACHE_SIZE = 48;

let elkInstance: InstanceType<typeof ELK> | null = null;

function getElk(): InstanceType<typeof ELK> {
  if (!elkInstance) {
    elkInstance = new ELK({
      workerFactory: () => new Worker(elkWorkerUrl)
    });
  }
  return elkInstance;
}

export function getLayoutCacheKey(
  renderGraph: RenderGraph,
  measuredContentHeights?: ReadonlyMap<string, number>
): string {
  const heights = [...(measuredContentHeights ?? [])].sort(([a], [b]) => a.localeCompare(b));
  return `${renderGraph.renderHash}::${renderGraph.view}::${renderGraph.direction}::${JSON.stringify(heights)}`;
}

export async function runElkLayout(
  renderGraph: RenderGraph,
  measuredContentHeights?: ReadonlyMap<string, number>
): Promise<{ result: LayoutResult; cacheHit: boolean }> {
  const cacheKey = getLayoutCacheKey(renderGraph, measuredContentHeights);
  const cached = layoutCache.get(cacheKey);
  if (cached) {
    return { result: cached, cacheHit: true };
  }

  const { elkGraph } = buildElkGraph(renderGraph, measuredContentHeights);
  const elk = getElk();
  const t0 = performance.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const output = (await elk.layout(elkGraph as any)) as ElkNodeOutput;
  const durationMs = Math.round((performance.now() - t0) * 10) / 10;

  const result = flattenElkOutput(renderGraph, output, durationMs);

  if (layoutCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = layoutCache.keys().next().value;
    if (oldestKey) layoutCache.delete(oldestKey);
  }
  layoutCache.set(cacheKey, result);

  return { result, cacheHit: false };
}
