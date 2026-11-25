import type { Diagnostic, Graph } from "@tchain/core";

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
}

export async function fetchGraphs(): Promise<GraphListResponse> {
  const res = await fetch("/api/graphs", { credentials: "same-origin" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: failed to load graphs`);
  }
  return (await res.json()) as GraphListResponse;
}

export async function fetchGraphDetail(graphId: string): Promise<GraphDetailResponse> {
  const res = await fetch(`/api/graphs/${encodeURIComponent(graphId)}`, {
    credentials: "same-origin"
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: failed to load graph "${graphId}"`);
  }
  return (await res.json()) as GraphDetailResponse;
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
