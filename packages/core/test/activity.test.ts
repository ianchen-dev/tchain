import { describe, expect, it } from "vitest";
import {
  ActivityTimeRangeError,
  compileActivity,
  compileWorkspaceActivity,
  parseActivityWindow,
  type Graph
} from "../src/index.js";

describe("@tchain/core activity / weekly report compiler", () => {
  describe("parseActivityWindow", () => {
    // 2026-11-27T11:30:00+08:00 (Friday)
    const NOW = "2026-11-27T11:30:00+08:00";
    const TZ = 480;

    it("parses relative 24h / 7d / 4w deterministically", () => {
      const w24h = parseActivityWindow({ since: "24h", now: NOW, tzOffsetMinutes: TZ });
      expect(w24h.sinceIso).toBe("2026-11-26T03:30:00.000Z");
      expect(w24h.untilIso).toBe("2026-11-27T03:30:00.000Z");
      expect(w24h.sinceExpr).toBe("24h");
      expect(w24h.tzOffsetMinutes).toBe(480);

      const w7d = parseActivityWindow({ now: NOW, tzOffsetMinutes: TZ });
      expect(w7d.sinceExpr).toBe("7d");
      expect(w7d.sinceIso).toBe("2026-11-20T03:30:00.000Z");

      const w4w = parseActivityWindow({ since: "4w", now: NOW, tzOffsetMinutes: TZ });
      expect(w4w.sinceIso).toBe("2026-10-30T03:30:00.000Z");
    });

    it("handles this-week across Monday and Sunday local boundaries", () => {
      // Monday 00:05 +08:00 -> since should be Monday 00:00 +08:00 (Sunday 16:00 UTC)
      const mon = parseActivityWindow({
        since: "this-week",
        now: "2026-11-23T00:05:00+08:00",
        tzOffsetMinutes: TZ
      });
      expect(mon.sinceIso).toBe("2026-11-22T16:00:00.000Z");

      // Sunday 23:50 +08:00 -> still same Monday 00:00 +08:00
      const sun = parseActivityWindow({
        since: "this-week",
        now: "2026-11-29T23:50:00+08:00",
        tzOffsetMinutes: TZ
      });
      expect(sun.sinceIso).toBe("2026-11-22T16:00:00.000Z");
      expect(sun.untilIso).toBe("2026-11-29T15:50:00.000Z");
    });

    it("locks last-week to last Monday 00:00 ~ last Sunday 23:59:59.999 in injected timezone", () => {
      const lw = parseActivityWindow({
        since: "last-week",
        now: NOW,
        tzOffsetMinutes: TZ
      });
      // Last Monday = 2026-11-16 00:00 +08:00 = 2026-11-15T16:00:00.000Z
      expect(lw.sinceIso).toBe("2026-11-15T16:00:00.000Z");
      // Last Sunday 23:59:59.999 +08:00 = 2026-11-22T15:59:59.999Z
      expect(lw.untilIso).toBe("2026-11-22T15:59:59.999Z");

      // Cross-timezone check (-300 = UTC-05:00)
      const lwNy = parseActivityWindow({
        since: "last-week",
        now: "2026-11-23T02:00:00-05:00",
        tzOffsetMinutes: -300
      });
      expect(lwNy.sinceIso).toBe("2026-11-16T05:00:00.000Z");
      expect(lwNy.untilIso).toBe("2026-11-23T04:59:59.999Z");
    });

    it("parses YYYY-MM-DD as closed interval and strict ISO-8601", () => {
      const dateRange = parseActivityWindow({
        since: "2026-11-20",
        until: "2026-11-26",
        now: NOW,
        tzOffsetMinutes: TZ
      });
      expect(dateRange.sinceIso).toBe("2026-11-19T16:00:00.000Z");
      expect(dateRange.untilIso).toBe("2026-11-26T15:59:59.999Z");

      const isoRange = parseActivityWindow({
        since: "2026-11-20T09:00:00+08:00",
        until: "2026-11-26T18:00:00Z",
        now: NOW,
        tzOffsetMinutes: TZ
      });
      expect(isoRange.sinceIso).toBe("2026-11-20T01:00:00.000Z");
      expect(isoRange.untilIso).toBe("2026-11-26T18:00:00.000Z");
    });

    it("throws ActivityTimeRangeError (INVALID_TIME_RANGE) on invalid formats or since > until", () => {
      const badInputs: Array<{ since?: string; until?: string }> = [
        { since: "invalid" },
        { since: "" },
        { since: "0d" },
        { since: "2026-02-30" },
        { since: "2026-11-20T10:00:00" }, // missing timezone offset
        { since: "7d", until: "2026-04-31" },
        { since: "2026-11-25", until: "2026-11-20" } // since > until
      ];

      for (const bad of badInputs) {
        let caught: unknown;
        try {
          parseActivityWindow({ ...bad, now: NOW, tzOffsetMinutes: TZ });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(ActivityTimeRangeError);
        expect((caught as ActivityTimeRangeError).code).toBe("INVALID_TIME_RANGE");
        expect((caught as ActivityTimeRangeError).hint).toBeTruthy();
      }
    });
  });

  describe("mutually exclusive bucketing, container dedup & Part B snapshot", () => {
    const NOW = "2026-11-27T11:30:00+08:00";
    const TZ = 480;

    const sampleGraph: Graph = {
      schemaVersion: 1,
      id: "weekly-sample",
      title: "周报规则测试图",
      nodes: [
        {
          id: "G",
          type: "goal",
          title: "根目标容器"
          // untouched container, no timestamps of its own
        },
        {
          id: "D_DONE",
          parentId: "G",
          type: "task",
          title: "本周新建并完成",
          status: "done",
          conclusion: "已上线",
          metrics: [{ label: "延迟", value: "12ms", tone: "positive" }],
          attachments: [{ path: "docs/report.md", title: "报告" }],
          createdAt: "2026-11-23T10:00:00+08:00",
          updatedAt: "2026-11-24T15:00:00+08:00",
          statusChangedAt: "2026-11-24T15:00:00+08:00"
        },
        {
          id: "E_SUPP",
          parentId: "G",
          type: "milestone",
          title: "上周已完成本周补充结论",
          status: "done",
          conclusion: "补充基准数据",
          createdAt: "2026-11-05T10:00:00+08:00",
          statusChangedAt: "2026-11-10T10:00:00+08:00",
          updatedAt: "2026-11-22T11:00:00+08:00"
        },
        {
          id: "P_CONT",
          parentId: "G",
          type: "option",
          title: "整支搁置容器",
          status: "parked",
          statusNote: "先推进主线方案",
          createdAt: "2026-11-01T10:00:00+08:00",
          updatedAt: "2026-11-22T09:00:00+08:00",
          statusChangedAt: "2026-11-22T09:00:00+08:00"
        },
        {
          id: "P_CHILD_BLOCKED",
          parentId: "P_CONT",
          type: "task",
          title: "搁置容器下的旧阻塞子任务",
          status: "blocked",
          statusNote: "旧阻塞",
          createdAt: "2026-11-02T10:00:00+08:00",
          updatedAt: "2026-11-03T10:00:00+08:00",
          statusChangedAt: "2026-11-03T10:00:00+08:00"
        },
        {
          id: "X_DISC",
          parentId: "G",
          type: "task",
          title: "已否决方案",
          status: "discarded",
          statusNote: "成本过高",
          createdAt: "2026-11-10T10:00:00+08:00",
          updatedAt: "2026-11-21T16:00:00+08:00",
          statusChangedAt: "2026-11-21T16:00:00+08:00"
        },
        {
          id: "N_TODO",
          parentId: "G",
          type: "task",
          title: "本周新建待办（无后续更新）",
          status: "todo",
          description: "待开始",
          createdAt: "2026-11-25T09:00:00+08:00",
          updatedAt: "2026-11-25T09:00:00+08:00",
          statusChangedAt: "2026-11-25T09:00:00+08:00"
        },
        {
          id: "N_PROG",
          parentId: "G",
          type: "task",
          title: "本周新建且持续推进",
          status: "active",
          conclusion: "已完成一半",
          createdAt: "2026-11-24T09:00:00+08:00",
          updatedAt: "2026-11-26T18:00:00+08:00",
          statusChangedAt: "2026-11-25T10:00:00+08:00"
        },
        {
          id: "BLK_OLD",
          parentId: "G",
          type: "task",
          title: "十天前持续阻塞",
          status: "blocked",
          statusNote: "等待外部审批",
          createdAt: "2026-11-05T10:00:00+08:00",
          updatedAt: "2026-11-08T10:00:00+08:00",
          statusChangedAt: "2026-11-08T10:00:00+08:00"
        },
        {
          id: "ACT_OLD_CONT",
          parentId: "G",
          type: "option",
          title: "进行中容器"
          // rolled-up active from ACT_OLD_LEAF
        },
        {
          id: "ACT_OLD_LEAF",
          parentId: "ACT_OLD_CONT",
          type: "task",
          title: "上周进行中本周无更新",
          status: "active",
          createdAt: "2026-11-10T10:00:00+08:00",
          updatedAt: "2026-11-12T10:00:00+08:00",
          statusChangedAt: "2026-11-12T10:00:00+08:00"
        },
        {
          id: "LEGACY_BLK",
          parentId: "G",
          type: "task",
          title: "无时间戳历史阻塞节点",
          status: "blocked",
          statusNote: "历史遗留阻塞"
        }
      ],
      edges: []
    };

    it("enforces priority bucketing, container dedup, and Part B snapshot rules", () => {
      const res = compileActivity(sampleGraph, {
        since: "7d",
        now: NOW,
        tzOffsetMinutes: TZ,
        format: "md"
      });
      const { sections, counts, coverage } = res.data;

      // ① Done: only D_DONE (with [本周新建]); E_SUPP must NOT inflate done count
      expect(sections.done.map((n) => n.id)).toEqual(["D_DONE"]);
      expect(sections.done[0]!.tags).toEqual(["本周新建"]);

      // ② Progressed: N_PROG ([本周新建]) & E_SUPP ([补充更新]), sorted desc by eventAt
      expect(sections.progressed.map((n) => n.id)).toEqual(["N_PROG", "E_SUPP"]);
      expect(sections.progressed[0]!.tags).toEqual(["本周新建"]);
      expect(sections.progressed[1]!.tags).toEqual(["补充更新"]);

      // ③ Negative: P_CONT & X_DISC only; P_CHILD_BLOCKED must NOT expand
      expect(sections.blockedOrParkedOrDiscarded.map((n) => n.id)).toEqual([
        "P_CONT",
        "X_DISC"
      ]);
      expect(counts.discarded).toBe(1);

      // ④ Created: N_TODO only (not in progressed!)
      expect(sections.created.map((n) => n.id)).toEqual(["N_TODO"]);

      // Untouched parent container G with subtreeUpdatedAt in window must NOT enter Part A
      const allPartAIds = [
        ...sections.done,
        ...sections.progressed,
        ...sections.blockedOrParkedOrDiscarded,
        ...sections.created
      ].map((n) => n.id);
      expect(allPartAIds).not.toContain("G");
      expect(new Set(allPartAIds).size).toBe(allPartAIds.length);

      // ⑤-a Ongoing blocked: BLK_OLD (19 days ago) & LEGACY_BLK (untracked); G (rolled-up) and P_CHILD_BLOCKED (inherited parked) excluded!
      expect(sections.ongoingBlocked.map((n) => n.id)).toEqual([
        "BLK_OLD",
        "LEGACY_BLK"
      ]);
      expect(sections.ongoingBlocked[0]!.daysSinceLastTouch).toBe(19);
      expect(sections.ongoingBlocked[1]!.eventAt).toBeUndefined();
      expect(sections.ongoingBlocked[1]!.daysSinceLastTouch).toBeUndefined();

      // ⑤-b Ongoing active untouched: ACT_OLD_LEAF only; container ACT_OLD_CONT excluded
      expect(sections.ongoingActiveUntouched.map((n) => n.id)).toEqual([
        "ACT_OLD_LEAF"
      ]);
      expect(sections.ongoingActiveUntouched[0]!.daysSinceLastTouch).toBe(15);

      // Coverage: G, ACT_OLD_CONT, LEGACY_BLK have no timestamps (3 untracked of 12)
      expect(coverage).toEqual({
        totalNodes: 12,
        timestampedNodes: 9,
        untrackedNodes: 3
      });

      // Markdown assertions
      expect(res.text).toContain("否决原因（避坑）：成本过高");
      expect(res.text).toContain("`上次更新于 2026-11-08（19 天前）`");
      expect(res.text).toContain("`无时间记录`");
      expect(res.text).toContain("9/12 个节点含时间记录（3 个历史节点无时间戳，未参与时间筛选）");
      expect(res.text).not.toContain("停滞警报");
      expect(res.text).not.toContain("长期停滞");
    });

    it("omits section ⑥ when includeNext is false", () => {
      const res = compileActivity(sampleGraph, {
        since: "7d",
        now: NOW,
        tzOffsetMinutes: TZ,
        includeNext: false
      });
      expect(res.data.sections.nextReady).toEqual([]);
      expect(res.text).not.toContain("## ⑥ 下一步就绪前沿");
    });
  });

  describe("maxTokens truncation & compileWorkspaceActivity", () => {
    const NOW = "2026-11-27T11:30:00+08:00";
    const TZ = 480;

    it("truncates strictly in order ⑥ → ④ → ⑤(进行中) → ② while preserving ①, ③, ⑤(阻塞)", () => {
      const graph: Graph = {
        schemaVersion: 1,
        id: "trunc",
        title: "裁剪测试图",
        nodes: [
          {
            id: "D1",
            type: "task",
            title: "必须保留的本周完成任务",
            status: "done",
            conclusion: "核心里程碑完成",
            createdAt: "2026-11-24T10:00:00+08:00",
            updatedAt: "2026-11-25T10:00:00+08:00",
            statusChangedAt: "2026-11-25T10:00:00+08:00"
          },
          {
            id: "B1",
            type: "task",
            title: "必须保留的新阻塞任务",
            status: "blocked",
            statusNote: "关键阻塞",
            createdAt: "2026-11-24T10:00:00+08:00",
            updatedAt: "2026-11-25T10:00:00+08:00",
            statusChangedAt: "2026-11-25T10:00:00+08:00"
          },
          {
            id: "OB1",
            type: "task",
            title: "必须保留的持续阻塞任务",
            status: "blocked",
            statusNote: "老卡点",
            createdAt: "2026-11-01T10:00:00+08:00",
            updatedAt: "2026-11-02T10:00:00+08:00",
            statusChangedAt: "2026-11-02T10:00:00+08:00"
          },
          {
            id: "P1",
            type: "task",
            title: "本周推进任务P1",
            status: "active",
            conclusion: "推进中 P1 的详细记录说明文本用于增加 token",
            createdAt: "2026-11-10T10:00:00+08:00",
            updatedAt: "2026-11-25T12:00:00+08:00"
          },
          {
            id: "P2",
            type: "task",
            title: "本周推进任务P2",
            status: "active",
            conclusion: "推进中 P2 的详细记录说明文本用于增加 token",
            createdAt: "2026-11-10T10:00:00+08:00",
            updatedAt: "2026-11-24T12:00:00+08:00"
          },
          {
            id: "OA1",
            type: "task",
            title: "无更新进行中OA1",
            status: "active",
            description: "用于验证裁剪顺序的进行中任务描述",
            createdAt: "2026-11-01T10:00:00+08:00",
            updatedAt: "2026-11-10T10:00:00+08:00"
          },
          {
            id: "C1",
            type: "task",
            title: "本周新增待办C1",
            status: "todo",
            description: "用于验证裁剪顺序的新增待办描述",
            createdAt: "2026-11-25T10:00:00+08:00",
            updatedAt: "2026-11-25T10:00:00+08:00"
          },
          {
            id: "N1",
            type: "task",
            title: "下一步就绪任务N1",
            status: "todo",
            description: "最先被裁剪的就绪前沿任务描述",
            createdAt: "2026-11-01T10:00:00+08:00",
            updatedAt: "2026-11-01T10:00:00+08:00"
          }
        ],
        edges: []
      };

      const full = compileActivity(graph, { since: "7d", now: NOW, tzOffsetMinutes: TZ });
      expect(full.estimatedTokens).toBeGreaterThan(240);

      // Force heavy truncation down to 160 tokens -> trims all lower sections, keeps ①, ③, ⑤-blocked
      const tight = compileActivity(graph, {
        since: "7d",
        now: NOW,
        tzOffsetMinutes: TZ,
        maxTokens: 160
      });

      expect(tight.data.sections.done.map((n) => n.id)).toEqual(["D1"]);
      expect(tight.data.sections.blockedOrParkedOrDiscarded.map((n) => n.id)).toEqual(["B1"]);
      expect(tight.data.sections.ongoingBlocked.map((n) => n.id)).toEqual(["OB1"]);
      expect(tight.data.truncatedSections).toEqual([
        "⑥ 下一步就绪前沿",
        "④ 本周新增",
        "⑤ 当前进行中（本周无更新）",
        "② 本周推进"
      ]);
      expect(tight.text).toContain("已按 maxTokens 限制裁剪部分低优先级内容");
    });

    it("builds workspace summary table, folds unchanged graphs, and reports skipped graphs", () => {
      const gActive: Graph = {
        schemaVersion: 1,
        id: "g-active",
        title: "活跃项目",
        nodes: [
          {
            id: "A1",
            type: "task",
            title: "完成项",
            status: "done",
            createdAt: "2026-11-24T10:00:00+08:00",
            updatedAt: "2026-11-25T10:00:00+08:00",
            statusChangedAt: "2026-11-25T10:00:00+08:00"
          }
        ],
        edges: []
      };
      const gIdle: Graph = {
        schemaVersion: 1,
        id: "g-idle",
        title: "静默项目",
        nodes: [
          {
            id: "I1",
            type: "task",
            title: "上个月完成",
            status: "done",
            createdAt: "2026-10-01T10:00:00+08:00",
            updatedAt: "2026-10-02T10:00:00+08:00",
            statusChangedAt: "2026-10-02T10:00:00+08:00"
          }
        ],
        edges: []
      };

      const ws = compileWorkspaceActivity([gActive, gIdle], {
        since: "7d",
        now: NOW,
        tzOffsetMinutes: TZ,
        skippedGraphs: [{ id: "broken", file: ".thoughtchain/graphs/broken.tgraph.json", reason: "JSON error" }]
      });

      expect(ws.data.graphCount).toBe(2);
      expect(ws.text).toContain("# 工作区活动简报汇总（2 张图谱）");
      expect(ws.text).toContain("已跳过校验失败图谱：broken");
      expect(ws.text).toContain("活跃项目 (`g-active`) | 1 | 0 | 0 | 0 | 0 | 0 | 1/1 | 有更新");
      expect(ws.text).toContain("静默项目 (`g-idle`) | 0 | 0 | 0 | 0 | 0 | 0 | 1/1 | 本区间无变化");
      expect(ws.text).toContain("## 活跃项目（g-active）");
      expect(ws.text).not.toContain("## 静默项目（g-idle）");
    });
  });
});
