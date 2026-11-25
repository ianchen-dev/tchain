import fs from "node:fs";
import path from "node:path";
import { normalizeAttachmentPath } from "@tchain/core";

export const ALLOWED_FILE_EXTENSIONS = new Set<string>([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".pdf"
]);

const MIME_TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".pdf": "application/pdf"
};

export interface SafeFileOk {
  ok: true;
  absPath: string;
  relPosixPath: string;
  ext: string;
  contentType: string;
  size: number;
}

export interface SafeFileErr {
  ok: false;
  status: 400 | 403 | 404;
  code: string;
  message: string;
}

export type SafeFileResult = SafeFileOk | SafeFileErr;

function isDeniedRelativePath(relPosix: string): boolean {
  const segments = relPosix.split("/").filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const segLower = segments[i]!.toLowerCase();
    if (segLower === ".git") return true;
    if (segLower === ".env" || segLower.startsWith(".env.")) return true;
    if (
      segLower === ".thoughtchain" &&
      segments[i + 1]?.toLowerCase() === ".lock"
    ) {
      return true;
    }
  }
  return false;
}

function isRealPathInside(realRoot: string, realTarget: string): boolean {
  const rel = path.relative(realRoot, realTarget);
  if (rel === "") return false;
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return true;
}

/**
 * Resolves a workspace-relative file path enforcing PRD §8.5 security boundaries:
 * 1. Rejects empty, null-byte, absolute, or `..` traversal paths.
 * 2. Resolves `realpathSync` on both workspace root and target to prevent symlink escape.
 * 3. Denies `.env*`, `.git/`, and `.thoughtchain/.lock`.
 * 4. Enforces strict extension allowlist.
 */
export function resolveSafeWorkspaceFile(
  workspaceRoot: string,
  rawPath: string
): SafeFileResult {
  if (!rawPath || rawPath.includes("\0")) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_PATH",
      message: "Missing or invalid file path"
    };
  }

  const normalized = normalizeAttachmentPath(rawPath).trim();
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((seg) => seg === "..")
  ) {
    return {
      ok: false,
      status: 403,
      code: "PATH_OUTSIDE_WORKSPACE",
      message: "Path must be a relative path inside the workspace"
    };
  }

  if (isDeniedRelativePath(normalized)) {
    return {
      ok: false,
      status: 403,
      code: "PATH_DENIED",
      message: "Access to sensitive files (.env, .git, .lock) is forbidden"
    };
  }

  const ext = path.extname(normalized).toLowerCase();
  if (!ALLOWED_FILE_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      status: 403,
      code: "EXTENSION_NOT_ALLOWED",
      message: `File extension "${ext || "(none)"}" is not in the allowed list`
    };
  }

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(workspaceRoot);
  } catch {
    return {
      ok: false,
      status: 404,
      code: "WORKSPACE_NOT_FOUND",
      message: "Workspace root does not exist"
    };
  }

  const candidate = path.resolve(realRoot, ...normalized.split("/"));
  if (!isRealPathInside(realRoot, candidate)) {
    return {
      ok: false,
      status: 403,
      code: "PATH_OUTSIDE_WORKSPACE",
      message: "Resolved path escapes workspace root"
    };
  }

  if (!fs.existsSync(candidate)) {
    return {
      ok: false,
      status: 404,
      code: "FILE_NOT_FOUND",
      message: `File not found: ${normalized}`
    };
  }

  let realTarget: string;
  let stat: fs.Stats;
  try {
    realTarget = fs.realpathSync(candidate);
    stat = fs.statSync(realTarget);
  } catch {
    return {
      ok: false,
      status: 404,
      code: "FILE_NOT_FOUND",
      message: `Unable to stat file: ${normalized}`
    };
  }

  if (!isRealPathInside(realRoot, realTarget)) {
    return {
      ok: false,
      status: 403,
      code: "SYMLINK_OUTSIDE_WORKSPACE",
      message: "Symlink target escapes workspace root"
    };
  }

  // Re-check denied path segments on the realpath relative path
  const realRelPosix = path.relative(realRoot, realTarget).replace(/\\/g, "/");
  if (isDeniedRelativePath(realRelPosix)) {
    return {
      ok: false,
      status: 403,
      code: "PATH_DENIED",
      message: "Real path points to a restricted file"
    };
  }

  if (!stat.isFile()) {
    return {
      ok: false,
      status: 400,
      code: "NOT_A_FILE",
      message: "Target path is not a regular file"
    };
  }

  return {
    ok: true,
    absPath: realTarget,
    relPosixPath: realRelPosix,
    ext,
    contentType: MIME_TYPES[ext] ?? "application/octet-stream",
    size: stat.size
  };
}
