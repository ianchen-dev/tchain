import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initWorkspace } from "../src/workspace.js";
import { startWorkbenchServer, type RunningServer } from "../src/server.js";

const CLI_DIST = path.resolve(import.meta.dirname, "../dist/cli.js");
const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../fixtures/announcement-pipeline.tgraph.json"
);

const tempDirs: string[] = [];
const runningServers: RunningServer[] = [];

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tchain-p2-test-"));
  tempDirs.push(dir);
  initWorkspace(dir);
  fs.copyFileSync(
    FIXTURE_PATH,
    path.join(dir, ".thoughtchain", "graphs", "announcement-pipeline.tgraph.json")
  );
  return dir;
}

function apiRequest(opts: {
  port: number;
  token: string;
  method?: string;
  path: string;
  body?: unknown;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const req = http.request(
      {
        host: "127.0.0.1",
        port: opts.port,
        path: opts.path,
        method: opts.method ?? "GET",
        headers: {
          Authorization: `Bearer ${opts.token}`,
          ...(payload !== undefined
            ? {
                "Content-Type": "application/json",
                "Content-Length": String(Buffer.byteLength(payload))
              }
            : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            json: JSON.parse(text) as Record<string, unknown>
          });
        });
      }
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

afterEach(async () => {
  while (runningServers.length > 0) {
    const srv = runningServers.pop()!;
    await srv.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Phase 2: Unified ops pipeline, CAS 409, Patch conflict rebase, Rollback, External revert, CLI & MCP", () => {
  it("enforces baseHash CAS (409 STALE_BASE), supports undo via inverse ops, and reversible rollback", async () => {
    const dir = makeTempWorkspace();
    const srv = await startWorkbenchServer({
      workspaceRoot: dir,
      port: 14800,
      token: "p2-ops-token",
      watch: false
    });
    runningServers.push(srv);

    const initial = await apiRequest({
      port: srv.port,
      token: srv.token,
      path: "/api/graphs/announcement-pipeline"
    });
    const baseHash = String(initial.json.hash);

    // 1. Valid manual op via POST /ops
    const edit1 = await apiRequest({
      port: srv.port,
      token: srv.token,
      method: "POST",
      path: "/api/graphs/announcement-pipeline/ops",
      body: {
        baseHash,
        ops: [
          {
            op: "update_node",
            id: "K2",
            set: { status: "active", conclusion: "正在核对财报占比" }
          }
        ],
        snapshotBefore: true,
        title: "手动更新 K2 前快照"
      }
    });
    expect(edit1.status).toBe(200);
    expect(edit1.json.ok).toBe(true);
    const hashAfterEdit1 = String(edit1.json.hash);
    expect(hashAfterEdit1).not.toBe(baseHash);
    expect(edit1.json.savedRev).toBeTruthy();

    // 2. Stale baseHash -> 409 STALE_BASE
    const stale = await apiRequest({
      port: srv.port,
      token: srv.token,
      method: "POST",
      path: "/api/graphs/announcement-pipeline/ops",
      body: {
        baseHash, // stale!
        ops: [{ op: "update_node", id: "K3", set: { status: "active" } }]
      }
    });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe("STALE_BASE");
    expect(stale.json.currentHash).toBe(hashAfterEdit1);

    // 3. Undo via returned inverse ops -> returns exact original baseHash
    const undo = await apiRequest({
      port: srv.port,
      token: srv.token,
      method: "POST",
      path: "/api/graphs/announcement-pipeline/ops",
      body: {
        baseHash: hashAfterEdit1,
        ops: edit1.json.inverse
      }
    });
    expect(undo.status).toBe(200);
    expect(undo.json.hash).toBe(baseHash);

    // 4. Re-apply edit1, then rollback to rev 1, then verify rollback itself is reversible!
    const edit2 = await apiRequest({
      port: srv.port,
      token: srv.token,
      method: "POST",
      path: "/api/graphs/announcement-pipeline/ops",
      body: {
        baseHash,
        ops: [{ op: "update_node", id: "K3", set: { status: "done", conclusion: "已完成核对" } }]
      }
    });
    const hashAfterEdit2 = String(edit2.json.hash);

    const hist1 = await apiRequest({
      port: srv.port,
      token: srv.token,
      path: "/api/graphs/announcement-pipeline/history"
    });
    expect((hist1.json.entries as unknown[]).length).toBeGreaterThanOrEqual(1);

    const rb1 = await apiRequest({
      port: srv.port,
      token: srv.token,
      method: "POST",
      path: "/api/graphs/announcement-pipeline/rollback",
      body: { rev: 1 }
    });
    expect(rb1.status).toBe(200);
    expect(rb1.json.hash).toBe(baseHash);
    const savedPreRollbackRev = (rb1.json.savedRev as { rev: number }).rev;

    // Roll back the rollback -> restores hashAfterEdit2!
    const rb2 = await apiRequest({
      port: srv.port,
      token: srv.token,
      method: "POST",
      path: "/api/graphs/announcement-pipeline/rollback",
      body: { rev: savedPreRollbackRev }
    });
    expect(rb2.status).toBe(200);
    expect(rb2.json.hash).toBe(hashAfterEdit2);
  });

  it("handles patch conflict rebase when human edits same node before applying patch", async () => {
    const dir = makeTempWorkspace();
    const srv = await startWorkbenchServer({
      workspaceRoot: dir,
      port: 14820,
      token: "p2-patch-token",
      watch: false
    });
    runningServers.push(srv);

    const initial = await apiRequest({
      port: srv.port,
      token: srv.token,
      path: "/api/graphs/announcement-pipeline"
    });
    const baseHash = String(initial.json.hash);

    // 1. Propose patch touching K3 and adding K7 + edge K7->H10
    const prop = await apiRequest({
      port: srv.port,
      token: srv.token,
      method: "POST",
      path: "/api/graphs/announcement-pipeline/patches",
      body: {
        title: "K3 调研完成 + 新增 K7",
        rationale: "核对完毕并补充后续任务",
        author: "codex",
        ops: [
          { op: "update_node", id: "K3", set: { status: "done", conclusion: "AI 结论" } },
          {
            op: "add_node",
            node: {
              id: "K7",
              parentId: "K",
              type: "task",
              title: "编写结构化财报映射",
              status: "todo"
            },
            after: "K6"
          },
          { op: "add_edge", source: "K7", target: "H10" }
        ]
      }
    });
    expect(prop.status).toBe(200);
    const patchId = (prop.json.patch as { id: string }).id;

    // 2. Human manually edits K3 before reviewing patch
    const humanEdit = await apiRequest({
      port: srv.port,
      token: srv.token,
      method: "POST",
      path: "/api/graphs/announcement-pipeline/ops",
      body: {
        baseHash,
        ops: [{ op: "update_node", id: "K3", set: { status: "active" } }]
      }
    });
    expect(humanEdit.status).toBe(200);

    // 3. Fetch patches -> op 0 (K3) is conflicted & unchecked by default, ops 1 & 2 are clean
    const listRes = await apiRequest({
      port: srv.port,
      token: srv.token,
      path: "/api/graphs/announcement-pipeline/patches"
    });
    const patches = listRes.json.patches as Array<{
      patch: { id: string };
      evaluation: {
        hasConflicts: boolean;
        defaultSelectedIndices: number[];
        ops: Array<{ index: number; conflicted: boolean; defaultSelected: boolean }>;
      };
    }>;
    expect(patches).toHaveLength(1);
    expect(patches[0]!.evaluation.hasConflicts).toBe(true);
    expect(patches[0]!.evaluation.ops[0]!.conflicted).toBe(true);
    expect(patches[0]!.evaluation.ops[0]!.defaultSelected).toBe(false);
    expect(patches[0]!.evaluation.defaultSelectedIndices).toEqual([1, 2]);

    // 4. Apply without overriding `only` -> applies only non-conflicted [1, 2], preserves human edit!
    const applied = await apiRequest({
      port: srv.port,
      token: srv.token,
      method: "POST",
      path: `/api/graphs/announcement-pipeline/patches/${encodeURIComponent(patchId)}/apply`,
      body: {}
    });
    expect(applied.status).toBe(200);
    expect(applied.json.appliedIndices).toEqual([1, 2]);
    expect(applied.json.skippedIndices).toEqual([0]);
    expect((applied.json.patch as { state: string }).state).toBe("partially_applied");

    const updatedNodes = (applied.json.graph as { nodes: Array<{ id: string; status?: string }> })
      .nodes;
    expect(updatedNodes.find((n) => n.id === "K3")?.status).toBe("active");
    expect(updatedNodes.find((n) => n.id === "K7")).toBeDefined();
  });

  it("reverts unauthorized direct external file edits back to baseline", async () => {
    const dir = makeTempWorkspace();
    const srv = await startWorkbenchServer({
      workspaceRoot: dir,
      port: 14840,
      token: "p2-ext-token",
      watch: true
    });
    runningServers.push(srv);

    const graphFile = path.join(
      dir,
      ".thoughtchain",
      "graphs",
      "announcement-pipeline.tgraph.json"
    );
    await new Promise((r) => setTimeout(r, 150));

    // Simulate external Agent directly modifying JSON on disk
    const raw = JSON.parse(fs.readFileSync(graphFile, "utf8"));
    const k3 = raw.nodes.find((n: { id: string }) => n.id === "K3");
    k3.status = "discarded";
    k3.statusNote = "未经审查直接否决";
    fs.writeFileSync(graphFile, JSON.stringify(raw, null, 2), "utf8");

    // Wait for watcher to detect external change
    let pending: Record<string, unknown> | null = null;
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const res = await apiRequest({
        port: srv.port,
        token: srv.token,
        path: "/api/graphs/announcement-pipeline/external"
      });
      if (res.json.pendingExternalChange) {
        pending = res.json.pendingExternalChange as Record<string, unknown>;
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    expect(pending).not.toBeNull();
    expect((pending!.ops as unknown[]).length).toBeGreaterThan(0);

    // One-click revert restores disk file back to baseline (K3.status === "todo")
    const revRes = await apiRequest({
      port: srv.port,
      token: srv.token,
      method: "POST",
      path: "/api/graphs/announcement-pipeline/external/revert"
    });
    expect(revRes.status).toBe(200);

    const diskAfterRevert = JSON.parse(fs.readFileSync(graphFile, "utf8"));
    expect(diskAfterRevert.nodes.find((n: { id: string }) => n.id === "K3").status).toBe("todo");
  });

  it("supports CLI patch propose/list/show/apply/reject and history/rollback", () => {
    const dir = makeTempWorkspace();
    const patchInput = path.join(dir, "sample-patch.json");
    fs.writeFileSync(
      patchInput,
      JSON.stringify(
        {
          title: "CLI 测试提案",
          rationale: "通过 CLI 提交并部分应用",
          author: "cli-test",
          ops: [
            { op: "update_node", id: "K2", set: { status: "done", conclusion: "CLI 结论" } },
            { op: "update_node", id: "K3", set: { status: "active" } }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const propOut = JSON.parse(
      execFileSync(
        process.execPath,
        [CLI_DIST, "-C", dir, "patch", "propose", "announcement-pipeline", "--file", patchInput],
        { encoding: "utf8" }
      )
    );
    expect(propOut.ok).toBe(true);
    const patchId: string = propOut.patchId;

    const listOut = JSON.parse(
      execFileSync(process.execPath, [CLI_DIST, "-C", dir, "patch", "list"], {
        encoding: "utf8"
      })
    );
    expect(listOut.count).toBe(1);

    const showOut = JSON.parse(
      execFileSync(process.execPath, [CLI_DIST, "-C", dir, "patch", "show", patchId], {
        encoding: "utf8"
      })
    );
    expect(showOut.patch.id).toBe(patchId);

    // Apply only op 0
    const applyOut = JSON.parse(
      execFileSync(
        process.execPath,
        [CLI_DIST, "-C", dir, "patch", "apply", patchId, "--only", "0"],
        { encoding: "utf8" }
      )
    );
    expect(applyOut.ok).toBe(true);
    expect(applyOut.state).toBe("partially_applied");
    expect(applyOut.appliedIndices).toEqual([0]);

    const histOut = JSON.parse(
      execFileSync(
        process.execPath,
        [CLI_DIST, "-C", dir, "history", "announcement-pipeline"],
        { encoding: "utf8" }
      )
    );
    expect(histOut.count).toBe(1);

    const rbOut = JSON.parse(
      execFileSync(
        process.execPath,
        [CLI_DIST, "-C", dir, "rollback", "announcement-pipeline", "1"],
        { encoding: "utf8" }
      )
    );
    expect(rbOut.ok).toBe(true);
    expect(rbOut.rolledBackToRev).toBe(1);
  });

  it("exposes strictly 5 MCP tools over stdio, compiles context, writes patches, and rejects invalid patches", async () => {
    const dir = makeTempWorkspace();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_DIST, "mcp", dir]
    });
    const client = new Client({ name: "tchain-test-client", version: "0.1.0" });

    try {
      await client.connect(transport);

      // 1. Verify strictly 5 tools (no direct graph write tool)
      const listed = await client.listTools();
      const toolNames = listed.tools.map((t) => t.name).sort();
      expect(toolNames).toEqual([
        "get_graph_overview",
        "get_node_context",
        "list_graphs",
        "propose_graph_patch",
        "search_nodes"
      ]);

      // 2. list_graphs
      const lg = await client.callTool({ name: "list_graphs", arguments: {} });
      const lgText = (lg.content as Array<{ text: string }>)[0]!.text;
      const lgJson = JSON.parse(lgText);
      expect(lgJson.ok).toBe(true);
      expect(lgJson.graphs[0].id).toBe("announcement-pipeline");

      // 3. get_graph_overview
      const ov = await client.callTool({
        name: "get_graph_overview",
        arguments: { graphId: "announcement-pipeline", maxDepth: 2 }
      });
      const ovJson = JSON.parse((ov.content as Array<{ text: string }>)[0]!.text);
      expect(ovJson.ok).toBe(true);
      expect(ovJson.overview.focus.activeIds).toEqual(["K1"]);

      // 4. get_node_context (K3) -> 6-section markdown brief
      const ctx = await client.callTool({
        name: "get_node_context",
        arguments: { graphId: "announcement-pipeline", nodeId: "K3", format: "md" }
      });
      const ctxMd = (ctx.content as Array<{ text: string }>)[0]!.text;
      expect(ctxMd).toContain("## ① 全局目标");
      expect(ctxMd).toContain("## ③ 避坑约束");
      expect(ctxMd).toContain("Tushare");
      expect(ctxMd).toContain("## ④ 可恢复路线");

      // 5. search_nodes
      const srch = await client.callTool({
        name: "search_nodes",
        arguments: { graphId: "announcement-pipeline", query: "财报" }
      });
      const srchJson = JSON.parse((srch.content as Array<{ text: string }>)[0]!.text);
      expect(srchJson.count).toBeGreaterThanOrEqual(2);

      // 6. propose_graph_patch with INVALID ops (parentId cycle / missing endpoint / duplicate id)
      const badPatch = await client.callTool({
        name: "propose_graph_patch",
        arguments: {
          graphId: "announcement-pipeline",
          title: "非法提案",
          rationale: "测试拦截",
          ops: [{ op: "add_edge", source: "K1", target: "NON_EXISTENT" }]
        }
      });
      expect(badPatch.isError).toBe(true);
      const badJson = JSON.parse((badPatch.content as Array<{ text: string }>)[0]!.text);
      expect(badJson.code).toBe("VALIDATION_ERROR");
      expect(badJson.diagnostics[0].code).toBe("EDGE_MISSING_ENDPOINT");

      // 7. propose_graph_patch with VALID ops -> writes patch file, does NOT mutate graph file
      const goodPatch = await client.callTool({
        name: "propose_graph_patch",
        arguments: {
          graphId: "announcement-pipeline",
          title: "MCP 提交 K3 结论",
          rationale: "核对完成",
          author: "antigravity",
          ops: [
            {
              op: "update_node",
              id: "K3",
              set: { status: "done", conclusion: "结构化财报可替代" }
            }
          ]
        }
      });
      expect(goodPatch.isError).toBeFalsy();
      const goodJson = JSON.parse((goodPatch.content as Array<{ text: string }>)[0]!.text);
      expect(goodJson.ok).toBe(true);
      expect(goodJson.patchId).toBeTruthy();

      // Verify graph file on disk was NOT directly mutated
      const diskGraph = JSON.parse(
        fs.readFileSync(
          path.join(dir, ".thoughtchain", "graphs", "announcement-pipeline.tgraph.json"),
          "utf8"
        )
      );
      expect(diskGraph.nodes.find((n: { id: string }) => n.id === "K3").status).toBe("todo");
    } finally {
      await client.close();
    }
  });
});
