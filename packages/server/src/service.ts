import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import { startWorkbenchServer, type RunningServer, type StartServerOptions } from "./server.js";

const InstanceSchema = z.object({
  version: z.literal(1),
  workspaceRoot: z.string(),
  pid: z.number().int().positive(),
  instanceId: z.string().uuid(),
  port: z.number().int().min(1).max(65535)
});
type Instance = z.infer<typeof InstanceSchema>;

export interface WorkspaceService extends Instance {
  host: "127.0.0.1";
  url: string;
  mcpUrl: string;
  reused: boolean;
  /** Only the process that started the listener owns shutdown. */
  server?: RunningServer;
}

function readInstance(file: string): Instance | undefined {
  try {
    const parsed = InstanceSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function sameWorkspace(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** CLI entry point: one Web + HTTP MCP listener per canonical workspace. */
export async function ensureWorkspaceService(
  options: Omit<StartServerOptions, "token" | "instanceId">
): Promise<WorkspaceService> {
  const workspaceRoot = fs.realpathSync.native(path.resolve(options.workspaceRoot));
  const stateDir = path.join(workspaceRoot, ".thoughtchain");
  fs.mkdirSync(stateDir, { recursive: true });
  const recordFile = path.join(stateDir, "server.json");
  const tokenFile = path.join(stateDir, ".server-token");
  const lockOptions = {
    lockfilePath: path.join(stateDir, ".server-start.lock"),
    realpath: false,
    stale: 10_000,
    retries: { retries: 30, minTimeout: 80, maxTimeout: 200 }
  };
  const release = await lockfile.lock(stateDir, lockOptions);
  try {
    // Upgrade existing workspaces without rewriting their graphs or schema.
    const ignoreFile = path.join(stateDir, ".gitignore");
    const existing = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, "utf8") : "";
    const entries = ["server.json", ".server-token", ".server-start.lock/"];
    const missing = entries.filter((entry) => !existing.split(/\r?\n/).includes(entry));
    if (missing.length) {
      fs.appendFileSync(ignoreFile, `${existing && !existing.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
    }

    let token: string;
    if (fs.existsSync(tokenFile)) {
      token = fs.readFileSync(tokenFile, "utf8").trim();
      if (!/^[a-f0-9]{48}$/.test(token)) throw new Error(`Invalid service token file: ${tokenFile}`);
    } else {
      token = crypto.randomBytes(24).toString("hex");
      fs.writeFileSync(tokenFile, `${token}\n`, { flag: "wx", mode: 0o600 });
    }

    const describe = (record: Instance, reused: boolean, server?: RunningServer): WorkspaceService => ({
      ...record,
      host: "127.0.0.1",
      url: `http://127.0.0.1:${record.port}/?token=${token}`,
      mcpUrl: `http://127.0.0.1:${record.port}/mcp`,
      reused,
      server
    });
    const previous = readInstance(recordFile);
    if (previous && isAlive(previous.pid)) {
      // A PID alone is insufficient: verify authenticated identity at its endpoint.
      let health: Record<string, unknown>;
      try {
        const response = await fetch(`http://127.0.0.1:${previous.port}/api/health`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(1500)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        health = await response.json() as Record<string, unknown>;
      } catch {
        throw new Error(`Workspace service PID ${previous.pid} is alive but failed authentication/health checks; refusing to start a duplicate.`);
      }
      if (!sameWorkspace(previous.workspaceRoot, workspaceRoot) ||
          health.workspaceRoot !== previous.workspaceRoot || health.pid !== previous.pid ||
          health.instanceId !== previous.instanceId || health.mcpUrl !== describe(previous, true).mcpUrl) {
        throw new Error("Workspace service identity mismatch; refusing to reuse or replace an unrelated service.");
      }
      return describe(previous, true);
    }

    const instanceId = crypto.randomUUID();
    const server = await startWorkbenchServer({ ...options, workspaceRoot, token, instanceId });
    const record: Instance = { version: 1, workspaceRoot, pid: process.pid, instanceId, port: server.port };
    try {
      await writeFileAtomic(recordFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    } catch (err) {
      await server.close();
      throw err;
    }
    const closeListener = server.close;
    let closing: Promise<void> | undefined;
    server.close = () => closing ??= (async () => {
      const unlock = await lockfile.lock(stateDir, lockOptions);
      try {
        await closeListener();
        if (readInstance(recordFile)?.instanceId === instanceId) fs.rmSync(recordFile, { force: true });
      } finally {
        await unlock();
      }
    })();
    return describe(record, false, server);
  } finally {
    await release();
  }
}
