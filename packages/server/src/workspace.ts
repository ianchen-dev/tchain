import fs from "node:fs";
import path from "node:path";
import { exportGraphJsonSchema, normalizeAttachmentPath } from "@tchain/core";

export const THOUGHTCHAIN_DIR = ".thoughtchain";
export const GRAPHS_SUBDIR = "graphs";
export const PATCHES_SUBDIR = "patches";
export const PATCHES_ARCHIVE_SUBDIR = "archive";
export const HISTORY_SUBDIR = "history";
export const SCHEMA_FILENAME = "tgraph.schema.json";

const GITIGNORE_ENTRIES = [
  "patches/archive/",
  "history/",
  "ui-state.json",
  ".lock"
];

export function resolveWorkspaceRoot(explicitDir?: string): string {
  if (explicitDir) {
    return path.resolve(explicitDir);
  }
  let cur = path.resolve(process.cwd());
  while (true) {
    if (fs.existsSync(path.join(cur, THOUGHTCHAIN_DIR))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      return path.resolve(process.cwd());
    }
    cur = parent;
  }
}

export function isPathInsideRoot(rootDir: string, targetPath: string): boolean {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel === "") return false;
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return true;
}

export function makeFileExistsChecker(
  workspaceRoot: string
): (posixPath: string) => boolean {
  const resolvedRoot = path.resolve(workspaceRoot);
  return (posixPath: string): boolean => {
    const normalized = normalizeAttachmentPath(posixPath);
    const fullPath = path.resolve(resolvedRoot, ...normalized.split("/"));
    if (!isPathInsideRoot(resolvedRoot, fullPath)) {
      return false;
    }
    return fs.existsSync(fullPath);
  };
}

export function resolveGraphFiles(
  workspaceRoot: string,
  graphArg?: string
): string[] {
  const graphsDir = path.join(workspaceRoot, THOUGHTCHAIN_DIR, GRAPHS_SUBDIR);

  if (!graphArg) {
    if (!fs.existsSync(graphsDir)) return [];
    return fs
      .readdirSync(graphsDir)
      .filter((name) => name.endsWith(".tgraph.json"))
      .sort()
      .map((name) => path.join(graphsDir, name));
  }

  // 1. Direct file path (relative to cwd or absolute)
  const asDirect = path.resolve(graphArg);
  if (fs.existsSync(asDirect) && fs.statSync(asDirect).isFile()) {
    return [asDirect];
  }

  // 2. Relative to workspaceRoot
  const asWorkspaceRel = path.resolve(workspaceRoot, graphArg);
  if (fs.existsSync(asWorkspaceRel) && fs.statSync(asWorkspaceRel).isFile()) {
    return [asWorkspaceRel];
  }

  // 3. Graph id inside .thoughtchain/graphs/
  const fileName = graphArg.endsWith(".tgraph.json")
    ? graphArg
    : `${graphArg}.tgraph.json`;
  const inGraphsDir = path.join(graphsDir, fileName);
  if (fs.existsSync(inGraphsDir) && fs.statSync(inGraphsDir).isFile()) {
    return [inGraphsDir];
  }

  return [];
}

export interface InitWorkspaceResult {
  workspace: string;
  thoughtchainDir: string;
  schemaFile: string;
  gitignoreFile: string;
  createdDirs: string[];
}

export function initWorkspace(targetDir: string): InitWorkspaceResult {
  const workspace = path.resolve(targetDir);
  const tcDir = path.join(workspace, THOUGHTCHAIN_DIR);
  const dirsToEnsure = [
    tcDir,
    path.join(tcDir, GRAPHS_SUBDIR),
    path.join(tcDir, PATCHES_SUBDIR),
    path.join(tcDir, PATCHES_SUBDIR, PATCHES_ARCHIVE_SUBDIR),
    path.join(tcDir, HISTORY_SUBDIR)
  ];

  const createdDirs: string[] = [];
  for (const dir of dirsToEnsure) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      createdDirs.push(path.relative(workspace, dir).replace(/\\/g, "/"));
    }
  }

  const schemaFile = path.join(tcDir, SCHEMA_FILENAME);
  const schemaContent = `${JSON.stringify(exportGraphJsonSchema(), null, 2)}\n`;
  fs.writeFileSync(schemaFile, schemaContent, "utf8");

  const gitignoreFile = path.join(tcDir, ".gitignore");
  const existingLines = fs.existsSync(gitignoreFile)
    ? fs
        .readFileSync(gitignoreFile, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
    : [];
  const merged = [...existingLines];
  for (const entry of GITIGNORE_ENTRIES) {
    if (!merged.includes(entry)) {
      merged.push(entry);
    }
  }
  fs.writeFileSync(gitignoreFile, `${merged.join("\n")}\n`, "utf8");

  return {
    workspace,
    thoughtchainDir: tcDir,
    schemaFile,
    gitignoreFile,
    createdDirs
  };
}
