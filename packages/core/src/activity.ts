import { estimateTokens } from "./context.js";
import { deriveGraph } from "./derive.js";
import { computeFocus } from "./focus.js";
import type { Attachment, Graph, Metric, Node, Status } from "./schema.js";

const DEFAULT_TIME_RANGE_HINT =
  "支持格式：since 可填 <N>h / <N>d / <N>w（如 24h、7d、4w）、this-week、last-week、YYYY-MM-DD 或带时区的 ISO-8601；until 可填 YYYY-MM-DD 或带时区的 ISO-8601，且需满足 since <= until。";

export class ActivityTimeRangeError extends Error {
  readonly code = "INVALID_TIME_RANGE" as const;
  readonly hint: string;

  constructor(message: string, hint = DEFAULT_TIME_RANGE_HINT) {
    super(message);
    this.name = "ActivityTimeRangeError";
    this.hint = hint;
  }
}

export interface ActivityWindow {
  sinceIso: string;
  untilIso: string;
  nowIso: string;
  sinceExpr: string;
  untilExpr?: string;
  tzOffsetMinutes: number;
}

export interface CompileActivityOptions {
  since?: string;
  until?: string;
  now?: string | Date;
  tzOffsetMinutes?: number;
  format?: "md" | "json";
  maxTokens?: number;
  includeNext?: boolean;
}

export interface ActivityNodeItem {
  id: string;
  type: Node["type"];
  title: string;
  breadcrumb: string[];
  status: Status;
  effectiveStatus: Status;
  eventAt?: string;
  daysSinceLastTouch?: number;
  tags: string[];
  description?: string;
  conclusion?: string;
  statusNote?: string;
  metrics?: Metric[];
  attachments?: Attachment[];
}

export interface CompiledActivityData {
  graphId: string;
  graphTitle: string;
  window: ActivityWindow;
  coverage: {
    totalNodes: number;
    timestampedNodes: number;
    untrackedNodes: number;
  };
  counts: {
    done: number;
    progressed: number;
    blockedOrParkedOrDiscarded: number;
    discarded: number;
    created: number;
    ongoingBlocked: number;
    ongoingActiveUntouched: number;
    nextReady: number;
  };
  sections: {
    done: ActivityNodeItem[];
    progressed: ActivityNodeItem[];
    blockedOrParkedOrDiscarded: ActivityNodeItem[];
    created: ActivityNodeItem[];
    ongoingBlocked: ActivityNodeItem[];
    ongoingActiveUntouched: ActivityNodeItem[];
    nextReady: ActivityNodeItem[];
  };
  truncatedSections: string[];
}

export interface CompiledActivityResult {
  format: "md" | "json";
  text: string;
  data: CompiledActivityData;
  estimatedTokens: number;
}

export interface SkippedGraphNotice {
  id: string;
  file: string;
  reason: string;
}

export interface CompiledWorkspaceActivityData {
  window: ActivityWindow;
  graphCount: number;
  graphs: CompiledActivityData[];
  skippedGraphs?: SkippedGraphNotice[];
  truncatedSections: string[];
}

export interface CompiledWorkspaceActivityResult {
  format: "md" | "json";
  text: string;
  data: CompiledWorkspaceActivityData;
  estimatedTokens: number;
}

export interface CompileWorkspaceActivityOptions extends CompileActivityOptions {
  skippedGraphs?: SkippedGraphNotice[];
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RELATIVE_RE = /^([1-9]\d*)([hdw])$/i;
const STRICT_ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

const NEGATIVE_STATUSES = new Set<Status>(["blocked", "parked", "discarded"]);

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

function parseStrictIsoMs(raw: string, label: string): number {
  const m = STRICT_ISO_RE.exec(raw);
  if (!m) {
    throw new ActivityTimeRangeError(`无法解析 ${label} 的 ISO-8601 时间格式：${raw}`);
  }
  const year = Number.parseInt(m[1]!, 10);
  const month = Number.parseInt(m[2]!, 10);
  const day = Number.parseInt(m[3]!, 10);
  const hour = Number.parseInt(m[4]!, 10);
  const minute = Number.parseInt(m[5]!, 10);
  const second = m[6] !== undefined ? Number.parseInt(m[6], 10) : 0;

  if (!isValidCalendarDate(year, month, day)) {
    throw new ActivityTimeRangeError(`日期不存在（${label}）：${raw}`);
  }
  if (hour > 23 || minute > 59 || second > 59) {
    throw new ActivityTimeRangeError(`时间部分非法（${label}）：${raw}`);
  }
  if (m[8] !== undefined) {
    const offHour = Number.parseInt(m[9]!, 10);
    const offMin = Number.parseInt(m[10]!, 10);
    if (offHour > 14 || offMin > 59 || (offHour === 14 && offMin > 0)) {
      throw new ActivityTimeRangeError(`时区偏移超出合法范围（${label}）：${raw}`);
    }
  }

  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new ActivityTimeRangeError(`无效的 ISO-8601 时间（${label}）：${raw}`);
  }
  return ms;
}

function parseLocalDateMs(
  raw: string,
  offsetMs: number,
  boundary: "start" | "end",
  label: string
): number | null {
  const m = LOCAL_DATE_RE.exec(raw);
  if (!m) return null;
  const year = Number.parseInt(m[1]!, 10);
  const month = Number.parseInt(m[2]!, 10);
  const day = Number.parseInt(m[3]!, 10);
  if (!isValidCalendarDate(year, month, day)) {
    throw new ActivityTimeRangeError(`日期不存在（${label}）：${raw}`);
  }
  const utcMs =
    boundary === "start"
      ? Date.UTC(year, month - 1, day, 0, 0, 0, 0)
      : Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  return utcMs - offsetMs;
}

function parseUntilExpr(raw: string, offsetMs: number): number {
  const localEnd = parseLocalDateMs(raw, offsetMs, "end", "until");
  if (localEnd !== null) return localEnd;
  if (STRICT_ISO_RE.test(raw)) {
    return parseStrictIsoMs(raw, "until");
  }
  throw new ActivityTimeRangeError(`无法识别的 until 时间参数：${raw}`);
}

export function parseActivityWindow(opts?: {
  since?: string;
  until?: string;
  now?: string | Date;
  tzOffsetMinutes?: number;
}): ActivityWindow {
  let nowMs: number;
  if (opts?.now === undefined) {
    nowMs = Date.now();
  } else if (opts.now instanceof Date) {
    nowMs = opts.now.getTime();
    if (!Number.isFinite(nowMs)) {
      throw new ActivityTimeRangeError("无效的基准时间 now");
    }
  } else if (typeof opts.now === "string") {
    nowMs = parseStrictIsoMs(opts.now.trim(), "now");
  } else {
    throw new ActivityTimeRangeError("无效的基准时间 now");
  }

  let tzOffsetMinutes: number;
  if (opts?.tzOffsetMinutes !== undefined) {
    if (
      typeof opts.tzOffsetMinutes !== "number" ||
      !Number.isFinite(opts.tzOffsetMinutes) ||
      Math.abs(opts.tzOffsetMinutes) > 14 * 60
    ) {
      throw new ActivityTimeRangeError(`非法的时区偏移 tzOffsetMinutes：${String(opts.tzOffsetMinutes)}`);
    }
    const truncated = Math.trunc(opts.tzOffsetMinutes);
    tzOffsetMinutes = truncated === 0 ? 0 : truncated;
  } else {
    const raw = -new Date(nowMs).getTimezoneOffset();
    tzOffsetMinutes = raw === 0 ? 0 : raw;
  }
  const offsetMs = tzOffsetMinutes * 60_000;

  if (opts?.since !== undefined && opts.since.trim() === "") {
    throw new ActivityTimeRangeError("since 参数不能为空字符串");
  }
  const sinceRaw = (opts?.since ?? "7d").trim();
  const untilRaw = opts?.until?.trim() || undefined;

  const localNow = new Date(nowMs + offsetMs);
  const daysSinceMonday = (localNow.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  const thisWeekMondayMs =
    Date.UTC(
      localNow.getUTCFullYear(),
      localNow.getUTCMonth(),
      localNow.getUTCDate() - daysSinceMonday,
      0,
      0,
      0,
      0
    ) - offsetMs;

  let sinceMs: number;
  let untilMs: number;
  let sinceExpr = sinceRaw;

  const lowerSince = sinceRaw.toLowerCase();
  const relMatch = RELATIVE_RE.exec(sinceRaw);

  if (lowerSince === "last-week") {
    sinceExpr = "last-week";
    sinceMs = thisWeekMondayMs - 7 * DAY_MS;
    untilMs = untilRaw ? parseUntilExpr(untilRaw, offsetMs) : thisWeekMondayMs - 1;
  } else if (lowerSince === "this-week") {
    sinceExpr = "this-week";
    sinceMs = thisWeekMondayMs;
    untilMs = untilRaw ? parseUntilExpr(untilRaw, offsetMs) : nowMs;
  } else if (relMatch) {
    const n = Number.parseInt(relMatch[1]!, 10);
    const unit = relMatch[2]!.toLowerCase();
    sinceExpr = `${n}${unit}`;
    untilMs = untilRaw ? parseUntilExpr(untilRaw, offsetMs) : nowMs;
    const stepMs = unit === "h" ? HOUR_MS : unit === "d" ? DAY_MS : 7 * DAY_MS;
    sinceMs = untilMs - n * stepMs;
  } else {
    const localStart = parseLocalDateMs(sinceRaw, offsetMs, "start", "since");
    if (localStart !== null) {
      sinceMs = localStart;
      untilMs = untilRaw ? parseUntilExpr(untilRaw, offsetMs) : nowMs;
    } else if (STRICT_ISO_RE.test(sinceRaw)) {
      sinceMs = parseStrictIsoMs(sinceRaw, "since");
      untilMs = untilRaw ? parseUntilExpr(untilRaw, offsetMs) : nowMs;
    } else {
      throw new ActivityTimeRangeError(`无法识别的 since 时间参数：${sinceRaw}`);
    }
  }

  if (sinceMs > untilMs) {
    throw new ActivityTimeRangeError("开始时间晚于结束时间（since > until）");
  }

  return {
    sinceIso: new Date(sinceMs).toISOString(),
    untilIso: new Date(untilMs).toISOString(),
    nowIso: new Date(nowMs).toISOString(),
    sinceExpr,
    ...(untilRaw ? { untilExpr: untilRaw } : {}),
    tzOffsetMinutes
  };
}

function parseNodeTimestampMs(raw: string | undefined): number | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const ms = Date.parse(raw.trim());
  return Number.isFinite(ms) ? ms : undefined;
}

function formatOffsetLabel(tzOffsetMinutes: number): string {
  const sign = tzOffsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(tzOffsetMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${pad2(h)}:${pad2(m)}`;
}

function formatLocalDate(iso: string, tzOffsetMinutes: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms + tzOffsetMinutes * 60_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function formatLocalDateTime(iso: string, tzOffsetMinutes: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms + tzOffsetMinutes * 60_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(
    d.getUTCHours()
  )}:${pad2(d.getUTCMinutes())}`;
}

function describeWindowShortcut(window: ActivityWindow): string | null {
  if (window.untilExpr) return null;
  if (window.sinceExpr === "this-week") return "本周";
  if (window.sinceExpr === "last-week") return "上周";
  const m = RELATIVE_RE.exec(window.sinceExpr);
  if (!m) return null;
  const n = m[1]!;
  const unit = m[2]!.toLowerCase();
  if (unit === "h") return `近 ${n} 小时`;
  if (unit === "d") return `近 ${n} 天`;
  return `近 ${n} 周`;
}

function formatWindowLine(window: ActivityWindow): string {
  const startStr = formatLocalDateTime(window.sinceIso, window.tzOffsetMinutes);
  const endStr = formatLocalDateTime(window.untilIso, window.tzOffsetMinutes);
  const offsetStr = formatOffsetLabel(window.tzOffsetMinutes);
  const shortcut = describeWindowShortcut(window);
  return `${startStr} ~ ${endStr} (${offsetStr}${shortcut ? `，${shortcut}` : ""})`;
}

function toNodeItem(
  node: Node,
  derived: ReturnType<typeof deriveGraph>,
  opts: {
    eventAt?: string;
    daysSinceLastTouch?: number;
    tags?: string[];
  }
): ActivityNodeItem {
  const status = derived.resolvedStatus.get(node.id) ?? node.status ?? "todo";
  const effectiveStatus = derived.effectiveStatus.get(node.id) ?? status;
  const ancestors = [...(derived.ancestorsMap.get(node.id) ?? [])].reverse();
  const breadcrumb = ancestors.map((ancId) => {
    const anc = derived.nodeMap.get(ancId);
    return anc ? `${anc.id} ${anc.title}` : ancId;
  });

  return {
    id: node.id,
    type: node.type,
    title: node.title,
    breadcrumb,
    status,
    effectiveStatus,
    ...(opts.eventAt ? { eventAt: opts.eventAt } : {}),
    ...(opts.daysSinceLastTouch !== undefined
      ? { daysSinceLastTouch: opts.daysSinceLastTouch }
      : {}),
    tags: opts.tags ?? [],
    ...(node.description ? { description: node.description } : {}),
    ...(node.conclusion ? { conclusion: node.conclusion } : {}),
    ...(node.statusNote ? { statusNote: node.statusNote } : {}),
    ...(node.metrics && node.metrics.length > 0 ? { metrics: node.metrics } : {}),
    ...(node.attachments && node.attachments.length > 0
      ? { attachments: node.attachments }
      : {})
  };
}

function sortDescByEventAt(
  items: ActivityNodeItem[],
  nodeIndex: Map<string, number>
): ActivityNodeItem[] {
  return [...items].sort((a, b) => {
    const ta = a.eventAt ? Date.parse(a.eventAt) : -Infinity;
    const tb = b.eventAt ? Date.parse(b.eventAt) : -Infinity;
    if (ta !== tb) return tb - ta;
    return (nodeIndex.get(a.id) ?? 0) - (nodeIndex.get(b.id) ?? 0);
  });
}

function sortAscByEventAtUntouched(
  items: ActivityNodeItem[],
  nodeIndex: Map<string, number>
): ActivityNodeItem[] {
  return [...items].sort((a, b) => {
    const ta = a.eventAt ? Date.parse(a.eventAt) : Number.POSITIVE_INFINITY;
    const tb = b.eventAt ? Date.parse(b.eventAt) : Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    return (nodeIndex.get(a.id) ?? 0) - (nodeIndex.get(b.id) ?? 0);
  });
}

function buildActivityData(
  graph: Graph,
  window: ActivityWindow,
  includeNext: boolean
): CompiledActivityData {
  const derived = deriveGraph(graph);
  const focus = computeFocus(graph);

  const sinceMs = Date.parse(window.sinceIso);
  const untilMs = Date.parse(window.untilIso);
  const nowMs = Date.parse(window.nowIso);

  const inWindow = (ms: number | undefined): ms is number =>
    ms !== undefined && ms >= sinceMs && ms <= untilMs;

  let timestampedNodes = 0;
  const doneItems: ActivityNodeItem[] = [];
  const progressedItems: ActivityNodeItem[] = [];
  const negativeItems: ActivityNodeItem[] = [];
  const createdItems: ActivityNodeItem[] = [];
  const partAIds = new Set<string>();

  for (const node of graph.nodes) {
    const createdMs = parseNodeTimestampMs(node.createdAt);
    const updatedMs = parseNodeTimestampMs(node.updatedAt);
    const statusChangedMs = parseNodeTimestampMs(node.statusChangedAt);

    if (
      createdMs !== undefined ||
      updatedMs !== undefined ||
      statusChangedMs !== undefined
    ) {
      timestampedNodes += 1;
    }

    const eff = derived.effectiveStatus.get(node.id) ?? "todo";
    const inheritedFrom = derived.inheritedStatusFrom.get(node.id);

    // Priority 1: Done in window
    const doneEventMs = statusChangedMs ?? updatedMs;
    if (eff === "done" && inWindow(doneEventMs)) {
      partAIds.add(node.id);
      doneItems.push(
        toNodeItem(node, derived, {
          eventAt: new Date(doneEventMs).toISOString(),
          tags: inWindow(createdMs) ? ["本周新建"] : []
        })
      );
      continue;
    }

    // Priority 2: Explicit blocked / parked / discarded in window (or effective negative updated in window without inheritance-only spam)
    const explicitNegativeChanged =
      node.status !== undefined &&
      NEGATIVE_STATUSES.has(node.status) &&
      inWindow(statusChangedMs ?? updatedMs);
    const effectiveNegativeUpdated =
      !inheritedFrom &&
      NEGATIVE_STATUSES.has(eff) &&
      inWindow(updatedMs) &&
      !(inWindow(createdMs) && updatedMs <= createdMs && node.status === undefined);

    if (explicitNegativeChanged || effectiveNegativeUpdated) {
      const eventMs = inWindow(statusChangedMs)
        ? statusChangedMs
        : inWindow(updatedMs)
          ? updatedMs
          : (statusChangedMs ?? updatedMs)!;
      partAIds.add(node.id);
      negativeItems.push(
        toNodeItem(node, derived, {
          eventAt: new Date(eventMs).toISOString(),
          tags: []
        })
      );
      continue;
    }

    // Priority 3: Progressed (excluding newly created unprogressed todo)
    const isUnprogressedNewTodo =
      eff === "todo" &&
      inWindow(createdMs) &&
      (updatedMs === undefined || updatedMs <= createdMs) &&
      (statusChangedMs === undefined || statusChangedMs <= createdMs);

    if (
      !isUnprogressedNewTodo &&
      (inWindow(updatedMs) || (eff === "active" && inWindow(statusChangedMs)))
    ) {
      const eventMs = (inWindow(updatedMs) ? updatedMs : statusChangedMs)!;
      const tags: string[] = [];
      if (eff === "done") tags.push("补充更新");
      if (inWindow(createdMs)) tags.push("本周新建");
      partAIds.add(node.id);
      progressedItems.push(
        toNodeItem(node, derived, {
          eventAt: new Date(eventMs).toISOString(),
          tags
        })
      );
      continue;
    }

    // Priority 4: Newly created in window
    if (inWindow(createdMs)) {
      partAIds.add(node.id);
      createdItems.push(
        toNodeItem(node, derived, {
          eventAt: new Date(createdMs).toISOString(),
          tags: []
        })
      );
    }
  }

  // Part B: Ongoing blocked & active (untouched in window)
  const ongoingBlockedItems: ActivityNodeItem[] = [];
  const ongoingActiveItems: ActivityNodeItem[] = [];

  for (const node of graph.nodes) {
    if (partAIds.has(node.id)) continue;
    const eff = derived.effectiveStatus.get(node.id) ?? "todo";
    const isContainer = derived.isContainer.has(node.id);

    const createdMs = parseNodeTimestampMs(node.createdAt);
    const updatedMs = parseNodeTimestampMs(node.updatedAt);
    const statusChangedMs = parseNodeTimestampMs(node.statusChangedAt);
    const touchTimes = [updatedMs, statusChangedMs, createdMs].filter(
      (v): v is number => v !== undefined
    );
    const lastTouchMs = touchTimes.length > 0 ? Math.max(...touchTimes) : undefined;
    const eventAt = lastTouchMs !== undefined ? new Date(lastTouchMs).toISOString() : undefined;
    const daysSinceLastTouch =
      lastTouchMs !== undefined
        ? Math.max(0, Math.floor((nowMs - lastTouchMs) / DAY_MS))
        : undefined;

    if (eff === "blocked" && (!isContainer || node.status === "blocked")) {
      ongoingBlockedItems.push(
        toNodeItem(node, derived, {
          eventAt,
          daysSinceLastTouch,
          tags: []
        })
      );
      continue;
    }

    if (eff === "active" && !isContainer) {
      ongoingActiveItems.push(
        toNodeItem(node, derived, {
          eventAt,
          daysSinceLastTouch,
          tags: []
        })
      );
    }
  }

  const nextReadyItems: ActivityNodeItem[] = includeNext
    ? focus.nextIds
        .map((id) => derived.nodeMap.get(id))
        .filter((n): n is Node => Boolean(n))
        .map((n) => toNodeItem(n, derived, { tags: [] }))
    : [];

  const sortedDone = sortDescByEventAt(doneItems, derived.nodeIndex);
  const sortedProgressed = sortDescByEventAt(progressedItems, derived.nodeIndex);
  const sortedNegative = sortDescByEventAt(negativeItems, derived.nodeIndex);
  const sortedCreated = sortDescByEventAt(createdItems, derived.nodeIndex);
  const sortedOngoingBlocked = sortAscByEventAtUntouched(
    ongoingBlockedItems,
    derived.nodeIndex
  );
  const sortedOngoingActive = sortAscByEventAtUntouched(
    ongoingActiveItems,
    derived.nodeIndex
  );

  const discardedCount = sortedNegative.filter(
    (item) => item.effectiveStatus === "discarded" || item.status === "discarded"
  ).length;

  return {
    graphId: graph.id,
    graphTitle: graph.title,
    window,
    coverage: {
      totalNodes: graph.nodes.length,
      timestampedNodes,
      untrackedNodes: graph.nodes.length - timestampedNodes
    },
    counts: {
      done: sortedDone.length,
      progressed: sortedProgressed.length,
      blockedOrParkedOrDiscarded: sortedNegative.length,
      discarded: discardedCount,
      created: sortedCreated.length,
      ongoingBlocked: sortedOngoingBlocked.length,
      ongoingActiveUntouched: sortedOngoingActive.length,
      nextReady: nextReadyItems.length
    },
    sections: {
      done: sortedDone,
      progressed: sortedProgressed,
      blockedOrParkedOrDiscarded: sortedNegative,
      created: sortedCreated,
      ongoingBlocked: sortedOngoingBlocked,
      ongoingActiveUntouched: sortedOngoingActive,
      nextReady: nextReadyItems
    },
    truncatedSections: []
  };
}

function formatMetricsInline(metrics?: Metric[]): string {
  if (!metrics || metrics.length === 0) return "";
  return ` \`[${metrics.map((m) => `${m.label}: ${m.value}`).join(" | ")}]\``;
}

function formatAttachmentsLine(attachments?: Attachment[], indent = "  "): string | null {
  if (!attachments || attachments.length === 0) return null;
  const parts = attachments
    .map((att) => {
      const target = att.path ?? att.url ?? "";
      if (!target) return "";
      return att.title ? `${att.title} (\`${target}\`)` : `\`${target}\``;
    })
    .filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  return `${indent}- 证据：${parts.join("、")}`;
}

function formatCompactPath(breadcrumb: string[]): string {
  if (breadcrumb.length === 0) return "";
  const ids = breadcrumb.map((seg) => seg.split(" ")[0] ?? seg);
  return `（路径：${ids.join(" > ")}）`;
}

function formatTagsInline(tags: string[]): string {
  if (tags.length === 0) return "";
  return ` ${tags.map((t) => `\`[${t}]\``).join(" ")}`;
}

function formatSectionCount(visible: number, total: number): string {
  return visible < total ? `${visible}/${total}` : `${total}`;
}

function appendNodeDetails(
  lines: string[],
  item: ActivityNodeItem,
  kind: "done" | "progressed" | "negative" | "created" | "ongoingBlocked" | "ongoingActive" | "next",
  indent = "  "
): void {
  if (kind === "done") {
    if (item.conclusion) lines.push(`${indent}- 结论：${item.conclusion}`);
    else if (item.description) lines.push(`${indent}- 说明：${item.description}`);
    const ev = formatAttachmentsLine(item.attachments, indent);
    if (ev) lines.push(ev);
    return;
  }

  if (kind === "progressed") {
    const isSupplement = item.tags.includes("补充更新");
    if (item.conclusion) {
      lines.push(`${indent}- ${isSupplement ? "补充结论" : "进展/结论"}：${item.conclusion}`);
    } else if (item.description) {
      lines.push(`${indent}- 说明：${item.description}`);
    }
    if (item.statusNote) lines.push(`${indent}- 状态备注：${item.statusNote}`);
    const ev = formatAttachmentsLine(item.attachments, indent);
    if (ev) lines.push(ev);
    return;
  }

  if (kind === "negative") {
    const eff = item.effectiveStatus;
    if (eff === "discarded") {
      const reason = item.statusNote ?? item.conclusion ?? item.description;
      if (reason) lines.push(`${indent}- 否决原因（避坑）：${reason}`);
    } else if (eff === "parked") {
      const reason = item.statusNote ?? item.conclusion ?? item.description;
      if (reason) lines.push(`${indent}- 搁置原因/恢复条件：${reason}`);
    } else {
      const reason = item.statusNote ?? item.conclusion ?? item.description;
      if (reason) lines.push(`${indent}- 阻塞原因：${reason}`);
    }
    const ev = formatAttachmentsLine(item.attachments, indent);
    if (ev) lines.push(ev);
    return;
  }

  if (kind === "ongoingBlocked") {
    if (item.statusNote) lines.push(`${indent}- 阻塞原因：${item.statusNote}`);
    else if (item.conclusion) lines.push(`${indent}- 已有结论：${item.conclusion}`);
    else if (item.description) lines.push(`${indent}- 说明：${item.description}`);
    return;
  }

  if (kind === "ongoingActive") {
    if (item.conclusion) lines.push(`${indent}- 当前进展：${item.conclusion}`);
    else if (item.description) lines.push(`${indent}- 说明：${item.description}`);
    return;
  }

  if (item.description) lines.push(`${indent}- 说明：${item.description}`);
  else if (item.conclusion) lines.push(`${indent}- 结论：${item.conclusion}`);
}

function renderGraphSections(
  lines: string[],
  data: CompiledActivityData,
  headingPrefix: "##" | "###",
  includeNext: boolean
): void {
  const tz = data.window.tzOffsetMinutes;
  const s = data.sections;
  const c = data.counts;

  // ① Done
  lines.push(`${headingPrefix} ① 本周完成（${formatSectionCount(s.done.length, c.done)}）`);
  if (s.done.length === 0) {
    lines.push("- （无）");
  } else {
    for (const item of s.done) {
      const dateStr = item.eventAt ? formatLocalDate(item.eventAt, tz) : "";
      const datePart = dateStr ? ` \`完成于 ${dateStr}\`` : "";
      lines.push(
        `- **[${item.type}] ${item.id} ${item.title}**${formatCompactPath(item.breadcrumb)}${datePart}${formatTagsInline(
          item.tags
        )}${formatMetricsInline(item.metrics)}`
      );
      appendNodeDetails(lines, item, "done");
    }
  }
  lines.push("");

  // ② Progressed
  lines.push(
    `${headingPrefix} ② 本周推进（${formatSectionCount(s.progressed.length, c.progressed)}）`
  );
  if (s.progressed.length === 0) {
    lines.push("- （无）");
  } else {
    for (const item of s.progressed) {
      const dateStr = item.eventAt ? formatLocalDate(item.eventAt, tz) : "";
      const datePart = dateStr ? ` \`更新于 ${dateStr}\`` : "";
      lines.push(
        `- **[${item.type}] ${item.id} ${item.title}**${formatCompactPath(
          item.breadcrumb
        )} \`[${item.effectiveStatus}]\`${formatTagsInline(item.tags)}${datePart}${formatMetricsInline(
          item.metrics
        )}`
      );
      appendNodeDetails(lines, item, "progressed");
    }
  }
  lines.push("");

  // ③ Blocked / Parked / Discarded
  lines.push(
    `${headingPrefix} ③ 本周新阻塞、搁置与否决（${formatSectionCount(
      s.blockedOrParkedOrDiscarded.length,
      c.blockedOrParkedOrDiscarded
    )}）`
  );
  if (s.blockedOrParkedOrDiscarded.length === 0) {
    lines.push("- （无）");
  } else {
    for (const item of s.blockedOrParkedOrDiscarded) {
      const dateStr = item.eventAt ? formatLocalDate(item.eventAt, tz) : "";
      const datePart = dateStr ? ` \`变更于 ${dateStr}\`` : "";
      lines.push(
        `- **[${item.type}] ${item.id} ${item.title}**${formatCompactPath(
          item.breadcrumb
        )} \`[${item.effectiveStatus}]\`${datePart}${formatMetricsInline(item.metrics)}`
      );
      appendNodeDetails(lines, item, "negative");
    }
  }
  lines.push("");

  // ④ Created
  lines.push(`${headingPrefix} ④ 本周新增（${formatSectionCount(s.created.length, c.created)}）`);
  if (s.created.length === 0) {
    lines.push("- （无）");
  } else {
    for (const item of s.created) {
      const dateStr = item.eventAt ? formatLocalDate(item.eventAt, tz) : "";
      const datePart = dateStr ? ` \`创建于 ${dateStr}\`` : "";
      lines.push(
        `- **[${item.type}] ${item.id} ${item.title}**${formatCompactPath(
          item.breadcrumb
        )} \`[${item.effectiveStatus}]\`${datePart}${formatMetricsInline(item.metrics)}`
      );
      appendNodeDetails(lines, item, "created");
    }
  }
  lines.push("");

  // ⑤ Ongoing Blocked & Active (untouched)
  lines.push(`${headingPrefix} ⑤ 持续阻塞与进行中（本周无更新）`);
  lines.push(
    `- **持续阻塞中（${formatSectionCount(s.ongoingBlocked.length, c.ongoingBlocked)}）**`
  );
  if (s.ongoingBlocked.length === 0) {
    lines.push("  - （无）");
  } else {
    for (const item of s.ongoingBlocked) {
      const timeTag = item.eventAt
        ? `\`上次更新于 ${formatLocalDate(item.eventAt, tz)}（${item.daysSinceLastTouch ?? 0} 天前）\``
        : "`无时间记录`";
      lines.push(
        `  - **[${item.type}] ${item.id} ${item.title}**${formatCompactPath(
          item.breadcrumb
        )} ${timeTag}${formatMetricsInline(item.metrics)}`
      );
      appendNodeDetails(lines, item, "ongoingBlocked", "    ");
    }
  }
  lines.push(
    `- **当前进行中（本周无更新，${formatSectionCount(
      s.ongoingActiveUntouched.length,
      c.ongoingActiveUntouched
    )}）**`
  );
  if (s.ongoingActiveUntouched.length === 0) {
    lines.push("  - （无）");
  } else {
    for (const item of s.ongoingActiveUntouched) {
      const timeTag = item.eventAt
        ? `\`上次更新于 ${formatLocalDate(item.eventAt, tz)}（${item.daysSinceLastTouch ?? 0} 天前）\``
        : "`无时间记录`";
      lines.push(
        `  - **[${item.type}] ${item.id} ${item.title}**${formatCompactPath(
          item.breadcrumb
        )} ${timeTag}${formatMetricsInline(item.metrics)}`
      );
      appendNodeDetails(lines, item, "ongoingActive", "    ");
    }
  }
  lines.push("");

  // ⑥ Next ready frontier
  if (includeNext) {
    lines.push(`${headingPrefix} ⑥ 下一步就绪前沿（供下周计划参考）`);
    if (s.nextReady.length === 0) {
      lines.push("- （无）");
    } else {
      for (const item of s.nextReady) {
        lines.push(
          `- **[${item.type}] ${item.id} ${item.title}**${formatCompactPath(
            item.breadcrumb
          )} \`[${item.effectiveStatus}]\`${formatMetricsInline(item.metrics)}`
        );
        appendNodeDetails(lines, item, "next");
      }
    }
    lines.push("");
  }
}

function renderSingleMarkdown(data: CompiledActivityData, includeNext: boolean): string {
  const lines: string[] = [];
  const c = data.counts;
  const cov = data.coverage;

  lines.push(`# 活动简报：${data.graphTitle}（${data.graphId}）`);
  lines.push("");
  lines.push(`- 统计区间：${formatWindowLine(data.window)}`);
  lines.push(
    `- 概览：完成 ${c.done} | 推进 ${c.progressed} | 阻塞/搁置/否决 ${c.blockedOrParkedOrDiscarded} | 新增 ${c.created} | 持续阻塞 ${c.ongoingBlocked} | 进行中(无更新) ${c.ongoingActiveUntouched}`
  );
  if (cov.untrackedNodes > 0) {
    lines.push(
      `- 时间覆盖：${cov.timestampedNodes}/${cov.totalNodes} 个节点含时间记录（${cov.untrackedNodes} 个历史节点无时间戳，未参与时间筛选）`
    );
  } else {
    lines.push(`- 时间覆盖：${cov.timestampedNodes}/${cov.totalNodes} 个节点含时间记录`);
  }
  lines.push("");

  renderGraphSections(lines, data, "##", includeNext);

  if (data.truncatedSections.length > 0) {
    lines.push(
      `> 注：已按 maxTokens 限制裁剪部分低优先级内容（涉及分段：${data.truncatedSections.join("、")}）。`
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function hasSubstantiveActivity(g: CompiledActivityData): boolean {
  const c = g.counts;
  return (
    c.done +
      c.progressed +
      c.blockedOrParkedOrDiscarded +
      c.created +
      c.ongoingBlocked +
      c.ongoingActiveUntouched >
    0
  );
}

function hasWindowChange(g: CompiledActivityData): boolean {
  const c = g.counts;
  return c.done + c.progressed + c.blockedOrParkedOrDiscarded + c.created > 0;
}

function renderWorkspaceMarkdown(
  data: CompiledWorkspaceActivityData,
  includeNext: boolean
): string {
  const lines: string[] = [];
  lines.push(`# 工作区活动简报汇总（${data.graphCount} 张图谱）`);
  lines.push("");
  lines.push(`- 统计区间：${formatWindowLine(data.window)}`);
  if (data.skippedGraphs && data.skippedGraphs.length > 0) {
    const skippedSummary = data.skippedGraphs
      .map((s) => `${s.id}（${s.file}：${s.reason}）`)
      .join("；");
    lines.push(`- 已跳过校验失败图谱：${skippedSummary}`);
  }
  lines.push("");

  if (data.graphs.length === 0) {
    lines.push("- 当前工作区暂无有效图谱。");
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    "| 图谱 | 完成 | 推进 | 阻塞/搁置/否决 | 新增 | 持续阻塞 | 进行中(无更新) | 时间覆盖 | 状态 |"
  );
  lines.push("| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |");

  const activeGraphs: CompiledActivityData[] = [];
  for (const g of data.graphs) {
    const c = g.counts;
    const cov = g.coverage;
    let statusLabel = "本区间无变化";
    if (hasWindowChange(g)) {
      statusLabel = "有更新";
      activeGraphs.push(g);
    } else if (c.ongoingBlocked > 0 || c.ongoingActiveUntouched > 0) {
      statusLabel = "有持续项";
      activeGraphs.push(g);
    }

    lines.push(
      `| ${g.graphTitle} (\`${g.graphId}\`) | ${c.done} | ${c.progressed} | ${c.blockedOrParkedOrDiscarded} | ${c.created} | ${c.ongoingBlocked} | ${c.ongoingActiveUntouched} | ${cov.timestampedNodes}/${cov.totalNodes} | ${statusLabel} |`
    );
  }
  lines.push("");

  if (activeGraphs.length === 0) {
    lines.push("> 本统计区间内工作区所有图谱均无新增变化或待跟进持续项。");
  } else {
    for (const g of activeGraphs) {
      lines.push(`## ${g.graphTitle}（${g.graphId}）`);
      lines.push("");
      renderGraphSections(lines, g, "###", includeNext);
    }
  }

  if (data.truncatedSections.length > 0) {
    lines.push(
      `> 注：已按 maxTokens 限制裁剪部分低优先级内容（涉及分段：${data.truncatedSections.join("、")}）。`
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

const TRUNCATION_STAGES: Array<{
  key: keyof CompiledActivityData["sections"];
  label: string;
}> = [
  { key: "nextReady", label: "⑥ 下一步就绪前沿" },
  { key: "created", label: "④ 本周新增" },
  { key: "ongoingActiveUntouched", label: "⑤ 当前进行中（本周无更新）" },
  { key: "progressed", label: "② 本周推进" }
];

function addUniqueLabel(list: string[], label: string): void {
  if (!list.includes(label)) {
    list.push(label);
  }
}

export function compileActivity(
  graph: Graph,
  options?: CompileActivityOptions
): CompiledActivityResult {
  const window = parseActivityWindow({
    since: options?.since,
    until: options?.until,
    now: options?.now,
    tzOffsetMinutes: options?.tzOffsetMinutes
  });
  const includeNext = options?.includeNext ?? true;
  const format = options?.format ?? "md";
  const data = buildActivityData(graph, window, includeNext);

  const render = (): string =>
    format === "json"
      ? `${JSON.stringify(data, null, 2)}\n`
      : renderSingleMarkdown(data, includeNext);

  const maxTokens = options?.maxTokens;
  if (maxTokens !== undefined && maxTokens > 0) {
    for (const stage of TRUNCATION_STAGES) {
      while (estimateTokens(render()) > maxTokens && data.sections[stage.key].length > 0) {
        data.sections[stage.key].pop();
        addUniqueLabel(data.truncatedSections, stage.label);
      }
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

export function compileWorkspaceActivity(
  graphs: Graph[],
  options?: CompileWorkspaceActivityOptions
): CompiledWorkspaceActivityResult {
  const window = parseActivityWindow({
    since: options?.since,
    until: options?.until,
    now: options?.now,
    tzOffsetMinutes: options?.tzOffsetMinutes
  });
  const includeNext = options?.includeNext ?? true;
  const format = options?.format ?? "md";
  const skippedGraphs = options?.skippedGraphs;

  const compiledGraphs = graphs.map((g) => buildActivityData(g, window, includeNext));
  const data: CompiledWorkspaceActivityData = {
    window,
    graphCount: compiledGraphs.length,
    graphs: compiledGraphs,
    ...(skippedGraphs && skippedGraphs.length > 0 ? { skippedGraphs } : {}),
    truncatedSections: []
  };

  const render = (): string =>
    format === "json"
      ? `${JSON.stringify(data, null, 2)}\n`
      : renderWorkspaceMarkdown(data, includeNext);

  const maxTokens = options?.maxTokens;
  if (maxTokens !== undefined && maxTokens > 0) {
    for (const stage of TRUNCATION_STAGES) {
      while (estimateTokens(render()) > maxTokens) {
        let removedAny = false;
        for (const g of compiledGraphs) {
          if (!hasSubstantiveActivity(g)) continue;
          if (g.sections[stage.key].length > 0) {
            g.sections[stage.key].pop();
            addUniqueLabel(g.truncatedSections, stage.label);
            addUniqueLabel(data.truncatedSections, stage.label);
            removedAny = true;
            if (estimateTokens(render()) <= maxTokens) break;
          }
        }
        if (!removedAny) break;
      }
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
