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
});
