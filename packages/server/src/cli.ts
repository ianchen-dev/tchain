#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  compileContext,
  computeFocus,
  hashGraph,
  serializeGraph,
  validateGraph,
  type Diagnostic,
  type Graph
} from "@tchain/core";
import {
  initWorkspace,
  makeFileExistsChecker,
  resolveGraphFiles,
  resolveWorkspaceRoot
} from "./workspace.js";
import { listWorkspaceGraphs } from "./store.js";
import { startWorkbenchServer } from "./server.js";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readJsonFile(filePath: string): { ok: true; data: unknown } | { ok: false; error: string } {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
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
    .description("ThoughtChain Decision Workbench CLI & local server")
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
        if (opts.maxTokens !== undefined && (!Number.isFinite(maxTokens) || (maxTokens ?? 0) <= 0)) {
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
    .description("Start the local ThoughtChain Web Workbench server (127.0.0.1 + SSE)")
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
        const running = await startWorkbenchServer({
          workspaceRoot: workspace,
          port: parsedPort
        });

        printJson({
          ok: true,
          workspace: running.workspaceRoot,
          host: running.host,
          port: running.port,
          url: running.url,
          graphs: running.store.listSummaries().map((g) => ({
            id: g.id,
            title: g.title,
            valid: g.valid,
            counts: g.counts
          }))
        });

        const shutdown = async () => {
          await running.close();
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

  return program;
}

// Run CLI when invoked directly
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("cli.ts"));

if (isMain) {
  createProgram().parse(process.argv);
}
