function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Formats an ISO-8601 timestamp into a concise relative string in local time.
 */
export function formatRelativeTime(iso: string, nowMs = Date.now()): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;

  const diffMs = nowMs - ms;
  if (diffMs < 60_000) {
    return "刚刚";
  }
  if (diffMs < 3_600_000) {
    return `${Math.floor(diffMs / 60_000)} 分钟前`;
  }
  if (diffMs < 86_400_000) {
    return `${Math.floor(diffMs / 3_600_000)} 小时前`;
  }
  if (diffMs < 7 * 86_400_000) {
    return `${Math.floor(diffMs / 86_400_000)} 天前`;
  }

  const d = new Date(ms);
  const now = new Date(nowMs);
  if (d.getFullYear() === now.getFullYear()) {
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Formats an ISO-8601 timestamp into full local `YYYY-MM-DD HH:mm:ss` for hover tooltips.
 */
export function formatFullLocalTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
