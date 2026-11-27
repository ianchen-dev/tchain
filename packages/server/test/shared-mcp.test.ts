import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ensureWorkspaceService, type WorkspaceService } from "../src/service.js";
import { initWorkspace } from "../src/workspace.js";

const dirs: string[] = [];
const services: WorkspaceService[] = [];
const clients: Client[] = [];
const children: ChildProcess[] = [];
const cli = path.resolve(import.meta.dirname, "../dist/cli.js");

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tchain-shared-"));
  dirs.push(dir);
  initWorkspace(dir);
  fs.copyFileSync(path.resolve(import.meta.dirname, "../../../fixtures/announcement-pipeline.tgraph.json"),
    path.join(dir, ".thoughtchain/graphs/announcement-pipeline.tgraph.json"));
  return dir;
}

async function start(dir: string): Promise<WorkspaceService> {
  const service = await ensureWorkspaceService({ workspaceRoot: dir, port: 18100, watch: false });
  services.push(service);
  return service;
}

async function connect(service: WorkspaceService, name: string): Promise<Client> {
  const token = fs.readFileSync(path.join(service.workspaceRoot, ".thoughtchain/.server-token"), "utf8").trim();
  const client = new Client({ name, version: "1.0.0" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(service.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  }));
  return client;
}

function resultJson(result: Awaited<ReturnType<Client["callTool"]>>) {
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill();
      await closed;
    }
  }
  for (const service of services.splice(0)) await service.server?.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("shared workspace Web + HTTP MCP service", () => {
  it("lets independent clients discover and propose concurrently without editing the graph", async () => {
    const dir = workspace();
    const service = await start(dir);
    const [codex, cursor] = await Promise.all([connect(service, "codex"), connect(service, "cursor")]);
    const graphFile = path.join(dir, ".thoughtchain/graphs/announcement-pipeline.tgraph.json");
    const before = fs.readFileSync(graphFile, "utf8");
    const tools = await Promise.all([codex.listTools(), cursor.listTools()]);
    expect(tools.map((t) => t.tools.length)).toEqual([6, 6]);
    const proposals = await Promise.all([codex, cursor].map((client, i) => client.callTool({
      name: "propose_graph_patch",
      arguments: {
        graphId: "announcement-pipeline", title: `client ${i}`, rationale: "concurrent test",
        ops: [{ op: "update_node", id: "K3", set: { status: "active" } }]
      }
    })));
    expect(proposals.map((p) => resultJson(p).ok)).toEqual([true, true]);
    expect(new Set(proposals.map((p) => resultJson(p).patchId)).size).toBe(2);
    expect(fs.readFileSync(graphFile, "utf8")).toBe(before);
    for (const client of [codex, cursor]) {
      const list = resultJson(await client.callTool({ name: "list_graphs", arguments: {} }));
      expect(list.workspaceRoot).toBe(service.workspaceRoot);
      expect(list.graphs[0].pendingPatchCount).toBe(2);
    }
    await codex.close();
    expect((await cursor.listTools()).tools).toHaveLength(6);
  });

  it("isolates workspaces and rejects invalid authentication and cross-site requests", async () => {
    const a = await start(workspace());
    const b = await start(workspace());
    const ca = await connect(a, "a");
    const cb = await connect(b, "b");
    expect(resultJson(await ca.callTool({ name: "list_graphs" })).workspaceRoot).toBe(a.workspaceRoot);
    expect(resultJson(await cb.callTool({ name: "list_graphs" })).workspaceRoot).toBe(b.workspaceRoot);
    const token = fs.readFileSync(path.join(a.workspaceRoot, ".thoughtchain/.server-token"), "utf8").trim();
    const request = (headers: Record<string, string>) => fetch(a.mcpUrl, { method: "POST", headers, body: "{}" });
    expect((await request({})).status).toBe(401);
    expect((await request({ Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await request({ Authorization: `Bearer ${token}`, Origin: "https://evil.example" })).status).toBe(403);
    expect((await request({ Authorization: `Bearer ${token}`, "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    // Fetch may replace Host, so exercise the actual wire header with node:http.
    const badHost = await new Promise<number>((resolve, reject) => {
      const req = http.request(a.mcpUrl, { method: "POST", headers: {
        Authorization: `Bearer ${token}`, Host: "evil.example"
      } }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject);
      req.end("{}");
    });
    expect(badHost).toBe(403);
    for (const method of ["GET", "DELETE"]) {
      expect((await fetch(a.mcpUrl, { method, headers: { Authorization: `Bearer ${token}` } })).status).toBe(405);
    }
  });

  it("reuses a healthy workspace despite a different requested port; keeps token on restart", async () => {
    const dir = workspace();
    const first = await start(dir);
    const second = await ensureWorkspaceService({ workspaceRoot: path.join(dir, "."), port: first.port + 20 });
    expect(second.reused).toBe(true);
    expect(second.server).toBeUndefined();
    expect(second.mcpUrl).toBe(first.mcpUrl);
    expect(second.pid).toBe(first.pid);
    await first.server!.close();
    expect(fs.existsSync(path.join(dir, ".thoughtchain/server.json"))).toBe(false);
    const third = await start(dir);
    expect(third.reused).toBe(false);
    expect(third.url).toBe(first.url);
    expect(third.instanceId).not.toBe(first.instanceId);
    const alias = path.join(dir, "alias");
    fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    try {
      expect((await ensureWorkspaceService({ workspaceRoot: alias })).instanceId).toBe(third.instanceId);
    } finally {
      fs.unlinkSync(alias);
    }
  });

  it("recovers dead instance records but refuses to duplicate a live service with wrong identity", async () => {
    const dir = workspace();
    const recordFile = path.join(dir, ".thoughtchain/server.json");
    fs.writeFileSync(recordFile, JSON.stringify({ version: 1, workspaceRoot: dir, pid: 2147483647,
      instanceId: "00000000-0000-4000-8000-000000000001", port: 18100 }));
    const service = await start(dir);
    expect(service.reused).toBe(false);
    const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    const tokenFile = path.join(dir, ".thoughtchain/.server-token");
    const token = fs.readFileSync(tokenFile, "utf8");
    fs.writeFileSync(tokenFile, "a".repeat(48));
    await expect(start(dir)).rejects.toThrow("failed authentication/health checks");
    fs.writeFileSync(tokenFile, token);
    fs.writeFileSync(recordFile, JSON.stringify({ ...record, instanceId: "00000000-0000-4000-8000-000000000002" }));
    await expect(start(dir)).rejects.toThrow("identity mismatch");
    // Restore ownership so teardown can remove its own record.
    fs.writeFileSync(recordFile, JSON.stringify(record));
  });

  it("serializes simultaneous CLI starts in separate processes", async () => {
    const dir = workspace();
    const launch = () => new Promise<Record<string, any>>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "serve", dir, "--port", "18200"], { windowsHide: true });
      children.push(child);
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => reject(new Error(`CLI timeout: ${stderr}`)), 8000);
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        try {
          const result = JSON.parse(stdout);
          clearTimeout(timeout);
          resolve(result);
        } catch { /* Wait for the complete JSON result. */ }
      });
      child.on("error", (err) => { clearTimeout(timeout); reject(err); });
      child.on("exit", (code) => {
        if (code) { clearTimeout(timeout); reject(new Error(`CLI exited ${code}: ${stderr} ${stdout}`)); }
      });
    });
    const results = await Promise.all([launch(), launch(), launch()]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => !r.reused)).toHaveLength(1);
    expect(new Set(results.map((r) => r.pid)).size).toBe(1);
    expect(new Set(results.map((r) => r.mcpUrl)).size).toBe(1);
    const owner = children.find((child) => child.pid === results[0]!.pid)!;
    const stopped = once(owner, "close");
    owner.kill();
    await stopped;
    // A crash leaves server.json behind; the next start must recover it.
    expect(fs.existsSync(path.join(dir, ".thoughtchain/server.json"))).toBe(true);
    const recovered = await start(dir);
    expect(recovered.reused).toBe(false);
    expect(recovered.pid).toBe(process.pid);
  }, 15000);
});
