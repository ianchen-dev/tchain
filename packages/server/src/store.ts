import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import {
  computeFocus,
  deriveGraph,
  hashGraph,
  validateGraph,
  type Diagnostic,
  type Graph,
  type Status
} from "@tchain/core";
import {
  GRAPHS_SUBDIR,
  makeFileExistsChecker,
  resolveGraphFiles,
  THOUGHTCHAIN_DIR
} from "./workspace.js";

export interface GraphErrorRecord {
  message: string;
  errors: Diagnostic[];
  at: string;
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

/**
 * In-memory graph cache + chokidar watcher for `tchain serve` (Phase 1 read-only).
 * Preserves the last valid graph when an external edit writes invalid JSON/schema,
 * and broadcasts SSE notifications within ~150ms.
 */
export class WorkspaceStore {
  readonly workspaceRoot: string;
  readonly graphsDir: string;
  private readonly entries = new Map<string, StoredGraphEntry>();
  private readonly filePathToId = new Map<string, string>();
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  private watcher: FSWatcher | null = null;
  private readonly fileExists: (posixPath: string) => boolean;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.graphsDir = path.join(this.workspaceRoot, THOUGHTCHAIN_DIR, GRAPHS_SUBDIR);
    this.fileExists = makeFileExistsChecker(this.workspaceRoot);
    this.reloadAll();
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Isolate subscriber failures
      }
    }
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
    const fallbackId = this.filePathToId.get(resolvedPath) ?? graphIdFromFilename(resolvedPath);
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

    // Clean up old id mapping if file's internal graph.id changed
    if (fallbackId !== id && this.entries.get(fallbackId)?.filePath === resolvedPath) {
      this.entries.delete(fallbackId);
    }

    const changed =
      prev?.lastValidHash !== hash ||
      prev?.lastError !== null ||
      prev?.lastValidWarnings.length !== validation.warnings.length;

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

  private handleFileRemoved(filePath: string, notify: boolean): void {
    const resolvedPath = path.resolve(filePath);
    const id = this.filePathToId.get(resolvedPath) ?? graphIdFromFilename(resolvedPath);
    this.filePathToId.delete(resolvedPath);
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
    if (this.watcher) return;
    if (!fs.existsSync(this.graphsDir)) {
      fs.mkdirSync(this.graphsDir, { recursive: true });
    }

    this.watcher = chokidar.watch(this.graphsDir, {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 25
      }
    });

    this.watcher.on("add", (filePath) => this.loadFile(filePath, true));
    this.watcher.on("change", (filePath) => this.loadFile(filePath, true));
    this.watcher.on("unlink", (filePath) => this.handleFileRemoved(filePath, true));
  }

  async close(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.listeners.clear();
  }

  getEntry(graphId: string): StoredGraphEntry | undefined {
    return this.entries.get(graphId);
  }

  listSummaries(): GraphSummaryItem[] {
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
        lastError: entry.lastError
      });
    }
    return list.sort((a, b) => a.id.localeCompare(b.id));
  }
}
