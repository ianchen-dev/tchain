import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import {
  computeFocus,
  deriveGraph,
  diffGraphs,
  hashGraph,
  preparePatchOps,
  serializeGraph,
  summarizeOps,
  validateGraph,
  type Diagnostic,
  type Graph,
  type HistoryEntry,
  type Op,
  type OpSummaryCounts,
  type PatchOp,
  type Status
} from "@tchain/core";
import {
  atomicWriteText,
  listPendingPatches,
  NotFoundError,
  readHistoryIndex,
  saveHistorySnapshotUnlocked,
  withWorkspaceLock
} from "./storage.js";
import {
  GRAPHS_SUBDIR,
  makeFileExistsChecker,
  PATCHES_SUBDIR,
  resolveGraphFiles,
  THOUGHTCHAIN_DIR
} from "./workspace.js";

export interface GraphErrorRecord {
  message: string;
  errors: Diagnostic[];
  at: string;
}

export interface PendingExternalChange {
  id: string;
  graphId: string;
  file: string;
  baseHash: string;
  nextHash: string;
  nextGraph: Graph;
  ops: PatchOp[];
  summary: OpSummaryCounts;
  metadataChanged: boolean;
  warnings: Diagnostic[];
  detectedAt: string;
}

export interface GraphStatusCounts {
  active: number;
  todo: number;
  blocked: number;
  done: number;
  parked: number;
  discarded: number;
  total: number;
  leafTotal: number;
  containerTotal: number;
}

export interface GraphSummaryItem {
  id: string;
  file: string;
  title: string;
  valid: boolean;
  hash?: string;
  counts?: GraphStatusCounts;
  focusActiveIds?: string[];
  focusNextIds?: string[];
  errorCount: number;
  warningCount: number;
  pendingPatchCount?: number;
  hasExternalChange?: boolean;
  lastError?: GraphErrorRecord | null;
}

export interface StoredGraphEntry {
  id: string;
  filePath: string;
  relFile: string;
  lastValidGraph: Graph | null;
  lastValidHash: string | null;
  lastValidWarnings: Diagnostic[];
  lastError: GraphErrorRecord | null;
}

export type ServerEvent =
  | {
      type: "graph:updated";
      payload: {
        graphId: string;
        hash: string;
        warningCount: number;
        at: string;
      };
    }
  | {
      type: "graph:error";
      payload: {
        graphId: string;
        message: string;
        errors: Diagnostic[];
        hasLastValid: boolean;
        at: string;
      };
    }
  | {
      type: "graph:removed";
      payload: {
        graphId: string;
        at: string;
      };
    }
  | {
      type: "patches:updated";
      payload: {
        file?: string;
        graphId?: string;
        at: string;
      };
    }
  | {
      type: "external:changed";
      payload: {
        graphId: string;
        baseHash: string;
        nextHash: string;
        opCount: number;
        metadataChanged: boolean;
        summary: OpSummaryCounts;
        at: string;
      };
    }
  | {
      type: "external:resolved";
      payload: {
        graphId: string;
        resolution: "accepted" | "reverted" | "cleared";
        at: string;
      };
    };

export function summarizeGraphCounts(graph: Graph): GraphStatusCounts {
  const derived = deriveGraph(graph);
  const counts: GraphStatusCounts = {
    active: 0,
    todo: 0,
    blocked: 0,
    done: 0,
    parked: 0,
    discarded: 0,
    total: graph.nodes.length,
    leafTotal: 0,
    containerTotal: 0
  };

  for (const node of graph.nodes) {
    if (derived.isContainer.has(node.id)) {
      counts.containerTotal += 1;
      continue;
    }
    counts.leafTotal += 1;
    const eff: Status = derived.effectiveStatus.get(node.id) ?? "todo";
    counts[eff] += 1;
  }

  return counts;
}

export function graphIdFromFilename(filePath: string): string {
  const base = path.basename(filePath);
  return base.endsWith(".tgraph.json") ? base.slice(0, -".tgraph.json".length) : base;
}

export function listWorkspaceGraphs(workspaceRoot: string): GraphSummaryItem[] {
  const files = resolveGraphFiles(workspaceRoot);
  const fileExists = makeFileExistsChecker(workspaceRoot);
  const items: GraphSummaryItem[] = [];

  for (const filePath of files) {
    const relFile = path.relative(workspaceRoot, filePath).replace(/\\/g, "/");
    const fallbackId = graphIdFromFilename(filePath);

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errDiag: Diagnostic = {
        level: "error",
        path: "$",
        code: "JSON_PARSE_ERROR",
        message: msg,
        hint: "请检查 JSON 语法是否合法"
      };
      items.push({
        id: fallbackId,
        file: relFile,
        title: fallbackId,
        valid: false,
        errorCount: 1,
        warningCount: 0,
        lastError: {
          message: msg,
          errors: [errDiag],
          at: new Date().toISOString()
        }
      });
      continue;
    }

    const validation = validateGraph(parsed, { fileExists });
    if (!validation.ok) {
      const partial = parsed as Partial<Graph>;
      items.push({
        id: typeof partial.id === "string" ? partial.id : fallbackId,
        file: relFile,
        title: typeof partial.title === "string" ? partial.title : fallbackId,
        valid: false,
        errorCount: validation.errors.length,
        warningCount: validation.warnings.length,
        lastError: {
          message: validation.errors[0]?.message ?? "图谱校验失败",
          errors: validation.errors,
          at: new Date().toISOString()
        }
      });
      continue;
    }

    const graph = parsed as Graph;
    const focus = computeFocus(graph);
    items.push({
      id: graph.id,
      file: relFile,
      title: graph.title,
      valid: true,
      hash: hashGraph(graph),
      counts: summarizeGraphCounts(graph),
      focusActiveIds: focus.activeIds,
      focusNextIds: focus.nextIds,
      errorCount: 0,
      warningCount: validation.warnings.length,
      lastError: null
    });
  }

  return items;
}

interface ManualEditSession {
  graphId: string;
  editCount: number;
  opCount: number;
  latestGraph: Graph;
  timer: ReturnType<typeof setTimeout>;
}

export interface WorkspaceStoreOptions {
  /** Idle duration before merging manual edits into a history snapshot (default 2 minutes). */
  manualSnapshotIdleMs?: number;
}

/**
 * In-memory graph cache + chokidar watchers for `tchain serve` (Phase 2).
 * - Preserves `lastValidGraph` on invalid external JSON/schema edits.
 * - Routes valid external file edits into pending review (`external:changed`),
 *   supporting Accept (baseline update without rewriting file) or Revert.
 * - Filters out self-written hashes from unified mutation pipeline.
 * - Watches `.thoughtchain/patches/` and pushes `patches:updated` via SSE.
 */
export class WorkspaceStore {
  readonly workspaceRoot: string;
  readonly graphsDir: string;
  readonly patchesDir: string;
  private readonly entries = new Map<string, StoredGraphEntry>();
  private readonly filePathToId = new Map<string, string>();
  private readonly ownWrittenHashes = new Map<string, Set<string>>();
  private readonly pendingExternalChanges = new Map<string, PendingExternalChange>();
  private readonly manualSessions = new Map<string, ManualEditSession>();
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  private graphWatcher: FSWatcher | null = null;
  private patchWatcher: FSWatcher | null = null;
  private readonly fileExists: (posixPath: string) => boolean;
  private readonly manualSnapshotIdleMs: number;

  constructor(workspaceRoot: string, options?: WorkspaceStoreOptions) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.graphsDir = path.join(this.workspaceRoot, THOUGHTCHAIN_DIR, GRAPHS_SUBDIR);
    this.patchesDir = path.join(this.workspaceRoot, THOUGHTCHAIN_DIR, PATCHES_SUBDIR);
    this.fileExists = makeFileExistsChecker(this.workspaceRoot);
    this.manualSnapshotIdleMs = options?.manualSnapshotIdleMs ?? 120_000;
    this.reloadAll();
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Isolate subscriber failures
      }
    }
  }

  registerOwnWriteHash(graphId: string, hash: string): void {
    let set = this.ownWrittenHashes.get(graphId);
    if (!set) {
      set = new Set<string>();
      this.ownWrittenHashes.set(graphId, set);
    }
    set.add(hash);
  }

  private isAndConsumeOwnWriteHash(graphId: string, hash: string): boolean {
    const set = this.ownWrittenHashes.get(graphId);
    if (!set || !set.has(hash)) return false;
    set.delete(hash);
    return true;
  }

  /**
   * Called immediately after our own unified mutation pipeline writes a new
   * graph version to disk, updating in-memory baseline and pushing SSE.
   */
  applyCommittedGraph(
    graphId: string,
    graph: Graph,
    hash: string,
    warnings: Diagnostic[]
  ): void {
    const existing = this.entries.get(graphId);
    const filePath =
      existing?.filePath ?? path.join(this.graphsDir, `${graphId}.tgraph.json`);
    const relFile = path.relative(this.workspaceRoot, filePath).replace(/\\/g, "/");

    this.entries.set(graphId, {
      id: graphId,
      filePath,
      relFile,
      lastValidGraph: graph,
      lastValidHash: hash,
      lastValidWarnings: warnings,
      lastError: null
    });
    this.filePathToId.set(path.resolve(filePath), graphId);

    const hadExternal = this.pendingExternalChanges.delete(graphId);
    const now = new Date().toISOString();
    if (hadExternal) {
      this.emit({
        type: "external:resolved",
        payload: { graphId, resolution: "cleared", at: now }
      });
    }
    this.emit({
      type: "graph:updated",
      payload: {
        graphId,
        hash,
        warningCount: warnings.length,
        at: now
      }
    });
  }

  /**
   * Tracks manual UI editing sessions; after `manualSnapshotIdleMs` (default 2 min)
   * of inactivity, merges the session into a single history snapshot (PRD §7.6).
   */
  recordManualEdit(
    graphId: string,
    previousGraph: Graph,
    nextGraph: Graph,
    ops: Op[]
  ): void {
    const existingSession = this.manualSessions.get(graphId);
    if (existingSession) {
      clearTimeout(existingSession.timer);
    } else if (readHistoryIndex(this.workspaceRoot, graphId).length === 0) {
      // Ensure pre-edit baseline exists so user can always roll back to before first manual edit
      void withWorkspaceLock(this.workspaceRoot, async () => {
        if (readHistoryIndex(this.workspaceRoot, graphId).length === 0) {
          await saveHistorySnapshotUnlocked(this.workspaceRoot, graphId, previousGraph, {
            source: "manual",
            title: "人工编辑前初始快照",
            counts: summarizeOps([])
          });
        }
      }).catch(() => {
        // ignore background baseline snapshot errors
      });
    }

    const editCount = (existingSession?.editCount ?? 0) + 1;
    const opCount = (existingSession?.opCount ?? 0) + ops.length;

    const timer = setTimeout(() => {
      const sess = this.manualSessions.get(graphId);
      if (!sess) return;
      this.manualSessions.delete(graphId);
      void withWorkspaceLock(this.workspaceRoot, async () => {
        await saveHistorySnapshotUnlocked(this.workspaceRoot, graphId, sess.latestGraph, {
          source: "manual",
          title: `人工编辑会话（${sess.editCount} 次修改 / ${sess.opCount} 项操作）`,
          counts: {
            ...summarizeOps([]),
            totalOps: sess.opCount
          }
        });
      }).catch(() => {
        // ignore if workspace was closed/removed
      });
    }, this.manualSnapshotIdleMs);

    this.manualSessions.set(graphId, {
      graphId,
      editCount,
      opCount,
      latestGraph: nextGraph,
      timer
    });
  }

  reloadAll(): void {
    const files = resolveGraphFiles(this.workspaceRoot);
    for (const filePath of files) {
      this.loadFile(filePath, false);
    }
  }

  loadFile(filePath: string, notify: boolean): void {
    if (!filePath.endsWith(".tgraph.json")) return;
    const resolvedPath = path.resolve(filePath);
    const relFile = path.relative(this.workspaceRoot, resolvedPath).replace(/\\/g, "/");
    const fallbackId =
      this.filePathToId.get(resolvedPath) ?? graphIdFromFilename(resolvedPath);
    const prev = this.entries.get(fallbackId);
    const now = new Date().toISOString();

    let raw: string;
    try {
      raw = fs.readFileSync(resolvedPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.handleFileRemoved(resolvedPath, notify);
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errDiag: Diagnostic = {
        level: "error",
        path: "$",
        code: "JSON_PARSE_ERROR",
        message: msg,
        hint: "请检查 JSON 语法是否合法（例如多余逗号或括号不匹配）"
      };
      const errorRecord: GraphErrorRecord = {
        message: `JSON 解析失败: ${msg}`,
        errors: [errDiag],
        at: now
      };
      this.entries.set(fallbackId, {
        id: fallbackId,
        filePath: resolvedPath,
        relFile,
        lastValidGraph: prev?.lastValidGraph ?? null,
        lastValidHash: prev?.lastValidHash ?? null,
        lastValidWarnings: prev?.lastValidWarnings ?? [],
        lastError: errorRecord
      });
      this.filePathToId.set(resolvedPath, fallbackId);

      if (notify) {
        this.emit({
          type: "graph:error",
          payload: {
            graphId: fallbackId,
            message: errorRecord.message,
            errors: errorRecord.errors,
            hasLastValid: Boolean(prev?.lastValidGraph),
            at: now
          }
        });
      }
      return;
    }

    const validation = validateGraph(parsed, { fileExists: this.fileExists });
    if (!validation.ok) {
      const partial = parsed as Partial<Graph>;
      const id = typeof partial.id === "string" ? partial.id : fallbackId;
      const existing = this.entries.get(id) ?? prev;
      const errorRecord: GraphErrorRecord = {
        message: validation.errors[0]?.message ?? "图谱校验失败",
        errors: validation.errors,
        at: now
      };
      this.entries.set(id, {
        id,
        filePath: resolvedPath,
        relFile,
        lastValidGraph: existing?.lastValidGraph ?? null,
        lastValidHash: existing?.lastValidHash ?? null,
        lastValidWarnings: existing?.lastValidWarnings ?? [],
        lastError: errorRecord
      });
      this.filePathToId.set(resolvedPath, id);

      if (notify) {
        this.emit({
          type: "graph:error",
          payload: {
            graphId: id,
            message: errorRecord.message,
            errors: errorRecord.errors,
            hasLastValid: Boolean(existing?.lastValidGraph),
            at: now
          }
        });
      }
      return;
    }

    const graph = parsed as Graph;
    const hash = hashGraph(graph);
    const id = graph.id;

    if (fallbackId !== id && this.entries.get(fallbackId)?.filePath === resolvedPath) {
      this.entries.delete(fallbackId);
    }

    const existing = this.entries.get(id) ?? prev;

    // 1. Check if this file event was triggered by our own server write pipeline
    if (this.isAndConsumeOwnWriteHash(id, hash)) {
      this.entries.set(id, {
        id,
        filePath: resolvedPath,
        relFile,
        lastValidGraph: graph,
        lastValidHash: hash,
        lastValidWarnings: validation.warnings,
        lastError: null
      });
      this.filePathToId.set(resolvedPath, id);
      return;
    }

    // 2. If baseline already exists and file changed externally -> enter External Change Review (PRD §7.6)
    if (
      notify &&
      existing?.lastValidGraph &&
      existing.lastValidHash &&
      existing.lastValidHash !== hash
    ) {
      const rawOps = diffGraphs(existing.lastValidGraph, graph);
      let enrichedOps: PatchOp[] = [];
      let summary = summarizeOps(rawOps);
      if (rawOps.length > 0) {
        try {
          const prepared = preparePatchOps(existing.lastValidGraph, rawOps, {
            fileExists: this.fileExists
          });
          enrichedOps = prepared.ops;
          summary = prepared.summary;
        } catch {
          enrichedOps = rawOps as PatchOp[];
        }
      }

      const metadataChanged =
        existing.lastValidGraph.title !== graph.title ||
        JSON.stringify(existing.lastValidGraph.layout ?? null) !==
          JSON.stringify(graph.layout ?? null);

      const pending: PendingExternalChange = {
        id: `ext-${Date.now()}`,
        graphId: id,
        file: relFile,
        baseHash: existing.lastValidHash,
        nextHash: hash,
        nextGraph: graph,
        ops: enrichedOps,
        summary,
        metadataChanged,
        warnings: validation.warnings,
        detectedAt: now
      };
      this.pendingExternalChanges.set(id, pending);

      // Clear any previous syntax error since file is now valid, while preserving baseline!
      this.entries.set(id, {
        ...existing,
        id,
        filePath: resolvedPath,
        relFile,
        lastError: null
      });
      this.filePathToId.set(resolvedPath, id);

      this.emit({
        type: "external:changed",
        payload: {
          graphId: id,
          baseHash: existing.lastValidHash,
          nextHash: hash,
          opCount: enrichedOps.length,
          metadataChanged,
          summary,
          at: now
        }
      });
      return;
    }

    // 3. Initial load, newly added graph file, or external edit restored back to baseline
    const hadError = existing?.lastError !== null;
    const hadPendingExternal = this.pendingExternalChanges.delete(id);
    const changed =
      existing?.lastValidHash !== hash ||
      hadError ||
      hadPendingExternal ||
      existing?.lastValidWarnings.length !== validation.warnings.length;

    this.entries.set(id, {
      id,
      filePath: resolvedPath,
      relFile,
      lastValidGraph: graph,
      lastValidHash: hash,
      lastValidWarnings: validation.warnings,
      lastError: null
    });
    this.filePathToId.set(resolvedPath, id);

    if (notify && hadPendingExternal) {
      this.emit({
        type: "external:resolved",
        payload: { graphId: id, resolution: "cleared", at: now }
      });
    }
    if (notify && changed) {
      this.emit({
        type: "graph:updated",
        payload: {
          graphId: id,
          hash,
          warningCount: validation.warnings.length,
          at: now
        }
      });
    }
  }

  getPendingExternalChange(graphId: string): PendingExternalChange | null {
    return this.pendingExternalChanges.get(graphId) ?? null;
  }

  /**
   * Accepts an external direct file modification (PRD §7.6):
   * saves pre-accept history snapshot of baseline and updates baseline in memory
   * WITHOUT rewriting the user's file on disk.
   */
  async acceptExternalChange(graphId: string): Promise<{
    graph: Graph;
    hash: string;
    warnings: Diagnostic[];
    savedRev: HistoryEntry;
  }> {
    return await withWorkspaceLock(this.workspaceRoot, async () => {
      const entry = this.entries.get(graphId);
      const pending = this.pendingExternalChanges.get(graphId);
      if (!entry || !entry.lastValidGraph || !pending) {
        throw new NotFoundError(`No pending external change for graph "${graphId}"`);
      }

      const savedRev = await saveHistorySnapshotUnlocked(
        this.workspaceRoot,
        graphId,
        entry.lastValidGraph,
        {
          source: "external",
          title: "接受外部修改前快照",
          counts: pending.summary
        }
      );

      this.entries.set(graphId, {
        ...entry,
        lastValidGraph: pending.nextGraph,
        lastValidHash: pending.nextHash,
        lastValidWarnings: pending.warnings,
        lastError: null
      });
      this.pendingExternalChanges.delete(graphId);

      const now = new Date().toISOString();
      this.emit({
        type: "external:resolved",
        payload: { graphId, resolution: "accepted", at: now }
      });
      this.emit({
        type: "graph:updated",
        payload: {
          graphId,
          hash: pending.nextHash,
          warningCount: pending.warnings.length,
          at: now
        }
      });

      return {
        graph: pending.nextGraph,
        hash: pending.nextHash,
        warnings: pending.warnings,
        savedRev
      };
    });
  }

  /**
   * Reverts an external direct file modification (PRD §7.6):
   * writes the last valid baseline graph atomically back to disk.
   */
  async revertExternalChange(graphId: string): Promise<{
    graph: Graph;
    hash: string;
    warnings: Diagnostic[];
  }> {
    return await withWorkspaceLock(this.workspaceRoot, async () => {
      const entry = this.entries.get(graphId);
      if (!entry || !entry.lastValidGraph || !entry.lastValidHash) {
        throw new NotFoundError(`No baseline available to revert graph "${graphId}"`);
      }

      const canonicalText = serializeGraph(entry.lastValidGraph);
      const baselineHash = hashGraph(entry.lastValidGraph);
      this.registerOwnWriteHash(graphId, baselineHash);
      await atomicWriteText(entry.filePath, canonicalText);

      this.pendingExternalChanges.delete(graphId);
      this.entries.set(graphId, {
        ...entry,
        lastValidHash: baselineHash,
        lastError: null
      });

      const now = new Date().toISOString();
      this.emit({
        type: "external:resolved",
        payload: { graphId, resolution: "reverted", at: now }
      });
      this.emit({
        type: "graph:updated",
        payload: {
          graphId,
          hash: baselineHash,
          warningCount: entry.lastValidWarnings.length,
          at: now
        }
      });

      return {
        graph: entry.lastValidGraph,
        hash: baselineHash,
        warnings: entry.lastValidWarnings
      };
    });
  }

  private handleFileRemoved(filePath: string, notify: boolean): void {
    const resolvedPath = path.resolve(filePath);
    const id = this.filePathToId.get(resolvedPath) ?? graphIdFromFilename(resolvedPath);
    this.filePathToId.delete(resolvedPath);
    this.pendingExternalChanges.delete(id);
    if (this.entries.delete(id) && notify) {
      this.emit({
        type: "graph:removed",
        payload: {
          graphId: id,
          at: new Date().toISOString()
        }
      });
    }
  }

  startWatching(): void {
    if (!this.graphWatcher) {
      if (!fs.existsSync(this.graphsDir)) {
        fs.mkdirSync(this.graphsDir, { recursive: true });
      }

      this.graphWatcher = chokidar.watch(this.graphsDir, {
        ignoreInitial: true,
        depth: 0,
        awaitWriteFinish: {
          stabilityThreshold: 100,
          pollInterval: 25
        }
      });

      this.graphWatcher.on("add", (filePath) => this.loadFile(filePath, true));
      this.graphWatcher.on("change", (filePath) => this.loadFile(filePath, true));
      this.graphWatcher.on("unlink", (filePath) => this.handleFileRemoved(filePath, true));
    }

    if (!this.patchWatcher) {
      if (!fs.existsSync(this.patchesDir)) {
        fs.mkdirSync(this.patchesDir, { recursive: true });
      }

      this.patchWatcher = chokidar.watch(this.patchesDir, {
        ignoreInitial: true,
        depth: 0,
        awaitWriteFinish: {
          stabilityThreshold: 80,
          pollInterval: 20
        }
      });

      const onPatchEvent = (filePath: string) => {
        if (!filePath.endsWith(".patch.json")) return;
        this.emit({
          type: "patches:updated",
          payload: {
            file: path.basename(filePath),
            at: new Date().toISOString()
          }
        });
      };

      this.patchWatcher.on("add", onPatchEvent);
      this.patchWatcher.on("change", onPatchEvent);
      this.patchWatcher.on("unlink", onPatchEvent);
    }
  }

  async close(): Promise<void> {
    for (const sess of this.manualSessions.values()) {
      clearTimeout(sess.timer);
    }
    this.manualSessions.clear();

    if (this.graphWatcher) {
      await this.graphWatcher.close();
      this.graphWatcher = null;
    }
    if (this.patchWatcher) {
      await this.patchWatcher.close();
      this.patchWatcher = null;
    }
    this.listeners.clear();
  }

  getEntry(graphId: string): StoredGraphEntry | undefined {
    return this.entries.get(graphId);
  }

  listSummaries(): GraphSummaryItem[] {
    const pendingPatches = listPendingPatches(this.workspaceRoot);
    const pendingByGraph = new Map<string, number>();
    for (const p of pendingPatches) {
      pendingByGraph.set(
        p.patch.graphId,
        (pendingByGraph.get(p.patch.graphId) ?? 0) + 1
      );
    }

    const list: GraphSummaryItem[] = [];
    for (const entry of this.entries.values()) {
      const g = entry.lastValidGraph;
      const focus = g ? computeFocus(g) : null;
      list.push({
        id: entry.id,
        file: entry.relFile,
        title: g?.title ?? entry.id,
        valid: entry.lastError === null && g !== null,
        ...(entry.lastValidHash ? { hash: entry.lastValidHash } : {}),
        ...(g ? { counts: summarizeGraphCounts(g) } : {}),
        ...(focus
          ? { focusActiveIds: focus.activeIds, focusNextIds: focus.nextIds }
          : {}),
        errorCount: entry.lastError ? entry.lastError.errors.length : 0,
        warningCount: entry.lastValidWarnings.length,
        pendingPatchCount: pendingByGraph.get(entry.id) ?? 0,
        hasExternalChange: this.pendingExternalChanges.has(entry.id),
        lastError: entry.lastError
      });
    }
    return list.sort((a, b) => a.id.localeCompare(b.id));
  }
}
