import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { compileContext, computeFocus } from "@tchain/core";
import { resolveSafeWorkspaceFile } from "./files.js";
import { WorkspaceStore, type ServerEvent } from "./store.js";

export const TOKEN_COOKIE_NAME = "tchain_token";

export interface StartServerOptions {
  workspaceRoot: string;
  port?: number;
  maxPortAttempts?: number;
  token?: string;
  webDistDir?: string;
  watch?: boolean;
}

export interface RunningServer {
  host: "127.0.0.1";
  port: number;
  token: string;
  url: string;
  workspaceRoot: string;
  store: WorkspaceStore;
  close: () => Promise<void>;
}

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8"
};

function safeTokenEquals(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function resolveDefaultWebDistDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "web"), // bundled dist/web next to dist/cli.js
    path.resolve(here, "../dist/web"),
    path.resolve(here, "../../web/dist") // monorepo workspace sibling
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) {
      return dir;
    }
  }
  return null;
}

function isAllowedHostHeader(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const lower = hostHeader.trim().toLowerCase();
  return lower === `127.0.0.1:${port}` || lower === `localhost:${port}`;
}

function isAllowedOriginHeader(originHeader: string | undefined, port: number): boolean {
  if (!originHeader) return true;
  const lower = originHeader.trim().toLowerCase();
  return lower === `http://127.0.0.1:${port}` || lower === `http://localhost:${port}`;
}

function extractRequestToken(c: Context): string | undefined {
  const cookieToken = getCookie(c, TOKEN_COOKIE_NAME);
  if (cookieToken) return cookieToken;

  const authHeader = c.req.header("authorization");
  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }

  const queryToken = c.req.query("token");
  if (queryToken) return queryToken;

  return undefined;
}

export function createWorkbenchApp(params: {
  store: WorkspaceStore;
  token: string;
  getPort: () => number;
  webDistDir: string | null;
}): Hono {
  const { store, token, getPort, webDistDir } = params;
  const app = new Hono();

  // 1. Strict Host & Origin validation on every request (PRD §8.5)
  app.use("*", async (c, next) => {
    const port = getPort();
    const host = c.req.header("host");
    if (!isAllowedHostHeader(host, port)) {
      return c.json(
        {
          ok: false,
          code: "INVALID_HOST",
          message: "Host header rejected (DNS rebinding protection)"
        },
        403
      );
    }

    const origin = c.req.header("origin");
    if (!isAllowedOriginHeader(origin, port)) {
      return c.json(
        {
          ok: false,
          code: "INVALID_ORIGIN",
          message: "Cross-origin requests are forbidden"
        },
        403
      );
    }

    const secFetchSite = c.req.header("sec-fetch-site");
    if (
      c.req.path.startsWith("/api/") &&
      secFetchSite &&
      secFetchSite !== "same-origin" &&
      secFetchSite !== "none"
    ) {
      return c.json(
        {
          ok: false,
          code: "CROSS_SITE_FORBIDDEN",
          message: "Cross-site API requests are forbidden"
        },
        403
      );
    }

    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });

  // 2. Token authentication middleware for all /api/* routes
  app.use("/api/*", async (c, next) => {
    const reqToken = extractRequestToken(c);
    if (!safeTokenEquals(reqToken, token)) {
      return c.json(
        {
          ok: false,
          code: "UNAUTHORIZED",
          message: "Missing or invalid session token"
        },
        401
      );
    }
    await next();
  });

  // 3. API endpoints
  app.get("/api/health", (c) => {
    return c.json({
      ok: true,
      version: "0.1.0",
      workspaceRoot: store.workspaceRoot,
      graphCount: store.listSummaries().length
    });
  });

  app.get("/api/graphs", (c) => {
    return c.json({
      ok: true,
      workspaceRoot: store.workspaceRoot,
      graphs: store.listSummaries()
    });
  });

  app.get("/api/graphs/:id", (c) => {
    const graphId = c.req.param("id");
    const entry = store.getEntry(graphId);
    if (!entry) {
      return c.json(
        {
          ok: false,
          code: "GRAPH_NOT_FOUND",
          message: `Graph not found: ${graphId}`
        },
        404
      );
    }

    return c.json({
      ok: entry.lastValidGraph !== null,
      graphId: entry.id,
      file: entry.relFile,
      workspaceRoot: store.workspaceRoot,
      graph: entry.lastValidGraph,
      hash: entry.lastValidHash,
      warnings: entry.lastValidWarnings,
      lastError: entry.lastError
    });
  });

  app.get("/api/graphs/:id/context", (c) => {
    const graphId = c.req.param("id");
    const entry = store.getEntry(graphId);
    if (!entry || !entry.lastValidGraph) {
      return c.json(
        { ok: false, code: "GRAPH_NOT_FOUND", message: `Graph not available: ${graphId}` },
        404
      );
    }

    const graph = entry.lastValidGraph;
    let nodeId = c.req.query("node");
    if (!nodeId) {
      const focus = computeFocus(graph);
      nodeId = focus.activeIds[0] ?? focus.nextIds[0] ?? graph.nodes[0]?.id;
    }
    if (!nodeId) {
      return c.json({ ok: false, code: "NO_NODE", message: "Graph has no nodes" }, 400);
    }

    const format = c.req.query("format") === "json" ? "json" : "md";
    const maxTokensRaw = c.req.query("maxTokens");
    const maxTokens = maxTokensRaw ? Number.parseInt(maxTokensRaw, 10) : undefined;

    try {
      const result = compileContext(graph, nodeId, {
        format,
        maxTokens: maxTokens && Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : undefined
      });
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json(
        {
          ok: false,
          code: "CONTEXT_ERROR",
          message: err instanceof Error ? err.message : String(err)
        },
        400
      );
    }
  });

  // Safe workspace file read API (PRD §8.5)
  app.get("/api/files", (c) => {
    const rawPath = c.req.query("path") ?? "";
    const resolved = resolveSafeWorkspaceFile(store.workspaceRoot, rawPath);
    if (!resolved.ok) {
      return c.json(
        { ok: false, code: resolved.code, message: resolved.message },
        resolved.status
      );
    }

    const data = fs.readFileSync(resolved.absPath);
    const headers: Record<string, string> = {
      "Content-Type": resolved.contentType,
      "Content-Length": String(data.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox"
    };
    return new Response(data, { status: 200, headers });
  });

  // SSE live updates stream (PRD §8.1 / §8.4)
  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: "hello",
        data: JSON.stringify({
          workspaceRoot: store.workspaceRoot,
          graphCount: store.listSummaries().length,
          at: new Date().toISOString()
        })
      });

      const unsubscribe = store.subscribe((event: ServerEvent) => {
        void stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event.payload)
        });
      });

      const heartbeat = setInterval(() => {
        void stream.writeSSE({
          event: "ping",
          data: JSON.stringify({ at: new Date().toISOString() })
        });
      }, 25_000);

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          clearInterval(heartbeat);
          unsubscribe();
          resolve();
        });
      });
    });
  });

  // 4. Token cookie bootstrap + static frontend serving
  app.get("/", (c) => {
    const queryToken = c.req.query("token");
    if (queryToken !== undefined) {
      if (!safeTokenEquals(queryToken, token)) {
        return c.text("Invalid token. Please use the URL printed by `tchain serve`.", 401);
      }
      setCookie(c, TOKEN_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: "Strict",
        path: "/"
      });
      return c.redirect("/", 302);
    }

    const cookieToken = getCookie(c, TOKEN_COOKIE_NAME);
    if (!safeTokenEquals(cookieToken, token)) {
      return c.html(
        `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>tchain — 需要认证</title></head><body style="font-family:system-ui,sans-serif;padding:48px;color:#0f172a;background:#f8fafc;"><h1>ThoughtChain Workbench</h1><p>请使用 <code>tchain serve</code> 终端输出的带 <code>?token=...</code> 访问链接打开工作台。</p></body></html>`,
        401
      );
    }

    if (!webDistDir) {
      return c.text("Web UI assets not built yet. Run `pnpm build` first.", 503);
    }
    const indexHtml = fs.readFileSync(path.join(webDistDir, "index.html"), "utf8");
    return c.html(indexHtml);
  });

  app.get("*", (c) => {
    const cookieToken = getCookie(c, TOKEN_COOKIE_NAME);
    const queryToken = c.req.query("token");
    if (!safeTokenEquals(cookieToken, token) && !safeTokenEquals(queryToken, token)) {
      return c.text("Unauthorized", 401);
    }

    if (!webDistDir) {
      return c.text("Web UI assets not built.", 503);
    }

    const reqPath = c.req.path.replace(/^\/+/, "");
    if (reqPath.includes("..") || reqPath.includes("\0")) {
      return c.text("Forbidden", 403);
    }

    const resolvedDist = path.resolve(webDistDir);
    const candidate = path.resolve(resolvedDist, reqPath);
    const rel = path.relative(resolvedDist, candidate);
    if (!rel.startsWith("..") && !path.isAbsolute(rel) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const ext = path.extname(candidate).toLowerCase();
      const buf = fs.readFileSync(candidate);
      return new Response(buf, {
        status: 200,
        headers: {
          "Content-Type": STATIC_MIME[ext] ?? "application/octet-stream",
          "X-Content-Type-Options": "nosniff"
        }
      });
    }

    // SPA fallback to index.html
    const indexHtml = fs.readFileSync(path.join(resolvedDist, "index.html"), "utf8");
    return c.html(indexHtml);
  });

  return app;
}

async function listenWithPortIncrement(
  app: Hono,
  startPort: number,
  maxAttempts: number
): Promise<{ server: http.Server; port: number }> {
  let port = startPort;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const server = await new Promise<http.Server>((resolve, reject) => {
        const srv = serve(
          {
            fetch: app.fetch,
            hostname: "127.0.0.1",
            port
          },
          () => resolve(srv as http.Server)
        );
        srv.once("error", (err) => {
          reject(err);
        });
      });
      return { server, port };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EADDRINUSE") {
        port += 1;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Unable to bind any port in range ${startPort}..${startPort + maxAttempts - 1}`);
}

export async function startWorkbenchServer(
  options: StartServerOptions
): Promise<RunningServer> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const startPort = options.port ?? 4377;
  const maxAttempts = options.maxPortAttempts ?? 50;
  const token = options.token ?? crypto.randomBytes(24).toString("hex");
  const webDistDir = options.webDistDir ?? resolveDefaultWebDistDir();

  const store = new WorkspaceStore(workspaceRoot);
  let boundPort = startPort;

  const app = createWorkbenchApp({
    store,
    token,
    getPort: () => boundPort,
    webDistDir
  });

  const { server, port } = await listenWithPortIncrement(app, startPort, maxAttempts);
  boundPort = port;

  if (options.watch !== false) {
    store.startWatching();
  }

  const url = `http://127.0.0.1:${port}/?token=${token}`;

  return {
    host: "127.0.0.1",
    port,
    token,
    url,
    workspaceRoot,
    store,
    close: async () => {
      await store.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  };
}
