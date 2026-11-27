import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CLI_DIST = path.resolve(import.meta.dirname, "../dist/cli.js");
const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../fixtures/announcement-pipeline.tgraph.json"
);

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tchain-cli-test-"));
  tempDirs.push(dir);
  return dir;
}

function runCli(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI_DIST, ...args], {
      cwd,
      encoding: "utf8"
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? ""
    };
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("tchain Phase 0 CLI", () => {
  it("init creates .thoughtchain/, schema, and .gitignore", () => {
    const dir = makeTempDir();
    const res = runCli(["init", dir], dir);
    expect(res.status).toBe(0);

    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, ".thoughtchain", "tgraph.schema.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".thoughtchain", ".gitignore"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".thoughtchain", "graphs"))).toBe(true);
  });

  it("validate passes on sample fixture and fails with non-zero exit on invalid graph", () => {
    const dir = makeTempDir();
    runCli(["init", dir], dir);

    const targetGraph = path.join(
      dir,
      ".thoughtchain",
      "graphs",
      "announcement-pipeline.tgraph.json"
    );
    fs.copyFileSync(FIXTURE_PATH, targetGraph);

    const validRes = runCli(["validate", "--no-fs-check"], dir);
    expect(validRes.status).toBe(0);
    const validJson = JSON.parse(validRes.stdout);
    expect(validJson.ok).toBe(true);
    expect(validJson.results[0].errorCount).toBe(0);

    // Write invalid graph with parent cycle
    const badPath = path.join(dir, ".thoughtchain", "graphs", "bad.tgraph.json");
    fs.writeFileSync(
      badPath,
      JSON.stringify({
        schemaVersion: 1,
        id: "bad",
        title: "Bad Graph",
        nodes: [
          { id: "A", parentId: "B", type: "task", title: "A", status: "todo" },
          { id: "B", parentId: "A", type: "task", title: "B", status: "todo" }
        ],
        edges: []
      }),
      "utf8"
    );

    const invalidRes = runCli(["validate", "bad"], dir);
    expect(invalidRes.status).toBe(1);
    const invalidJson = JSON.parse(invalidRes.stdout);
    expect(invalidJson.ok).toBe(false);
    expect(invalidJson.results[0].errors[0].code).toBe("PARENT_CYCLE");
  });

  it("fmt canonicalizes messy JSON and --check detects formatting state", () => {
    const dir = makeTempDir();
    runCli(["init", dir], dir);

    const gPath = path.join(dir, ".thoughtchain", "graphs", "messy.tgraph.json");
    fs.writeFileSync(
      gPath,
      '{"edges":[{"target":"B","source":"A","kind":"flow"}],"nodes":[{"status":"active","title":"A","type":"goal","id":"A"},{"id":"B","type":"task","title":"B","status":"todo","description":""}],"title":"Messy","id":"messy","schemaVersion":1}',
      "utf8"
    );

    const checkBefore = runCli(["fmt", "messy", "--check"], dir);
    expect(checkBefore.status).toBe(1);

    const fmtRes = runCli(["fmt", "messy"], dir);
    expect(fmtRes.status).toBe(0);
    expect(JSON.parse(fmtRes.stdout).formatted).toHaveLength(1);

    const checkAfter = runCli(["fmt", "messy", "--check"], dir);
    expect(checkAfter.status).toBe(0);
  });

  it("context outputs Markdown and JSON briefs for node K3", () => {
    const dir = makeTempDir();
    runCli(["init", dir], dir);
    const targetGraph = path.join(
      dir,
      ".thoughtchain",
      "graphs",
      "announcement-pipeline.tgraph.json"
    );
    fs.copyFileSync(FIXTURE_PATH, targetGraph);

    const mdRes = runCli(["context", "announcement-pipeline", "--node", "K3"], dir);
    expect(mdRes.status).toBe(0);
    expect(mdRes.stdout).toContain("## ① 全局目标");
    expect(mdRes.stdout).toContain("K3 核对已有结构化财报数据的覆盖范围");

    const jsonRes = runCli(
      ["context", "announcement-pipeline", "--node", "K3", "--format", "json"],
      dir
    );
    expect(jsonRes.status).toBe(0);
    const parsed = JSON.parse(jsonRes.stdout);
    expect(parsed.targetNodeId).toBe("K3");
    expect(parsed.avoidConstraints.length).toBeGreaterThanOrEqual(2);
  });

  it("activity compiles Markdown and JSON for single graph, workspace summary, and rejects invalid time range", () => {
    const dir = makeTempDir();
    runCli(["init", dir], dir);
    const nowIso = new Date().toISOString();
    const g1Path = path.join(dir, ".thoughtchain", "graphs", "alpha.tgraph.json");
    const g2Path = path.join(dir, ".thoughtchain", "graphs", "beta.tgraph.json");
    const badPath = path.join(dir, ".thoughtchain", "graphs", "corrupt.tgraph.json");

    fs.writeFileSync(
      g1Path,
      JSON.stringify({
        schemaVersion: 1,
        id: "alpha",
        title: "Alpha 图谱",
        nodes: [
          { id: "G", type: "goal", title: "总目标" },
          {
            id: "T1",
            parentId: "G",
            type: "task",
            title: "本周完成任务",
            status: "done",
            conclusion: "已完成验证",
            createdAt: nowIso,
            updatedAt: nowIso,
            statusChangedAt: nowIso
          },
          {
            id: "T2",
            parentId: "G",
            type: "task",
            title: "就绪任务",
            status: "todo"
          }
        ],
        edges: []
      }),
      "utf8"
    );

    fs.writeFileSync(
      g2Path,
      JSON.stringify({
        schemaVersion: 1,
        id: "beta",
        title: "Beta 无变化图谱",
        nodes: [
          {
            id: "B1",
            type: "task",
            title: "历史已完成",
            status: "done",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            statusChangedAt: "2026-01-01T00:00:00Z"
          }
        ],
        edges: []
      }),
      "utf8"
    );

    fs.writeFileSync(badPath, "{ bad json", "utf8");

    // 1. Single graph md
    const singleMd = runCli(["activity", "alpha", "--since", "7d"], dir);
    expect(singleMd.status).toBe(0);
    expect(singleMd.stdout).toContain("# 活动简报：Alpha 图谱（alpha）");
    expect(singleMd.stdout).toContain("## ① 本周完成（1）");
    expect(singleMd.stdout).toContain("T1 本周完成任务");
    expect(singleMd.stdout).toContain("## ⑥ 下一步就绪前沿");

    // 2. Single graph json + --no-next
    const singleJson = runCli(
      ["activity", "alpha", "--format", "json", "--no-next"],
      dir
    );
    expect(singleJson.status).toBe(0);
    const parsedSingle = JSON.parse(singleJson.stdout);
    expect(parsedSingle.graphId).toBe("alpha");
    expect(parsedSingle.counts.done).toBe(1);
    expect(parsedSingle.sections.nextReady).toEqual([]);

    // 3. Workspace summary (omitted [graph]) folds unchanged beta and notes corrupt graph
    const wsMd = runCli(["activity", "--since", "7d"], dir);
    expect(wsMd.status).toBe(0);
    expect(wsMd.stdout).toContain("# 工作区活动简报汇总（2 张图谱）");
    expect(wsMd.stdout).toContain("已跳过校验失败图谱：corrupt");
    expect(wsMd.stdout).toContain("Beta 无变化图谱 (`beta`)");
    expect(wsMd.stdout).toContain("本区间无变化");
    expect(wsMd.stdout).toContain("## Alpha 图谱（alpha）");
    expect(wsMd.stdout).not.toContain("## Beta 无变化图谱（beta）");

    // 4. Invalid --since exits 1 with INVALID_TIME_RANGE
    const invalidRes = runCli(["activity", "--since", "invalid"], dir);
    expect(invalidRes.status).toBe(1);
    const invalidJson = JSON.parse(invalidRes.stdout);
    expect(invalidJson.ok).toBe(false);
    expect(invalidJson.code).toBe("INVALID_TIME_RANGE");
  });
});
