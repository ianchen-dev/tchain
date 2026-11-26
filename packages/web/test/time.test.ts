import { describe, expect, it } from "vitest";
import { formatFullLocalTime, formatRelativeTime } from "../src/utils/time.js";

describe("web time formatting utils", () => {
  const now = Date.parse("2026-11-26T12:00:00.000Z");

  it("formats relative times across seconds, minutes, hours, days, same year, and prior year", () => {
    expect(formatRelativeTime("2026-11-26T11:59:30.000Z", now)).toBe("刚刚");
    expect(formatRelativeTime("2026-11-26T11:45:00.000Z", now)).toBe("15 分钟前");
    expect(formatRelativeTime("2026-11-26T09:00:00.000Z", now)).toBe("3 小时前");
    expect(formatRelativeTime("2026-11-24T12:00:00.000Z", now)).toBe("2 天前");
    expect(formatRelativeTime("2026-10-01T08:30:00.000Z", now)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(formatRelativeTime("2025-06-15T12:00:00.000Z", now)).toBe("2025-06-15");
    expect(formatRelativeTime("invalid-date", now)).toBe("invalid-date");
  });

  it("formats full local time cleanly and preserves invalid strings", () => {
    expect(formatFullLocalTime("2026-11-26T08:15:30.000Z")).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
    );
    expect(formatFullLocalTime("invalid-date")).toBe("invalid-date");
  });
});
