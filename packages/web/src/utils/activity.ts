import type { ViewMode } from "@tchain/core";
import type { ActivityApiResponse, WorkspaceActivityApiResponse } from "../api.js";

export type ActivityRangePreset = "7d" | "this-week" | "last-week";
export type ActivityScope = "current" | "all";

export const ACTIVITY_RANGE_OPTIONS: Array<{
  id: ActivityRangePreset;
  label: string;
}> = [
  { id: "7d", label: "近 7 天" },
  { id: "this-week", label: "本周" },
  { id: "last-week", label: "上周" }
];

export function shouldShowActivityEntry(view: ViewMode): boolean {
  return view !== "report";
}

export function shouldShowScopeSelector(graphs: Array<{ valid: boolean }>): boolean {
  return graphs.filter((g) => g.valid).length > 1;
}

export function formatActivityCopyToast(
  rangeLabel: string,
  scope: ActivityScope,
  res: ActivityApiResponse | WorkspaceActivityApiResponse
): string {
  let done = 0;
  let progressed = 0;
  let ongoingBlocked = 0;

  if ("graphs" in res.data) {
    for (const g of res.data.graphs) {
      done += g.counts.done;
      progressed += g.counts.progressed;
      ongoingBlocked += g.counts.ongoingBlocked;
    }
  } else {
    done = res.data.counts.done;
    progressed = res.data.counts.progressed;
    ongoingBlocked = res.data.counts.ongoingBlocked;
  }

  const scopePrefix = scope === "all" ? "全部图谱" : "";
  return `已复制${scopePrefix}${rangeLabel}周报素材（完成 ${done} / 推进 ${progressed} / 持续阻塞 ${ongoingBlocked}）`;
}
