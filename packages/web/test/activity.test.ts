import { describe, expect, it } from "vitest";
import type { CompiledActivityData, CompiledWorkspaceActivityData } from "@tchain/core";
import {
  ACTIVITY_RANGE_OPTIONS,
  formatActivityCopyToast,
  shouldShowActivityEntry,
  shouldShowScopeSelector
} from "../src/utils/activity.js";

function makeGraphData(
  graphId: string,
  counts: Partial<CompiledActivityData["counts"]>
): CompiledActivityData {
  return {
    graphId,
    graphTitle: graphId,
    window: {
      sinceIso: "2026-11-20T00:00:00.000Z",
      untilIso: "2026-11-27T00:00:00.000Z",
      nowIso: "2026-11-27T00:00:00.000Z",
      sinceExpr: "7d",
      tzOffsetMinutes: 480
    },
    coverage: { totalNodes: 5, timestampedNodes: 5, untrackedNodes: 0 },
    counts: {
      done: 0,
      progressed: 0,
      blockedOrParkedOrDiscarded: 0,
      discarded: 0,
      created: 0,
      ongoingBlocked: 0,
      ongoingActiveUntouched: 0,
      nextReady: 0,
      ...counts
    },
    sections: {
      done: [],
      progressed: [],
      blockedOrParkedOrDiscarded: [],
      created: [],
      ongoingBlocked: [],
      ongoingActiveUntouched: [],
      nextReady: []
    },
    truncatedSections: []
  };
}

describe("Web TopBar activity report helpers", () => {
  it("shows entry in workspace/focus views and hides it in report view", () => {
    expect(shouldShowActivityEntry("workspace")).toBe(true);
    expect(shouldShowActivityEntry("focus")).toBe(true);
    expect(shouldShowActivityEntry("report")).toBe(false);
  });

  it("shows scope selector only when more than 1 valid graph exists", () => {
    expect(shouldShowScopeSelector([{ valid: true }])).toBe(false);
    expect(shouldShowScopeSelector([{ valid: true }, { valid: false }])).toBe(false);
    expect(shouldShowScopeSelector([{ valid: true }, { valid: true }])).toBe(true);
  });

  it("provides the three required range presets", () => {
    expect(ACTIVITY_RANGE_OPTIONS).toEqual([
      { id: "7d", label: "近 7 天" },
      { id: "this-week", label: "本周" },
      { id: "last-week", label: "上周" }
    ]);
  });

  it("formats toast summary for single graph and aggregated workspace responses", () => {
    const singleMsg = formatActivityCopyToast("近 7 天", "current", {
      ok: true,
      format: "md",
      text: "",
      estimatedTokens: 100,
      data: makeGraphData("g1", { done: 2, progressed: 3, ongoingBlocked: 1 })
    });
    expect(singleMsg).toBe("已复制近 7 天周报素材（完成 2 / 推进 3 / 持续阻塞 1）");

    const wsData: CompiledWorkspaceActivityData = {
      window: makeGraphData("g1", {}).window,
      graphCount: 2,
      graphs: [
        makeGraphData("g1", { done: 2, progressed: 1, ongoingBlocked: 1 }),
        makeGraphData("g2", { done: 1, progressed: 4, ongoingBlocked: 2 })
      ],
      truncatedSections: []
    };
    const wsMsg = formatActivityCopyToast("本周", "all", {
      ok: true,
      format: "md",
      text: "",
      estimatedTokens: 200,
      data: wsData
    });
    expect(wsMsg).toBe("已复制全部图谱本周周报素材（完成 3 / 推进 5 / 持续阻塞 3）");
  });
});
