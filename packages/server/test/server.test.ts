import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tchain-srv-test-"));
  tempDirs.push(dir);
  initWorkspace(dir);
  fs.copyFileSync(
    FIXTURE_PATH,
    path.join(dir, ".thoughtchain", "graphs", "announcement-pipeline.tgraph.json")
  );
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs", "sample.md"), "# 调研结论\n\n- 费用可控\n", "utf8");
  fs.writeFileSync(path.join(dir, ".env"), "SECRET_KEY=do-not-leak\n", "utf8");
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  fs.writeFileSync(path.join(dir, ".thoughtchain", ".lock"), "locked", "utf8");
  fs.writeFileSync(path.join(dir, "script.js"), "console.log('nope');", "utf8");
  return dir;
}

function rawHttpRequest(opts: {
  port: number;
  path: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: opts.port,
        path: opts.path,
        method: "GET",
        headers: opts.headers
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    req.on("error", reject);
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

describe("tchain serve security, file boundaries, SSE hot-reload & tchain list", () => {
  it("lists graphs with accurate status counts via tchain list", () => {
    const dir = makeTempWorkspace();
    const stdout = execFileSync(process.execPath, [CLI_DIST, "list", dir], {
      cwd: dir,
      encoding: "utf8"
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(1);
    expect(parsed.graphs[0].id).toBe("announcement-pipeline");
    expect(parsed.graphs[0].valid).toBe(true);
    expect(parsed.graphs[0].counts.active).toBe(1);
    expect(parsed.graphs[0].focusActiveIds).toEqual(["K1"]);
  });

  it("enforces token auth, HttpOnly SameSite=Strict cookie bootstrap, and Host/Origin checks", async () => {
    const dir = makeTempWorkspace();
    const srv = await startWorkbenchServer({
      workspaceRoot: dir,
      port: 14500,
      token: "test-secret-token-123",
      watch: false
    });
    runningServers.push(srv);

    // 1. Auto-increment port when second server starts on same port
    const srv2 = await startWorkbenchServer({
      workspaceRoot: dir,
      port: srv.port,
      token: "second-token",
      watch: false
    });
    runningServers.push(srv2);
    expect(srv2.port).toBe(srv.port + 1);

    // 2. Unauthenticated API request rejected with 401
    const unauth = await rawHttpRequest({
      port: srv.port,
      path: "/api/graphs"
    });
    expect(unauth.status).toBe(401);

    // 3. Cross-origin request rejected with 403
    const crossOrigin = await rawHttpRequest({
      port: srv.port,
      path: "/api/graphs",
      headers: {
        Origin: "https://evil.example.com",
        Authorization: `Bearer ${srv.token}`
      }
    });
    expect(crossOrigin.status).toBe(403);
    expect(JSON.parse(crossOrigin.body).code).toBe("INVALID_ORIGIN");

    // 4. DNS rebinding (invalid Host header) rejected with 403
    const badHost = await rawHttpRequest({
      port: srv.port,
      path: "/api/graphs",
      headers: {
        Host: `attacker.local:${srv.port}`,
        Authorization: `Bearer ${srv.token}`
      }
    });
    expect(badHost.status).toBe(403);
    expect(JSON.parse(badHost.body).code).toBe("INVALID_HOST");

    // 5. Cross-site Sec-Fetch-Site rejected with 403
    const crossSite = await rawHttpRequest({
      port: srv.port,
      path: "/api/graphs",
      headers: {
        "Sec-Fetch-Site": "cross-site",
        Authorization: `Bearer ${srv.token}`
      }
    });
    expect(crossSite.status).toBe(403);

    // 6. Token URL sets HttpOnly; SameSite=Strict cookie and redirects to /
    const boot = await rawHttpRequest({
      port: srv.port,
      path: `/?token=${srv.token}`
    });
    expect(boot.status).toBe(302);
    const setCookieHeader = String(boot.headers["set-cookie"] ?? "");
    expect(setCookieHeader).toContain(`tchain_token=${srv.token}`);
    expect(setCookieHeader).toContain("HttpOnly");
    expect(setCookieHeader).toContain("SameSite=Strict");

    // 7. Cookie authenticates /api/graphs and /api/graphs/:id
    const cookieVal = `tchain_token=${srv.token}`;
    const listRes = await rawHttpRequest({
      port: srv.port,
      path: "/api/graphs",
      headers: { Cookie: cookieVal }
    });
    expect(listRes.status).toBe(200);
    expect(JSON.parse(listRes.body).graphs[0].id).toBe("announcement-pipeline");

    const detailRes = await rawHttpRequest({
      port: srv.port,
      path: "/api/graphs/announcement-pipeline",
      headers: { Cookie: cookieVal }
    });
    expect(detailRes.status).toBe(200);
    const detail = JSON.parse(detailRes.body);
    expect(detail.ok).toBe(true);
    expect(detail.graph.id).toBe("announcement-pipeline");
  });

  it("enforces strict workspace file reading boundaries", async () => {
    const dir = makeTempWorkspace();
    const srv = await startWorkbenchServer({
      workspaceRoot: dir,
      port: 14600,
      token: "file-test-token",
      watch: false
    });
    runningServers.push(srv);
    const authHeaders = { Authorization: `Bearer ${srv.token}` };

    // Valid markdown file inside workspace
    const okMd = await rawHttpRequest({
      port: srv.port,
      path: "/api/files?path=docs/sample.md",
      headers: authHeaders
    });
    expect(okMd.status).toBe(200);
    expect(okMd.body).toContain("# 调研结论");
    expect(okMd.headers["x-content-type-options"]).toBe("nosniff");

    // Path traversal rejected
    const traversal = await rawHttpRequest({
      port: srv.port,
      path: "/api/files?path=../outside.md",
      headers: authHeaders
    });
    expect(traversal.status).toBe(403);

    // .env rejected
    const dotEnv = await rawHttpRequest({
      port: srv.port,
      path: "/api/files?path=.env",
      headers: authHeaders
    });
    expect(dotEnv.status).toBe(403);

    // .git/HEAD rejected
    const dotGit = await rawHttpRequest({
      port: srv.port,
      path: "/api/files?path=.git/HEAD",
      headers: authHeaders
    });
    expect(dotGit.status).toBe(403);

    // .thoughtchain/.lock rejected
    const lockFile = await rawHttpRequest({
      port: srv.port,
      path: "/api/files?path=.thoughtchain/.lock",
      headers: authHeaders
    });
    expect(lockFile.status).toBe(403);

    // Disallowed extension (.js) rejected
    const jsFile = await rawHttpRequest({
      port: srv.port,
      path: "/api/files?path=script.js",
      headers: authHeaders
    });
    expect(jsFile.status).toBe(403);
  });

  it("routes valid external edits into external:changed review and preserves lastValidGraph on invalid edit", async () => {
    const dir = makeTempWorkspace();
    const srv = await startWorkbenchServer({
      workspaceRoot: dir,
      port: 14700,
      token: "sse-test-token",
      watch: true
    });
    runningServers.push(srv);

    const graphFile = path.join(
      dir,
      ".thoughtchain",
      "graphs",
      "announcement-pipeline.tgraph.json"
    );

    // Open SSE connection
    const receivedEvents: Array<{ event: string; data: Record<string, unknown>; at: number }> = [];
    const sseReq = http.request({
      host: "127.0.0.1",
      port: srv.port,
      path: "/api/events",
      headers: { Authorization: `Bearer ${srv.token}` }
    });

    await new Promise<void>((resolve, reject) => {
      sseReq.on("error", reject);
      sseReq.on("response", (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) {
            let ev = "message";
            let data = "";
            for (const line of frame.split("\n")) {
              if (line.startsWith("event:")) ev = line.slice(6).trim();
              if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (data) {
              receivedEvents.push({
                event: ev,
                data: JSON.parse(data) as Record<string, unknown>,
                at: Date.now()
              });
              if (ev === "hello") resolve();
            }
          }
        });
      });
      sseReq.end();
    });

    // Wait briefly so chokidar finishes registering OS watcher on Windows
    await new Promise((r) => setTimeout(r, 150));

    // 1. Valid external edit -> expect external:changed within 1s, baseline stays unchanged until accepted
    const parsed = JSON.parse(fs.readFileSync(graphFile, "utf8"));
    parsed.title = "公告采集解析方案决策链（已更新）";
    const t0 = Date.now();
    fs.writeFileSync(graphFile, JSON.stringify(parsed, null, 2), "utf8");

    const extChanged = await new Promise<{ event: string; at: number }>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("Timed out waiting for external:changed")),
        2500
      );
      const poll = setInterval(() => {
        const hit = receivedEvents.find((e) => e.event === "external:changed");
        if (hit) {
          clearTimeout(deadline);
          clearInterval(poll);
          resolve(hit);
        }
      }, 20);
    });
    expect(extChanged.at - t0).toBeLessThan(1000);

    // Accept external change via API -> updates baseline without rewriting file
    const acceptRes = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: srv.port,
          path: "/api/graphs/announcement-pipeline/external/accept",
          method: "POST",
          headers: { Authorization: `Bearer ${srv.token}` }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(Buffer.from(c)));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8")
            })
          );
        }
      );
      req.on("error", reject);
      req.end();
    });
    expect(acceptRes.status).toBe(200);

    // 2. Invalid JSON edit -> expect graph:error while preserving lastValidGraph
    fs.writeFileSync(graphFile, "{ invalid json !!!", "utf8");
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("Timed out waiting for graph:error")), 2500);
      const poll = setInterval(() => {
        const hit = receivedEvents.find((e) => e.event === "graph:error");
        if (hit) {
          clearTimeout(deadline);
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });

    const afterErr = await rawHttpRequest({
      port: srv.port,
      path: "/api/graphs/announcement-pipeline",
      headers: { Authorization: `Bearer ${srv.token}` }
    });
    const detail = JSON.parse(afterErr.body);
    expect(detail.ok).toBe(true);
    expect(detail.graph.title).toBe("公告采集解析方案决策链（已更新）");
    expect(detail.lastError).not.toBeNull();
    expect(detail.lastError.errors[0].code).toBe("JSON_PARSE_ERROR");

    sseReq.destroy();
  });
});
