import type {
  CompiledActivityData,
  CompiledWorkspaceActivityData,
  Diagnostic,
  Graph,
  HistoryEntry,
  HistorySource,
  Op,
  OpSummaryCounts,
  PatchEvaluation,
  PatchFile,
  PatchOp
} from "@tchain/core";

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

export interface PendingPatchItem {
  patch: PatchFile;
  file: string;
  evaluation: PatchEvaluation | null;
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

export interface GraphListResponse {
  ok: boolean;
  workspaceRoot: string;
  graphs: GraphSummaryItem[];
}

export interface GraphDetailResponse {
  ok: boolean;
  graphId: string;
  file: string;
  workspaceRoot: string;
  graph: Graph | null;
  hash: string | null;
  warnings: Diagnostic[];
  lastError: GraphErrorRecord | null;
  pendingExternalChange: PendingExternalChange | null;
}

export interface PostOpsResponse {
  ok: true;
  graphId: string;
  graph: Graph;
  hash: string;
  inverse: Op[];
  warnings: Diagnostic[];
  savedRev: HistoryEntry | null;
}

export interface ApplyPatchResponse {
  ok: true;
  graph: Graph;
  hash: string;
  inverse: Op[];
  warnings: Diagnostic[];
  patch: PatchFile;
  appliedIndices: number[];
  skippedIndices: number[];
  savedRev: HistoryEntry;
}

export interface HistoryListResponse {
  ok: true;
  graphId: string;
  count: number;
  entries: HistoryEntry[];
}

export interface HistoryDiffResponse {
  ok: true;
  graphId: string;
  rev: number;
  rollbackOps: Op[];
  forwardOps: Op[];
  rollbackSummary: OpSummaryCounts;
  forwardSummary: OpSummaryCounts;
  snapshotNodeCount: number;
  currentNodeCount: number;
}

export interface RollbackResponse {
  ok: true;
  graphId: string;
  graph: Graph;
  hash: string;
  rolledBackToRev: number;
  savedRev: HistoryEntry;
  warnings: Diagnostic[];
}

export interface ActivityApiResponse {
  ok: true;
  format: "md" | "json";
  text: string;
  estimatedTokens: number;
  data: CompiledActivityData;
}

export interface WorkspaceActivityApiResponse {
  ok: true;
  format: "md" | "json";
  text: string;
  estimatedTokens: number;
  data: CompiledWorkspaceActivityData;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly diagnostics?: Diagnostic[];
  readonly currentHash?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    extra?: { diagnostics?: Diagnostic[]; currentHash?: string }
  ) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.diagnostics = extra?.diagnostics;
    this.currentHash = extra?.currentHash;
  }
}

async function parseJsonOrThrow<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new ApiRequestError(
      res.status,
      typeof data?.code === "string" ? data.code : `HTTP_${res.status}`,
      typeof data?.message === "string" ? data.message : `HTTP ${res.status}`,
      {
        diagnostics: Array.isArray(data?.diagnostics)
          ? (data.diagnostics as Diagnostic[])
          : undefined,
        currentHash: typeof data?.currentHash === "string" ? data.currentHash : undefined
      }
    );
  }
  return data as T;
}

export async function fetchGraphs(): Promise<GraphListResponse> {
  const res = await fetch("/api/graphs", { credentials: "same-origin" });
  return await parseJsonOrThrow<GraphListResponse>(res);
}

export async function fetchGraphDetail(graphId: string): Promise<GraphDetailResponse> {
  const res = await fetch(`/api/graphs/${encodeURIComponent(graphId)}`, {
    credentials: "same-origin"
  });
  return await parseJsonOrThrow<GraphDetailResponse>(res);
}

export async function postGraphOps(
  graphId: string,
  body: {
    baseHash: string;
    ops: Op[];
    source?: HistorySource;
    title?: string;
    snapshotBefore?: boolean;
    preserveTimestamps?: boolean;
  }
): Promise<PostOpsResponse> {
  const res = await fetch(`/api/graphs/${encodeURIComponent(graphId)}/ops`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return await parseJsonOrThrow<PostOpsResponse>(res);
}

export async function fetchPendingPatches(
  graphId: string
): Promise<{ ok: true; graphId: string; count: number; patches: PendingPatchItem[] }> {
  const res = await fetch(`/api/graphs/${encodeURIComponent(graphId)}/patches`, {
    credentials: "same-origin"
  });
  return await parseJsonOrThrow(res);
}

export async function applyPatchApi(
  graphId: string,
  patchId: string,
  only?: number[]
): Promise<ApplyPatchResponse> {
  const res = await fetch(
    `/api/graphs/${encodeURIComponent(graphId)}/patches/${encodeURIComponent(patchId)}/apply`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(only !== undefined ? { only } : {})
    }
  );
  return await parseJsonOrThrow<ApplyPatchResponse>(res);
}

export async function rejectPatchApi(
  graphId: string,
  patchId: string
): Promise<{ ok: true; patch: PatchFile }> {
  const res = await fetch(
    `/api/graphs/${encodeURIComponent(graphId)}/patches/${encodeURIComponent(patchId)}/reject`,
    {
      method: "POST",
      credentials: "same-origin"
    }
  );
  return await parseJsonOrThrow(res);
}

export async function acceptExternalChangeApi(graphId: string): Promise<{
  ok: true;
  graphId: string;
  graph: Graph;
  hash: string;
  warnings: Diagnostic[];
  savedRev: HistoryEntry;
}> {
  const res = await fetch(`/api/graphs/${encodeURIComponent(graphId)}/external/accept`, {
    method: "POST",
    credentials: "same-origin"
  });
  return await parseJsonOrThrow(res);
}

export async function revertExternalChangeApi(graphId: string): Promise<{
  ok: true;
  graphId: string;
  graph: Graph;
  hash: string;
  warnings: Diagnostic[];
}> {
  const res = await fetch(`/api/graphs/${encodeURIComponent(graphId)}/external/revert`, {
    method: "POST",
    credentials: "same-origin"
  });
  return await parseJsonOrThrow(res);
}

export async function fetchHistory(graphId: string): Promise<HistoryListResponse> {
  const res = await fetch(`/api/graphs/${encodeURIComponent(graphId)}/history`, {
    credentials: "same-origin"
  });
  return await parseJsonOrThrow<HistoryListResponse>(res);
}

export async function fetchHistoryDiff(
  graphId: string,
  rev: number
): Promise<HistoryDiffResponse> {
  const res = await fetch(
    `/api/graphs/${encodeURIComponent(graphId)}/history/${rev}/diff`,
    { credentials: "same-origin" }
  );
  return await parseJsonOrThrow<HistoryDiffResponse>(res);
}

export async function createCheckpointApi(
  graphId: string,
  title?: string
): Promise<{ ok: true; graphId: string; entry: HistoryEntry }> {
  const res = await fetch(`/api/graphs/${encodeURIComponent(graphId)}/history/checkpoint`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(title ? { title } : {})
  });
  return await parseJsonOrThrow(res);
}

export async function rollbackGraphApi(
  graphId: string,
  rev: number
): Promise<RollbackResponse> {
  const res = await fetch(`/api/graphs/${encodeURIComponent(graphId)}/rollback`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rev })
  });
  return await parseJsonOrThrow<RollbackResponse>(res);
}

export async function fetchWorkspaceTextFile(posixPath: string): Promise<string> {
  const res = await fetch(`/api/files?path=${encodeURIComponent(posixPath)}`, {
    credentials: "same-origin"
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const errJson = (await res.json()) as { message?: string };
      if (errJson.message) msg = errJson.message;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return await res.text();
}

export function buildWorkspaceFileUrl(posixPath: string): string {
  return `/api/files?path=${encodeURIComponent(posixPath)}`;
}

export interface ActivityQueryParams {
  since?: string;
  until?: string;
  format?: "md" | "json";
  maxTokens?: number;
  includeNext?: boolean;
}

function buildActivityQueryString(params?: ActivityQueryParams): string {
  if (!params) return "";
  const sp = new URLSearchParams();
  if (params.since) sp.set("since", params.since);
  if (params.until) sp.set("until", params.until);
  if (params.format) sp.set("format", params.format);
  if (params.maxTokens !== undefined) sp.set("maxTokens", String(params.maxTokens));
  if (params.includeNext !== undefined) sp.set("includeNext", String(params.includeNext));
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

export async function fetchGraphActivity(
  graphId: string,
  params?: ActivityQueryParams
): Promise<ActivityApiResponse> {
  const res = await fetch(
    `/api/graphs/${encodeURIComponent(graphId)}/activity${buildActivityQueryString(params)}`,
    { credentials: "same-origin" }
  );
  return await parseJsonOrThrow<ActivityApiResponse>(res);
}

export async function fetchWorkspaceActivity(
  params?: ActivityQueryParams
): Promise<WorkspaceActivityApiResponse> {
  const res = await fetch(`/api/activity${buildActivityQueryString(params)}`, {
    credentials: "same-origin"
  });
  return await parseJsonOrThrow<WorkspaceActivityApiResponse>(res);
}
