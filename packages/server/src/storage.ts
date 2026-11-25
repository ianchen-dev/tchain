import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import {
  applyOps,
  applySelectedPatchOps,
  ApplyError,
  diffGraphs,
  evaluatePatchAgainstGraph,
  hashGraph,
  PatchFileSchema,
  preparePatchOps,
  serializeGraph,
  summarizeOps,
  validateGraph,
  type Diagnostic,
  type Graph,
  type HistoryEntry,
  type HistorySource,
  type Op,
  type OpSummaryCounts,
  type PatchEvaluation,
  type PatchFile
} from "@tchain/core";
import {
  HISTORY_SUBDIR,
  makeFileExistsChecker,
  PATCHES_ARCHIVE_SUBDIR,
  PATCHES_SUBDIR,
  resolveGraphFiles,
  THOUGHTCHAIN_DIR
} from "./workspace.js";

export const MAX_HISTORY_REVS = 50;
export const MAX_ARCHIVED_PATCHES = 100;

export class StaleBaseError extends Error {
  readonly code = "STALE_BASE";
  readonly expectedBaseHash: string;
  readonly currentHash: string;

  constructor(expectedBaseHash: string, currentHash: string) {
    super(`图谱版本已变更（期望 ${expectedBaseHash}，当前 ${currentHash}）`);
    this.name = "StaleBaseError";
    this.expectedBaseHash = expectedBaseHash;
    this.currentHash = currentHash;
  }
}

export class NotFoundError extends Error {
  readonly code = "NOT_FOUND";

  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function atomicWriteText(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await writeFileAtomic(filePath, content, { encoding: "utf8" });
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
        await sleep(35 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function withWorkspaceLock<T>(
  workspaceRoot: string,
  fn: () => Promise<T>
): Promise<T> {
  const tcDir = path.join(path.resolve(workspaceRoot), THOUGHTCHAIN_DIR);
  if (!fs.existsSync(tcDir)) {
    fs.mkdirSync(tcDir, { recursive: true });
  }
  const lockPath = path.join(tcDir, ".lock");

  // Guard against a leftover regular file at .thoughtchain/.lock (proper-lockfile uses mkdir)
  try {
    if (fs.existsSync(lockPath) && fs.lstatSync(lockPath).isFile()) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {
    // ignore race
  }

  const release = await lockfile.lock(tcDir, {
    lockfilePath: lockPath,
    realpath: false,
    stale: 15_000,
    retries: {
      retries: 15,
      minTimeout: 30,
      maxTimeout: 200
    }
  });

  try {
    return await fn();
  } finally {
    await release().catch(() => {
      // ignore unlock errors if directory was cleaned up in tests
    });
  }
}

export function findGraphFilePath(workspaceRoot: string, graphId: string): string {
  const files = resolveGraphFiles(workspaceRoot, graphId);
  if (files.length === 0) {
    throw new NotFoundError(`Graph not found: ${graphId}`);
  }
  return files[0]!;
}

export interface LoadedValidatedGraph {
  filePath: string;
  relFile: string;
  graph: Graph;
  hash: string;
  warnings: Diagnostic[];
}

export function readValidatedGraph(
  workspaceRoot: string,
  graphId: string
): LoadedValidatedGraph {
  const filePath = findGraphFilePath(workspaceRoot, graphId);
  const relFile = path.relative(workspaceRoot, filePath).replace(/\\/g, "/");
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ApplyError("Invalid JSON in graph file", [
      {
        level: "error",
        path: "$",
        code: "JSON_PARSE_ERROR",
        message: err instanceof Error ? err.message : String(err)
      }
    ]);
  }

  const fileExists = makeFileExistsChecker(workspaceRoot);
  const validation = validateGraph(parsed, { fileExists });
  if (!validation.ok) {
    throw new ApplyError("Graph file failed validation", validation.errors);
  }

  const graph = parsed as Graph;
  return {
    filePath,
    relFile,
    graph,
    hash: hashGraph(graph),
    warnings: validation.warnings
  };
}

// ── History Snapshots (PRD §5.1 / §7.6) ─────────────────────────────────────

function getHistoryDir(workspaceRoot: string, graphId: string): string {
  return path.join(path.resolve(workspaceRoot), THOUGHTCHAIN_DIR, HISTORY_SUBDIR, graphId);
}

export function formatRevFilename(rev: number): string {
  return `rev-${String(rev).padStart(4, "0")}.json`;
}

export function readHistoryIndex(workspaceRoot: string, graphId: string): HistoryEntry[] {
  const indexPath = path.join(getHistoryDir(workspaceRoot, graphId), "index.json");
  if (!fs.existsSync(indexPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return (parsed as HistoryEntry[]).sort((a, b) => b.rev - a.rev);
  } catch {
    return [];
  }
}

export function readHistorySnapshot(
  workspaceRoot: string,
  graphId: string,
  rev: number
): Graph | null {
  const snapPath = path.join(getHistoryDir(workspaceRoot, graphId), formatRevFilename(rev));
  if (!fs.existsSync(snapPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(snapPath, "utf8"));
    const validation = validateGraph(parsed);
    if (!validation.ok) return null;
    return parsed as Graph;
  } catch {
    return null;
  }
}

export async function saveHistorySnapshotUnlocked(
  workspaceRoot: string,
  graphId: string,
  graph: Graph,
  meta: {
    source: HistorySource;
    title: string;
    counts?: OpSummaryCounts;
  }
): Promise<HistoryEntry> {
  const histDir = getHistoryDir(workspaceRoot, graphId);
  if (!fs.existsSync(histDir)) {
    fs.mkdirSync(histDir, { recursive: true });
  }

  const existing = readHistoryIndex(workspaceRoot, graphId).sort((a, b) => a.rev - b.rev);
  const nextRev = existing.length > 0 ? existing[existing.length - 1]!.rev + 1 : 1;

  const canonicalText = serializeGraph(graph);
  const hash = hashGraph(graph);
  const snapPath = path.join(histDir, formatRevFilename(nextRev));
  await atomicWriteText(snapPath, canonicalText);

  const entry: HistoryEntry = {
    rev: nextRev,
    at: new Date().toISOString(),
    source: meta.source,
    title: meta.title,
    counts: meta.counts ?? summarizeOps([]),
    hash
  };

  const nextIndex = [...existing, entry];
  while (nextIndex.length > MAX_HISTORY_REVS) {
    const evicted = nextIndex.shift()!;
    const evictedPath = path.join(histDir, formatRevFilename(evicted.rev));
    try {
      fs.rmSync(evictedPath, { force: true });
    } catch {
      // ignore cleanup error
    }
  }

  const indexPath = path.join(histDir, "index.json");
  await atomicWriteText(indexPath, `${JSON.stringify(nextIndex, null, 2)}\n`);
  return entry;
}

export async function createManualCheckpoint(
  workspaceRoot: string,
  graphId: string,
  title?: string
): Promise<HistoryEntry> {
  return await withWorkspaceLock(workspaceRoot, async () => {
    const loaded = readValidatedGraph(workspaceRoot, graphId);
    return await saveHistorySnapshotUnlocked(workspaceRoot, graphId, loaded.graph, {
      source: "manual_checkpoint",
      title: title?.trim() || "手动保存还原点",
      counts: summarizeOps([])
    });
  });
}

// ── Unified Mutation Pipeline (PRD §7.1 / §8.4) ─────────────────────────────

export interface MutateGraphParams {
  workspaceRoot: string;
  graphId: string;
  baseHash: string;
  ops: Op[];
  source?: HistorySource;
  title?: string;
  snapshotBefore?: boolean;
  onBeforeWriteHash?: (nextHash: string) => void;
}

export interface MutateGraphResult {
  graph: Graph;
  previousGraph: Graph;
  hash: string;
  previousHash: string;
  inverse: Op[];
  warnings: Diagnostic[];
  savedRev: HistoryEntry | null;
}

export async function mutateGraph(params: MutateGraphParams): Promise<MutateGraphResult> {
  const { workspaceRoot, graphId, baseHash, ops } = params;
  const fileExists = makeFileExistsChecker(workspaceRoot);

  return await withWorkspaceLock(workspaceRoot, async () => {
    const loaded = readValidatedGraph(workspaceRoot, graphId);
    if (loaded.hash !== baseHash) {
      throw new StaleBaseError(baseHash, loaded.hash);
    }

    const applied = applyOps(loaded.graph, ops, { fileExists });
    const nextText = serializeGraph(applied.graph);
    const nextHash = hashGraph(applied.graph);

    const hasCascadeDelete = ops.some((o) => o.op === "remove_node" && o.cascade);
    const shouldSnapshot = Boolean(params.snapshotBefore) || hasCascadeDelete;

    let savedRev: HistoryEntry | null = null;
    if (shouldSnapshot) {
      const source: HistorySource =
        params.source ?? (hasCascadeDelete ? "cascade_delete" : "manual");
      const snapTitle =
        params.title ??
        (hasCascadeDelete ? "级联删除前自动快照" : "变更前自动快照");
      savedRev = await saveHistorySnapshotUnlocked(workspaceRoot, graphId, loaded.graph, {
        source,
        title: snapTitle,
        counts: summarizeOps(ops)
      });
    }

    params.onBeforeWriteHash?.(nextHash);
    await atomicWriteText(loaded.filePath, nextText);

    return {
      graph: applied.graph,
      previousGraph: loaded.graph,
      hash: nextHash,
      previousHash: loaded.hash,
      inverse: applied.inverse,
      warnings: applied.warnings,
      savedRev
    };
  });
}

// ── Rollback (PRD §7.6: reversible rollback) ────────────────────────────────

export interface RollbackResult {
  graph: Graph;
  hash: string;
  rolledBackToRev: number;
  savedRev: HistoryEntry;
  diffOps: Op[];
  warnings: Diagnostic[];
}

export async function rollbackGraph(params: {
  workspaceRoot: string;
  graphId: string;
  rev: number;
  onBeforeWriteHash?: (nextHash: string) => void;
}): Promise<RollbackResult> {
  const { workspaceRoot, graphId, rev } = params;
  const fileExists = makeFileExistsChecker(workspaceRoot);

  return await withWorkspaceLock(workspaceRoot, async () => {
    const loaded = readValidatedGraph(workspaceRoot, graphId);
    const targetGraph = readHistorySnapshot(workspaceRoot, graphId, rev);
    if (!targetGraph) {
      throw new NotFoundError(`History revision rev-${String(rev).padStart(4, "0")} not found`);
    }

    const diffOps = diffGraphs(loaded.graph, targetGraph);
    const savedRev = await saveHistorySnapshotUnlocked(workspaceRoot, graphId, loaded.graph, {
      source: "rollback",
      title: `回退前快照（→ rev-${String(rev).padStart(4, "0")}）`,
      counts: summarizeOps(diffOps)
    });

    const validation = validateGraph(targetGraph, { fileExists });
    const nextText = serializeGraph(targetGraph);
    const nextHash = hashGraph(targetGraph);

    params.onBeforeWriteHash?.(nextHash);
    await atomicWriteText(loaded.filePath, nextText);

    return {
      graph: targetGraph,
      hash: nextHash,
      rolledBackToRev: rev,
      savedRev,
      diffOps,
      warnings: validation.warnings
    };
  });
}

// ── Patch Store (PRD §5.1 / §7.3 / §7.5) ────────────────────────────────────

function getPatchesDir(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), THOUGHTCHAIN_DIR, PATCHES_SUBDIR);
}

function getPatchesArchiveDir(workspaceRoot: string): string {
  return path.join(getPatchesDir(workspaceRoot), PATCHES_ARCHIVE_SUBDIR);
}

function slugifyAscii(input: string, fallback: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return cleaned.length > 0 ? cleaned : fallback;
}

function formatPatchTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function generatePatchId(author: string, title: string): string {
  const ts = formatPatchTimestamp(new Date());
  const authorSlug = slugifyAscii(author, "agent");
  const titleSlug = slugifyAscii(title, "patch");
  const rand = crypto.randomBytes(2).toString("hex");
  return `${ts}-${authorSlug}-${titleSlug}-${rand}`;
}

export interface ProposePatchParams {
  workspaceRoot: string;
  graphId: string;
  title: string;
  rationale: string;
  author?: string;
  ops: Op[];
}

export interface ProposePatchResult {
  patch: PatchFile;
  filePath: string;
  relFile: string;
  summary: OpSummaryCounts;
}

export async function proposePatch(params: ProposePatchParams): Promise<ProposePatchResult> {
  const { workspaceRoot, graphId, title, rationale, ops } = params;
  const author = params.author?.trim() || "agent";
  const fileExists = makeFileExistsChecker(workspaceRoot);

  if (!ops || ops.length === 0) {
    throw new ApplyError("Patch must contain at least one op", [
      {
        level: "error",
        path: "ops",
        code: "EMPTY_OPS",
        message: "变更提案至少需要包含 1 条原子操作",
        hint: "请在 ops 数组中提供 add_node / update_node / remove_node / add_edge / remove_edge 操作"
      }
    ]);
  }

  return await withWorkspaceLock(workspaceRoot, async () => {
    const loaded = readValidatedGraph(workspaceRoot, graphId);
    const prepared = preparePatchOps(loaded.graph, ops, { fileExists });

    const id = generatePatchId(author, title);
    const patch: PatchFile = {
      id,
      graphId: loaded.graph.id,
      baseHash: loaded.hash,
      author,
      title: title.trim() || "AI 变更提案",
      rationale: rationale.trim(),
      createdAt: new Date().toISOString(),
      state: "pending",
      ops: prepared.ops,
      diagnostics: prepared.warnings
    };

    const patchesDir = getPatchesDir(workspaceRoot);
    if (!fs.existsSync(patchesDir)) {
      fs.mkdirSync(patchesDir, { recursive: true });
    }
    const filePath = path.join(patchesDir, `${id}.patch.json`);
    await atomicWriteText(filePath, `${JSON.stringify(patch, null, 2)}\n`);

    return {
      patch,
      filePath,
      relFile: path.relative(workspaceRoot, filePath).replace(/\\/g, "/"),
      summary: prepared.summary
    };
  });
}

export interface PendingPatchRecord {
  patch: PatchFile;
  filePath: string;
  relFile: string;
  evaluation?: PatchEvaluation;
}

export function listPendingPatches(
  workspaceRoot: string,
  graphId?: string
): PendingPatchRecord[] {
  const patchesDir = getPatchesDir(workspaceRoot);
  if (!fs.existsSync(patchesDir)) return [];

  const fileExists = makeFileExistsChecker(workspaceRoot);
  const graphCache = new Map<string, Graph | null>();

  const loadGraphCached = (gid: string): Graph | null => {
    if (graphCache.has(gid)) return graphCache.get(gid) ?? null;
    try {
      const loaded = readValidatedGraph(workspaceRoot, gid);
      graphCache.set(gid, loaded.graph);
      return loaded.graph;
    } catch {
      graphCache.set(gid, null);
      return null;
    }
  };

  const files = fs
    .readdirSync(patchesDir)
    .filter((name) => name.endsWith(".patch.json"))
    .sort()
    .reverse();

  const records: PendingPatchRecord[] = [];
  for (const name of files) {
    const filePath = path.join(patchesDir, name);
    try {
      if (!fs.statSync(filePath).isFile()) continue;
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const parsed = PatchFileSchema.safeParse(raw);
      if (!parsed.success) continue;
      const patch = parsed.data;
      if (graphId && patch.graphId !== graphId) continue;

      const curGraph = loadGraphCached(patch.graphId);
      const evaluation = curGraph
        ? evaluatePatchAgainstGraph(curGraph, patch, { fileExists })
        : undefined;

      records.push({
        patch,
        filePath,
        relFile: path.relative(workspaceRoot, filePath).replace(/\\/g, "/"),
        ...(evaluation ? { evaluation } : {})
      });
    } catch {
      // skip malformed patch file
    }
  }

  return records;
}

export function findPatchRecord(
  workspaceRoot: string,
  patchId: string
): { patch: PatchFile; filePath: string; archived: boolean } | null {
  const cleanId = patchId.endsWith(".patch.json")
    ? patchId.slice(0, -".patch.json".length)
    : patchId;
  if (cleanId.includes("/") || cleanId.includes("\\") || cleanId.includes("..")) {
    return null;
  }

  const pendingPath = path.join(getPatchesDir(workspaceRoot), `${cleanId}.patch.json`);
  if (fs.existsSync(pendingPath)) {
    const raw = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
    const parsed = PatchFileSchema.safeParse(raw);
    if (parsed.success) {
      return { patch: parsed.data, filePath: pendingPath, archived: false };
    }
  }

  const archivedPath = path.join(getPatchesArchiveDir(workspaceRoot), `${cleanId}.patch.json`);
  if (fs.existsSync(archivedPath)) {
    const raw = JSON.parse(fs.readFileSync(archivedPath, "utf8"));
    const parsed = PatchFileSchema.safeParse(raw);
    if (parsed.success) {
      return { patch: parsed.data, filePath: archivedPath, archived: true };
    }
  }

  return null;
}

async function archivePatchUnlocked(
  workspaceRoot: string,
  pendingFilePath: string,
  updatedPatch: PatchFile
): Promise<string> {
  const archiveDir = getPatchesArchiveDir(workspaceRoot);
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }
  const destPath = path.join(archiveDir, path.basename(pendingFilePath));
  await atomicWriteText(destPath, `${JSON.stringify(updatedPatch, null, 2)}\n`);
  try {
    fs.rmSync(pendingFilePath, { force: true });
  } catch {
    // ignore
  }

  // Rolling retention: keep latest MAX_ARCHIVED_PATCHES
  const archivedFiles = fs
    .readdirSync(archiveDir)
    .filter((f) => f.endsWith(".patch.json"))
    .sort();
  while (archivedFiles.length > MAX_ARCHIVED_PATCHES) {
    const oldest = archivedFiles.shift()!;
    try {
      fs.rmSync(path.join(archiveDir, oldest), { force: true });
    } catch {
      // ignore
    }
  }
  return destPath;
}

export interface ApplyPatchResult {
  graph: Graph;
  hash: string;
  inverse: Op[];
  warnings: Diagnostic[];
  patch: PatchFile;
  appliedIndices: number[];
  skippedIndices: number[];
  savedRev: HistoryEntry;
}

export async function applyPatchById(params: {
  workspaceRoot: string;
  patchId: string;
  only?: number[];
  onBeforeWriteHash?: (nextHash: string) => void;
}): Promise<ApplyPatchResult> {
  const { workspaceRoot, patchId, only } = params;
  const fileExists = makeFileExistsChecker(workspaceRoot);

  return await withWorkspaceLock(workspaceRoot, async () => {
    const rec = findPatchRecord(workspaceRoot, patchId);
    if (!rec) {
      throw new NotFoundError(`Patch not found: ${patchId}`);
    }
    if (rec.archived || rec.patch.state !== "pending") {
      throw new ApplyError(`Patch "${patchId}" is already ${rec.patch.state}`, [
        {
          level: "error",
          path: "patch.state",
          code: "PATCH_NOT_PENDING",
          message: `提案 ${patchId} 已处理（状态：${rec.patch.state}），无法重复应用`
        }
      ]);
    }

    const loaded = readValidatedGraph(workspaceRoot, rec.patch.graphId);
    const evaluation = evaluatePatchAgainstGraph(loaded.graph, rec.patch, { fileExists });

    let selectedIndices: number[];
    if (only !== undefined) {
      const invalid = only.filter(
        (idx) => !Number.isInteger(idx) || idx < 0 || idx >= rec.patch.ops.length
      );
      if (invalid.length > 0) {
        throw new ApplyError(`Invalid op indices: ${invalid.join(", ")}`, [
          {
            level: "error",
            path: "only",
            code: "INVALID_OP_INDEX",
            message: `无效的操作序号：${invalid.join(", ")}`
          }
        ]);
      }
      selectedIndices = [...new Set(only)].sort((a, b) => a - b);
    } else {
      selectedIndices = evaluation.defaultSelectedIndices;
    }

    if (selectedIndices.length === 0) {
      throw new ApplyError("No ops selected to apply", [
        {
          level: "error",
          path: "only",
          code: "NO_OPS_SELECTED",
          message: evaluation.hasConflicts
            ? "该提案中的所有操作均与当前图谱存在冲突，未自动选中任何操作"
            : "请至少勾选一条变更操作"
        }
      ]);
    }

    const applied = applySelectedPatchOps(loaded.graph, rec.patch, selectedIndices, {
      fileExists
    });
    const selectedSet = new Set(selectedIndices);
    const skippedIndices = rec.patch.ops
      .map((_, i) => i)
      .filter((i) => !selectedSet.has(i));
    const selectedOps = selectedIndices.map((i) => rec.patch.ops[i]!);

    const savedRev = await saveHistorySnapshotUnlocked(
      workspaceRoot,
      rec.patch.graphId,
      loaded.graph,
      {
        source: "patch",
        title: `应用提案前：${rec.patch.title}`,
        counts: summarizeOps(selectedOps)
      }
    );

    const nextText = serializeGraph(applied.graph);
    const nextHash = hashGraph(applied.graph);
    params.onBeforeWriteHash?.(nextHash);
    await atomicWriteText(loaded.filePath, nextText);

    const nextState: PatchFile["state"] =
      selectedIndices.length === rec.patch.ops.length ? "applied" : "partially_applied";
    const archivedPatch: PatchFile = {
      ...rec.patch,
      state: nextState,
      diagnostics: applied.warnings
    };
    await archivePatchUnlocked(workspaceRoot, rec.filePath, archivedPatch);

    return {
      graph: applied.graph,
      hash: nextHash,
      inverse: applied.inverse,
      warnings: applied.warnings,
      patch: archivedPatch,
      appliedIndices: selectedIndices,
      skippedIndices,
      savedRev
    };
  });
}

export async function rejectPatchById(
  workspaceRoot: string,
  patchId: string
): Promise<PatchFile> {
  return await withWorkspaceLock(workspaceRoot, async () => {
    const rec = findPatchRecord(workspaceRoot, patchId);
    if (!rec) {
      throw new NotFoundError(`Patch not found: ${patchId}`);
    }
    if (rec.archived || rec.patch.state !== "pending") {
      throw new ApplyError(`Patch "${patchId}" is already ${rec.patch.state}`, [
        {
          level: "error",
          path: "patch.state",
          code: "PATCH_NOT_PENDING",
          message: `提案 ${patchId} 已处理（状态：${rec.patch.state}）`
        }
      ]);
    }

    const rejectedPatch: PatchFile = {
      ...rec.patch,
      state: "rejected"
    };
    await archivePatchUnlocked(workspaceRoot, rec.filePath, rejectedPatch);
    return rejectedPatch;
  });
}
