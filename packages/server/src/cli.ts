#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  ActivityTimeRangeError,
  ApplyError,
  compileActivity,
  compileContext,
  compileWorkspaceActivity,
  computeFocus,
  evaluatePatchAgainstGraph,
  hashGraph,
  parseActivityWindow,
  serializeGraph,
  validateGraph,
  type Diagnostic,
  type Graph,
  type Op
} from "@tchain/core";
import {
  initWorkspace,
  makeFileExistsChecker,
  resolveGraphFiles,
  resolveWorkspaceRoot
} from "./workspace.js";
import { listWorkspaceGraphs } from "./store.js";
import { ensureWorkspaceService } from "./service.js";
import { runMcpStdioServer } from "./mcp.js";
import {
  applyPatchById,
  findPatchRecord,
  listPendingPatches,
  loadWorkspaceValidGraphs,
  NotFoundError,
  proposePatch,
  readHistoryIndex,
  readValidatedGraph,
  rejectPatchById,
  rollbackGraph
} from "./storage.js";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readJsonFile(
  filePath: string
): { ok: true; data: unknown } | { ok: false; error: string } {
  try {
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("tchain")
    .description("ThoughtChain Decision Workbench CLI, local server & MCP")
    .version("0.1.0")
    .option("-C, --dir <dir>", "Specify workspace root directory");

  program
    .command("init [dir]")
    .description("Initialize .thoughtchain/ workspace, JSON Schema, and .gitignore")
    .action((dir?: string) => {
      const globalOpts = program.opts<{ dir?: string }>();
      const target = dir ?? globalOpts.dir ?? process.cwd();
      const result = initWorkspace(target);
      printJson({
        ok: true,
        ...result
      });
    });

  program
    .command("validate [graph]")
    .description("Validate one or all .tgraph.json files with structured diagnostics")
    .option("--no-fs-check", "Skip checking whether local attachment files exist on disk")
    .action((graphArg: string | undefined, opts: { fsCheck: boolean }) => {
      const globalOpts = program.opts<{ dir?: string }>();
      const workspace = resolveWorkspaceRoot(globalOpts.dir);
      const files = resolveGraphFiles(workspace, graphArg);

      if (files.length === 0) {
        printJson({
          ok: false,
          workspace,
          error: graphArg
            ? `Graph not found: ${graphArg}`
            : "No .tgraph.json files found under .thoughtchain/graphs/"
        });
        process.exitCode = 1;
        return;
      }

      const fileExists = opts.fsCheck ? makeFileExistsChecker(workspace) : undefined;
      let allOk = true;

      const results = files.map((filePath) => {
        const relFile = path.relative(workspace, filePath).replace(/\\/g, "/");
        const parsed = readJsonFile(filePath);
        if (!parsed.ok) {
          allOk = false;
          const errDiag: Diagnostic = {
            level: "error",
            path: "$",
            code: "JSON_PARSE_ERROR",
            message: parsed.error,
            hint: "请检查 JSON 语法是否合法"
          };
          return {
            file: relFile,
            ok: false,
            errorCount: 1,
            warningCount: 0,
            errors: [errDiag],
            warnings: [] as Diagnostic[]
          };
        }

        const validation = validateGraph(parsed.data, { fileExists });
        if (!validation.ok) allOk = false;

        const graphObj = parsed.data as Partial<Graph>;
        return {
          file: relFile,
          graphId: typeof graphObj.id === "string" ? graphObj.id : undefined,
          ok: validation.ok,
          hash: validation.ok ? hashGraph(parsed.data as Graph) : undefined,
          errorCount: validation.errors.length,
          warningCount: validation.warnings.length,
          errors: validation.errors,
          warnings: validation.warnings
        };
      });

      printJson({
        ok: allOk,
        workspace,
        results
      });

      if (!allOk) {
        process.exitCode = 1;
      }
    });

  program
    .command("fmt [graph]")
    .description("Format graph file(s) using canonical serialization rules")
    .option("--check", "Check whether files are formatted without writing changes")
    .action((graphArg: string | undefined, opts: { check?: boolean }) => {
      const globalOpts = program.opts<{ dir?: string }>();
      const workspace = resolveWorkspaceRoot(globalOpts.dir);
      const files = resolveGraphFiles(workspace, graphArg);

      if (files.length === 0) {
        printJson({
          ok: false,
          workspace,
          error: graphArg
            ? `Graph not found: ${graphArg}`
            : "No .tgraph.json files found under .thoughtchain/graphs/"
        });
        process.exitCode = 1;
        return;
      }

      const formatted: string[] = [];
      const unchanged: string[] = [];
      const failed: Array<{ file: string; errors: Diagnostic[] }> = [];

      for (const filePath of files) {
        const relFile = path.relative(workspace, filePath).replace(/\\/g, "/");
        const raw = fs.readFileSync(filePath, "utf8");
        let parsedData: unknown;
        try {
          parsedData = JSON.parse(raw);
        } catch (err) {
          failed.push({
            file: relFile,
            errors: [
              {
                level: "error",
                path: "$",
                code: "JSON_PARSE_ERROR",
                message: err instanceof Error ? err.message : String(err)
              }
            ]
          });
          continue;
        }

        const validation = validateGraph(parsedData);
        if (!validation.ok) {
          failed.push({ file: relFile, errors: validation.errors });
          continue;
        }

        const canonicalText = serializeGraph(parsedData as Graph);
        if (raw === canonicalText) {
          unchanged.push(relFile);
        } else {
          if (!opts.check) {
            fs.writeFileSync(filePath, canonicalText, "utf8");
          }
          formatted.push(relFile);
        }
      }

      const ok = failed.length === 0 && !(opts.check && formatted.length > 0);
      printJson({
        ok,
        checkOnly: Boolean(opts.check),
        workspace,
        formatted,
        unchanged,
        ...(failed.length > 0 ? { failed } : {})
      });

      if (!ok) {
        process.exitCode = 1;
      }
    });

  program
    .command("context <graph>")
    .description("Compile a token-efficient AI context brief for a target node")
    .option("-n, --node <id>", "Target node id (defaults to first active focus node)")
    .option("-f, --format <format>", "Output format: md or json", "md")
    .option("--max-tokens <n>", "Maximum estimated tokens (truncates ⑥ → ④ → ②)")
    .action(
      (
        graphArg: string,
        opts: { node?: string; format?: string; maxTokens?: string }
      ) => {
        const globalOpts = program.opts<{ dir?: string }>();
        const workspace = resolveWorkspaceRoot(globalOpts.dir);
        const files = resolveGraphFiles(workspace, graphArg);

        if (files.length === 0) {
          printJson({
            ok: false,
            error: `Graph not found: ${graphArg}`
          });
          process.exitCode = 1;
          return;
        }

        const filePath = files[0]!;
        const parsed = readJsonFile(filePath);
        if (!parsed.ok) {
          printJson({ ok: false, error: parsed.error });
          process.exitCode = 1;
          return;
        }

        const validation = validateGraph(parsed.data);
        if (!validation.ok) {
          printJson({
            ok: false,
            error: "Graph failed validation; fix errors before compiling context",
            errors: validation.errors
          });
          process.exitCode = 1;
          return;
        }

        const graph = parsed.data as Graph;
        let targetNodeId = opts.node;
        if (!targetNodeId) {
          const focus = computeFocus(graph);
          targetNodeId = focus.activeIds[0] ?? focus.nextIds[0];
          if (!targetNodeId) {
            printJson({
              ok: false,
              error: "No active or ready node found; please pass --node <id>"
            });
            process.exitCode = 1;
            return;
          }
        }

        const format = opts.format === "json" ? "json" : "md";
        const maxTokens =
          opts.maxTokens !== undefined ? Number.parseInt(opts.maxTokens, 10) : undefined;
        if (
          opts.maxTokens !== undefined &&
          (!Number.isFinite(maxTokens) || (maxTokens ?? 0) <= 0)
        ) {
          printJson({
            ok: false,
            error: `Invalid --max-tokens value: ${opts.maxTokens}`
          });
          process.exitCode = 1;
          return;
        }

        try {
          const result = compileContext(graph, targetNodeId, {
            format,
            maxTokens
          });
          process.stdout.write(result.text);
        } catch (err) {
          printJson({
            ok: false,
            error: err instanceof Error ? err.message : String(err)
          });
          process.exitCode = 1;
        }
      }
    );

  program
    .command("activity [graph]")
    .description("Compile time-windowed activity / weekly report materials (Markdown or JSON)")
    .option("--since <expr>", "Start time expression (24h/7d/4w, this-week, last-week, YYYY-MM-DD, ISO-8601)", "7d")
    .option("--until <expr>", "End time expression (YYYY-MM-DD or ISO-8601)")
    .option("-f, --format <format>", "Output format: md or json", "md")
    .option("--max-tokens <n>", "Maximum estimated tokens (truncates ⑥ → ④ → ⑤(进行中) → ②)")
    .option("--no-next", "Omit section ⑥ next ready frontier")
    .action(
      (
        graphArg: string | undefined,
        opts: {
          since?: string;
          until?: string;
          format?: string;
          maxTokens?: string;
          next: boolean;
        }
      ) => {
        const globalOpts = program.opts<{ dir?: string }>();
        const workspace = resolveWorkspaceRoot(globalOpts.dir);

        if (opts.format !== undefined && opts.format !== "md" && opts.format !== "json") {
          printJson({
            ok: false,
            code: "INVALID_FORMAT",
            error: `Invalid --format value: ${opts.format}`
          });
          process.exitCode = 1;
          return;
        }
        const format = opts.format === "json" ? "json" : "md";

        let maxTokens: number | undefined;
        if (opts.maxTokens !== undefined) {
          const parsedMax = Number.parseInt(opts.maxTokens, 10);
          if (!Number.isFinite(parsedMax) || parsedMax <= 0 || String(parsedMax) !== opts.maxTokens.trim()) {
            printJson({
              ok: false,
              code: "INVALID_MAX_TOKENS",
              error: `Invalid --max-tokens value: ${opts.maxTokens}`
            });
            process.exitCode = 1;
            return;
          }
          maxTokens = parsedMax;
        }

        try {
          parseActivityWindow({ since: opts.since, until: opts.until });
        } catch (err) {
          if (err instanceof ActivityTimeRangeError) {
            printJson({
              ok: false,
              code: err.code,
              error: err.message,
              hint: err.hint
            });
          } else {
            printJson({
              ok: false,
              code: "INVALID_TIME_RANGE",
              error: err instanceof Error ? err.message : String(err)
            });
          }
          process.exitCode = 1;
          return;
        }

        const compileOpts = {
          since: opts.since,
          until: opts.until,
          format,
          maxTokens,
          includeNext: opts.next
        } as const;

        if (!graphArg) {
          try {
            const { graphs, skipped } = loadWorkspaceValidGraphs(workspace);
            const result = compileWorkspaceActivity(graphs, {
              ...compileOpts,
              skippedGraphs: skipped
            });
            process.stdout.write(result.text);
          } catch (err) {
            printJson({
              ok: false,
              code: err instanceof ActivityTimeRangeError ? err.code : "ACTIVITY_ERROR",
              error: err instanceof Error ? err.message : String(err),
              ...(err instanceof ActivityTimeRangeError ? { hint: err.hint } : {})
            });
            process.exitCode = 1;
          }
          return;
        }

        const files = resolveGraphFiles(workspace, graphArg);
        if (files.length === 0) {
          printJson({
            ok: false,
            code: "GRAPH_NOT_FOUND",
            error: `Graph not found: ${graphArg}`
          });
          process.exitCode = 1;
          return;
        }

        const parsed = readJsonFile(files[0]!);
        if (!parsed.ok) {
          printJson({ ok: false, code: "JSON_PARSE_ERROR", error: parsed.error });
          process.exitCode = 1;
          return;
        }

        const fileExists = makeFileExistsChecker(workspace);
        const validation = validateGraph(parsed.data, { fileExists });
        if (!validation.ok) {
          printJson({
            ok: false,
            code: "VALIDATION_ERROR",
            error: "Graph failed validation; fix errors before compiling activity",
            errors: validation.errors
          });
          process.exitCode = 1;
          return;
        }

        try {
          const result = compileActivity(parsed.data as Graph, compileOpts);
          process.stdout.write(result.text);
        } catch (err) {
          printJson({
            ok: false,
            code: err instanceof ActivityTimeRangeError ? err.code : "ACTIVITY_ERROR",
            error: err instanceof Error ? err.message : String(err),
            ...(err instanceof ActivityTimeRangeError ? { hint: err.hint } : {})
          });
          process.exitCode = 1;
        }
      }
    );

  program
    .command("list [dir]")
    .description("List all graphs in workspace with status summaries")
    .action((dir?: string) => {
      const globalOpts = program.opts<{ dir?: string }>();
      const workspace = resolveWorkspaceRoot(dir ?? globalOpts.dir);
      const graphs = listWorkspaceGraphs(workspace);
      printJson({
        ok: true,
        workspace,
        count: graphs.length,
        graphs
      });
    });

  program
    .command("serve [dir]")
    .description("Start or reuse the workspace Web + HTTP MCP service (127.0.0.1)")
    .option("-p, --port <port>", "Preferred port (auto-increments if occupied)", "4377")
    .action(async (dir: string | undefined, opts: { port: string }) => {
      const globalOpts = program.opts<{ dir?: string }>();
      const workspace = resolveWorkspaceRoot(dir ?? globalOpts.dir);
      const parsedPort = Number.parseInt(opts.port, 10);
      if (!Number.isFinite(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        printJson({
          ok: false,
          error: `Invalid --port value: ${opts.port}`
        });
        process.exitCode = 1;
        return;
      }

      try {
        const running = await ensureWorkspaceService({
          workspaceRoot: workspace,
          port: parsedPort
        });

        printJson({
          ok: true,
          workspace: running.workspaceRoot,
          host: running.host,
          port: running.port,
          url: running.url,
          mcpUrl: running.mcpUrl,
          tokenFile: path.join(running.workspaceRoot, ".thoughtchain", ".server-token"),
          reused: running.reused,
          pid: running.pid,
          graphs: listWorkspaceGraphs(running.workspaceRoot).map((g) => ({
            id: g.id,
            title: g.title,
            valid: g.valid,
            counts: g.counts
          }))
        });

        if (!running.server) return;
        const ownedServer = running.server;
        const shutdown = async () => {
          await ownedServer.close();
          process.exit(0);
        };
        process.once("SIGINT", () => void shutdown());
        process.once("SIGTERM", () => void shutdown());
      } catch (err) {
        printJson({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
        process.exitCode = 1;
      }
    });

  // ── Phase 2: MCP stdio server (PRD §7.4 / §7.5) ──────────────────────────
  program
    .command("mcp [dir]")
    .description("Start a private stdio MCP subprocess; for shared use, connect to tchain serve's /mcp URL")
    .action(async (dir?: string) => {
      const globalOpts = program.opts<{ dir?: string }>();
      const workspace = resolveWorkspaceRoot(dir ?? globalOpts.dir);
      await runMcpStdioServer(workspace);
    });

  // ── Phase 2: Patch commands (PRD §7.4) ───────────────────────────────────
  const patchCmd = program
    .command("patch")
    .description("Propose, inspect, apply, or reject graph change patches");

  patchCmd
    .command("propose <graph>")
    .description("Validate and submit a patch proposal from a JSON file")
    .requiredOption("-f, --file <patch.json>", "Path to JSON file containing patch or ops[]")
    .option("-t, --title <title>", "Override patch title")
    .option("-r, --rationale <rationale>", "Override patch rationale")
    .option("-a, --author <author>", "Override patch author")
    .action(
      async (
        graphArg: string,
        opts: { file: string; title?: string; rationale?: string; author?: string }
      ) => {
        const globalOpts = program.opts<{ dir?: string }>();
        const workspace = resolveWorkspaceRoot(globalOpts.dir);
        const filePath = path.resolve(opts.file);
        const parsed = readJsonFile(filePath);
        if (!parsed.ok) {
          printJson({ ok: false, code: "JSON_PARSE_ERROR", error: parsed.error });
          process.exitCode = 1;
          return;
        }

        let ops: Op[];
        let title = opts.title;
        let rationale = opts.rationale;
        let author = opts.author;

        if (Array.isArray(parsed.data)) {
          ops = parsed.data as Op[];
        } else if (parsed.data && typeof parsed.data === "object") {
          const obj = parsed.data as Record<string, unknown>;
          if (!Array.isArray(obj.ops)) {
            printJson({
              ok: false,
              code: "INVALID_PATCH_FILE",
              error: "Patch JSON must be an ops[] array or an object with an ops[] array"
            });
            process.exitCode = 1;
            return;
          }
          ops = obj.ops as Op[];
          title = title ?? (typeof obj.title === "string" ? obj.title : undefined);
          rationale =
            rationale ?? (typeof obj.rationale === "string" ? obj.rationale : undefined);
          author = author ?? (typeof obj.author === "string" ? obj.author : undefined);
        } else {
          printJson({ ok: false, code: "INVALID_PATCH_FILE", error: "Invalid JSON root" });
          process.exitCode = 1;
          return;
        }

        try {
          const result = await proposePatch({
            workspaceRoot: workspace,
            graphId: graphArg,
            title: title ?? path.basename(filePath, path.extname(filePath)),
            rationale: rationale ?? "",
            author: author ?? "cli",
            ops
          });
          printJson({
            ok: true,
            patchId: result.patch.id,
            graphId: result.patch.graphId,
            baseHash: result.patch.baseHash,
            file: result.relFile,
            summary: result.summary,
            warnings: result.patch.diagnostics
          });
        } catch (err) {
          if (err instanceof ApplyError) {
            printJson({
              ok: false,
              code: "VALIDATION_ERROR",
              error: err.message,
              diagnostics: err.diagnostics
            });
          } else {
            printJson({
              ok: false,
              code: err instanceof NotFoundError ? "GRAPH_NOT_FOUND" : "PROPOSE_ERROR",
              error: err instanceof Error ? err.message : String(err)
            });
          }
          process.exitCode = 1;
        }
      }
    );

  patchCmd
    .command("list [graph]")
    .description("List pending patch proposals in the workspace")
    .action((graphArg?: string) => {
      const globalOpts = program.opts<{ dir?: string }>();
      const workspace = resolveWorkspaceRoot(globalOpts.dir);
      const pending = listPendingPatches(workspace, graphArg);
      printJson({
        ok: true,
        workspace,
        count: pending.length,
        patches: pending.map((r) => ({
          id: r.patch.id,
          graphId: r.patch.graphId,
          title: r.patch.title,
          author: r.patch.author,
          state: r.patch.state,
          createdAt: r.patch.createdAt,
          file: r.relFile,
          opCount: r.patch.ops.length,
          isStale: r.evaluation?.isStale ?? false,
          conflictCount: r.evaluation?.conflictCount ?? 0,
          summary: r.evaluation?.summary
        }))
      });
    });

  patchCmd
    .command("show <patchId>")
    .description("Show full details and conflict evaluation of a patch")
    .action((patchId: string) => {
      const globalOpts = program.opts<{ dir?: string }>();
      const workspace = resolveWorkspaceRoot(globalOpts.dir);
      const rec = findPatchRecord(workspace, patchId);
      if (!rec) {
        printJson({ ok: false, code: "PATCH_NOT_FOUND", error: `Patch not found: ${patchId}` });
        process.exitCode = 1;
        return;
      }

      let evaluation = null;
      if (!rec.archived) {
        try {
          const loaded = readValidatedGraph(workspace, rec.patch.graphId);
          evaluation = evaluatePatchAgainstGraph(loaded.graph, rec.patch, {
            fileExists: makeFileExistsChecker(workspace)
          });
        } catch {
          evaluation = null;
        }
      }

      printJson({
        ok: true,
        archived: rec.archived,
        file: path.relative(workspace, rec.filePath).replace(/\\/g, "/"),
        patch: rec.patch,
        evaluation
      });
    });

  patchCmd
    .command("apply <patchId>")
    .description("Apply a pending patch (all non-conflicted ops or --only 0,2)")
    .option("--only <indices>", "Comma-separated 0-based op indices to apply (e.g. 0,2)")
    .action(async (patchId: string, opts: { only?: string }) => {
      const globalOpts = program.opts<{ dir?: string }>();
      const workspace = resolveWorkspaceRoot(globalOpts.dir);

      let only: number[] | undefined;
      if (opts.only !== undefined) {
        const parts = opts.only
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const nums = parts.map((p) => Number.parseInt(p, 10));
        if (nums.length === 0 || nums.some((n) => !Number.isInteger(n) || n < 0)) {
          printJson({
            ok: false,
            code: "INVALID_ONLY",
            error: `Invalid --only indices: ${opts.only}`
          });
          process.exitCode = 1;
          return;
        }
        only = nums;
      }

      try {
        const result = await applyPatchById({
          workspaceRoot: workspace,
          patchId,
          only
        });
        printJson({
          ok: true,
          patchId: result.patch.id,
          state: result.patch.state,
          graphId: result.patch.graphId,
          hash: result.hash,
          appliedIndices: result.appliedIndices,
          skippedIndices: result.skippedIndices,
          savedRev: result.savedRev,
          warnings: result.warnings
        });
      } catch (err) {
        if (err instanceof ApplyError) {
          printJson({
            ok: false,
            code: "VALIDATION_ERROR",
            error: err.message,
            diagnostics: err.diagnostics
          });
        } else {
          printJson({
            ok: false,
            code: err instanceof NotFoundError ? "PATCH_NOT_FOUND" : "APPLY_ERROR",
            error: err instanceof Error ? err.message : String(err)
          });
        }
        process.exitCode = 1;
      }
    });

  patchCmd
    .command("reject <patchId>")
    .description("Reject a pending patch and move it to patches/archive/")
    .action(async (patchId: string) => {
      const globalOpts = program.opts<{ dir?: string }>();
      const workspace = resolveWorkspaceRoot(globalOpts.dir);
      try {
        const patch = await rejectPatchById(workspace, patchId);
        printJson({
          ok: true,
          patchId: patch.id,
          state: patch.state,
          graphId: patch.graphId
        });
      } catch (err) {
        printJson({
          ok: false,
          code: err instanceof NotFoundError ? "PATCH_NOT_FOUND" : "REJECT_ERROR",
          error: err instanceof Error ? err.message : String(err)
        });
        process.exitCode = 1;
      }
    });

  // ── Phase 2: History & Rollback commands (PRD §7.4) ──────────────────────
  program
    .command("history <graph>")
    .description("List saved history snapshots for a graph")
    .action((graphArg: string) => {
      const globalOpts = program.opts<{ dir?: string }>();
      const workspace = resolveWorkspaceRoot(globalOpts.dir);
      const entries = readHistoryIndex(workspace, graphArg);
      printJson({
        ok: true,
        workspace,
        graphId: graphArg,
        count: entries.length,
        entries
      });
    });

  program
    .command("rollback <graph> <rev>")
    .description("Rollback a graph to a previous snapshot revision (reversible)")
    .action(async (graphArg: string, revRaw: string) => {
      const globalOpts = program.opts<{ dir?: string }>();
      const workspace = resolveWorkspaceRoot(globalOpts.dir);
      const rev = Number.parseInt(revRaw.replace(/^rev-?/i, ""), 10);
      if (!Number.isInteger(rev) || rev <= 0) {
        printJson({
          ok: false,
          code: "INVALID_REV",
          error: `Invalid revision number: ${revRaw}`
        });
        process.exitCode = 1;
        return;
      }

      try {
        const result = await rollbackGraph({
          workspaceRoot: workspace,
          graphId: graphArg,
          rev
        });
        printJson({
          ok: true,
          graphId: graphArg,
          rolledBackToRev: result.rolledBackToRev,
          savedRev: result.savedRev,
          hash: result.hash,
          warnings: result.warnings
        });
      } catch (err) {
        printJson({
          ok: false,
          code: err instanceof NotFoundError ? "REV_NOT_FOUND" : "ROLLBACK_ERROR",
          error: err instanceof Error ? err.message : String(err)
        });
        process.exitCode = 1;
      }
    });

  return program;
}

// Run CLI when invoked directly
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("cli.ts"));

if (isMain) {
  createProgram().parse(process.argv);
}
