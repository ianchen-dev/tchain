import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ApplyError,
  compileContext,
  getGraphOverview,
  OpSchema,
  searchNodes,
  StatusSchema
} from "@tchain/core";
import { listWorkspaceGraphs } from "./store.js";
import {
  listPendingPatches,
  NotFoundError,
  proposePatch,
  readValidatedGraph
} from "./storage.js";
import { resolveWorkspaceRoot } from "./workspace.js";

function jsonTextResult(payload: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${JSON.stringify(payload, null, 2)}\n`
      }
    ],
    ...(isError ? { isError: true } : {})
  };
}

/**
 * Creates the ThoughtChain MCP Server with strictly 5 tools (PRD §7.5):
 * 4 read-only discovery tools + 1 patch-only proposal tool.
 * Deliberately exposes NO direct graph write tool.
 */
export function createThoughtChainMcpServer(workspaceDir?: string): McpServer {
  const workspaceRoot = resolveWorkspaceRoot(workspaceDir);

  const server = new McpServer({
    name: "tchain",
    version: "0.1.0"
  });

  // 1. list_graphs
  server.tool(
    "list_graphs",
    "列出当前工作区的所有思维链图谱及其元数据、当前哈希、状态计数、焦点节点列表和待审 Patch 数量。修改图谱请调用 propose_graph_patch，不要直接编辑 .tgraph.json。",
    {},
    async () => {
      const graphs = listWorkspaceGraphs(workspaceRoot);
      const pendingPatches = listPendingPatches(workspaceRoot);
      const pendingByGraph = new Map<string, number>();
      for (const rec of pendingPatches) {
        pendingByGraph.set(
          rec.patch.graphId,
          (pendingByGraph.get(rec.patch.graphId) ?? 0) + 1
        );
      }

      return jsonTextResult({
        ok: true,
        workspaceRoot,
        graphs: graphs.map((g) => ({
          ...g,
          pendingPatchCount: pendingByGraph.get(g.id) ?? 0
        }))
      });
    }
  );

  // 2. get_graph_overview
  server.tool(
    "get_graph_overview",
    "获取指定图谱的顶层结构概览、关键决策/里程碑、当前进行中与下一步焦点分支、已搁置路线与已否决节点。修改图谱请调用 propose_graph_patch，不要直接编辑 .tgraph.json。",
    {
      graphId: z.string().min(1).describe("图谱 ID（如 announcement-pipeline）"),
      maxDepth: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("结构树展开深度，默认 2")
    },
    async ({ graphId, maxDepth }) => {
      try {
        const loaded = readValidatedGraph(workspaceRoot, graphId);
        const overview = getGraphOverview(loaded.graph, maxDepth ?? 2);
        return jsonTextResult({ ok: true, overview });
      } catch (err) {
        return jsonTextResult(
          {
            ok: false,
            code: err instanceof NotFoundError ? "GRAPH_NOT_FOUND" : "GRAPH_ERROR",
            message: err instanceof Error ? err.message : String(err)
          },
          true
        );
      }
    }
  );

  // 3. get_node_context
  server.tool(
    "get_node_context",
    "上下文编译器：为指定节点生成固定 6 段裁剪上下文包（①全局目标 ②决策来路 ③避坑约束 ④可恢复路线 ⑤当前任务与邻接节点 ⑥关联证据路径），默认输出 Markdown。修改图谱请调用 propose_graph_patch，不要直接编辑 .tgraph.json。",
    {
      graphId: z.string().min(1).describe("图谱 ID"),
      nodeId: z.string().min(1).describe("目标节点 ID（如 K3）"),
      format: z
        .enum(["md", "json"])
        .optional()
        .describe("输出格式：md（默认，省 token）或 json"),
      maxTokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("最大估算 token 数；超出时按 ⑥ → ④ → ② 顺序裁剪")
    },
    async ({ graphId, nodeId, format, maxTokens }) => {
      try {
        const loaded = readValidatedGraph(workspaceRoot, graphId);
        const compiled = compileContext(loaded.graph, nodeId, {
          format: format ?? "md",
          maxTokens
        });
        if (compiled.format === "md") {
          return {
            content: [{ type: "text" as const, text: compiled.text }]
          };
        }
        return jsonTextResult({
          ok: true,
          estimatedTokens: compiled.estimatedTokens,
          data: compiled.data
        });
      } catch (err) {
        return jsonTextResult(
          {
            ok: false,
            code: err instanceof NotFoundError ? "GRAPH_NOT_FOUND" : "CONTEXT_ERROR",
            message: err instanceof Error ? err.message : String(err)
          },
          true
        );
      }
    }
  );

  // 4. search_nodes
  server.tool(
    "search_nodes",
    "按关键词（匹配 ID/标题/说明/结论/状态备注/指标/附件）和可选状态检索图谱节点。修改图谱请调用 propose_graph_patch，不要直接编辑 .tgraph.json。",
    {
      graphId: z.string().min(1).describe("图谱 ID"),
      query: z.string().default("").describe("搜索关键词（多个词以空格分隔）"),
      status: StatusSchema.optional().describe("可选：按有效状态或显式状态过滤")
    },
    async ({ graphId, query, status }) => {
      try {
        const loaded = readValidatedGraph(workspaceRoot, graphId);
        const hits = searchNodes(loaded.graph, query, status);
        return jsonTextResult({
          ok: true,
          graphId: loaded.graph.id,
          count: hits.length,
          hits
        });
      } catch (err) {
        return jsonTextResult(
          {
            ok: false,
            code: err instanceof NotFoundError ? "GRAPH_NOT_FOUND" : "SEARCH_ERROR",
            message: err instanceof Error ? err.message : String(err)
          },
          true
        );
      }
    }
  );

  // 5. propose_graph_patch (ONLY mutation tool — never edits .tgraph.json directly!)
  server.tool(
    "propose_graph_patch",
    "提交思维链图谱变更提案（Patch）。修改图谱请调用 propose_graph_patch，不要直接编辑 .tgraph.json。服务端会立即执行完整语义校验，合法时写入 .thoughtchain/patches/ 待用户在工作台审查后落盘；不合法时返回带 code/path/hint 的结构化错误供自行修正。",
    {
      graphId: z.string().min(1).describe("目标图谱 ID"),
      title: z.string().min(1).describe("本次变更提案的简短标题"),
      rationale: z.string().describe("变更原因与依据说明"),
      author: z.string().optional().describe("提交者标识（如 codex / antigravity）"),
      ops: z
        .array(OpSchema)
        .min(1)
        .describe(
          "按顺序执行的原子操作列表（add_node / update_node / remove_node / add_edge / remove_edge）"
        )
    },
    async ({ graphId, title, rationale, author, ops }) => {
      try {
        const result = await proposePatch({
          workspaceRoot,
          graphId,
          title,
          rationale,
          author: author ?? "mcp-agent",
          ops
        });
        return jsonTextResult({
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
          return jsonTextResult(
            {
              ok: false,
              code: "VALIDATION_ERROR",
              message: err.message,
              diagnostics: err.diagnostics
            },
            true
          );
        }
        return jsonTextResult(
          {
            ok: false,
            code: err instanceof NotFoundError ? "GRAPH_NOT_FOUND" : "PROPOSE_ERROR",
            message: err instanceof Error ? err.message : String(err)
          },
          true
        );
      }
    }
  );

  return server;
}

export async function runMcpStdioServer(workspaceDir?: string): Promise<void> {
  const server = createThoughtChainMcpServer(workspaceDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
