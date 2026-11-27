# 周报自动生成（Activity / Weekly Report）功能规范

> **文档状态**：设计定稿（待实施）  
> **更新日期**：2026-11-27  
> **关联主文档**：[思维链决策工作台-PRD.md](../思维链决策工作台-PRD.md)（v1.4）  
> **依赖前置**：节点级可选时间戳 `createdAt` / `updatedAt` / `statusChangedAt` 与容器派生 `subtreeUpdatedAt`（PRD v1.3）

---

## 1. 背景与架构定位

`tchain` 已通过 `compileContext`（`tchain context` / `get_node_context`）解决了**空间维度**的上下文切片问题——围绕单个目标节点提取全局目标、决策来路、避坑约束、可恢复路线与邻接关系。

本模块（**Activity / 周报自动生成**）补齐**时间维度**的确定性切片能力：

1. **严格遵守公理 3（Deterministic Tool）**：`tchain` 自身绝不内置 LLM 调用、不管理 API Key 或 Prompt。Core / CLI / MCP 只负责按时间窗与图谱当前状态，确定性地提取高信噪比的结构化素材（Markdown / JSON），再由用户本机的外部 Agent（Codex / Antigravity 等）根据受众（向上汇报 / 团队同步 / 个人复盘）一键润色成最终周报。
2. **数据源范围（选项 A）**：本阶段完全基于当前 `.tgraph.json` 中的节点语义字段、有效状态与节点时间戳计算：
   - `@tchain/core` 保持纯函数、零 IO；
   - 不依赖可被 `.gitignore` 或滚动上限（50 份）清理的 `.thoughtchain/history/`，任何机器拉取 Git 仓库即可生成。
   - **已知边界**：时间窗内被直接删除（`remove_node`）的节点，以及同一节点在窗内发生多次状态往返的中间态，不在本阶段统计范围内；后续如需补充变更轨迹，可在服务端层额外读取 `history/index.json` 作为附录扩展。

---

## 2. 核心输出模型：两层六段结构

### 2.1 设计演进：为什么取消「长期停滞警报」

如果只查「最近 7 天时间戳有变化的节点」，会出现两类盲区：
1. **老卡点从周报中隐身**：十天前被标为 `blocked` 的节点本周仍未解开且无人编辑，若仅按 7 天时间窗过滤就会遗漏；
2. **僵尸 `active` 污染图谱**：曾经标为 `active` 的任务后来被切走但忘了改回 `parked` 或 `done`，长期停留在焦点视图。

若将这两类直接包装为「长期停滞警报（如 >14 天）」，会带来三个副作用：
- **受众错位**：对外/向上周报关心「产出、当前阻塞、下一步」，外部 Agent 容易把“离线编码或调研尚未回写图谱”误写成“项目停滞”；
- **阈值武断**：7 天或 14 天一刀切对长周期调研必然产生大量误报；
- **语义重叠**：本质上是“当前仍处于 `blocked` 或 `active` 且本周无更新的事项快照”，而非需要阈值判定的警报。

因此本规范取消「长期停滞警报」概念与 `--stale` 阈值参数，采用客观事实呈现的**「Part A · 本周变化（时间窗）」+「Part B · 持续项与下周焦点（当前态快照）」**两层六段结构。

---

### 2.2 元信息头

每份单图或多图活动简报顶部固定输出元信息头：

- **统计区间**：本地起止时间、时区偏移与快捷口径（如 `2026-11-20 00:00 ~ 2026-11-27 11:30 (+08:00，近 7 天)`）；
- **概览计数**：完成 / 推进 / 阻塞与搁置 / 否决 / 新增 / 持续阻塞 / 进行中（无更新）；
- **时间覆盖率**：例如 `22/28 个节点含时间记录（6 个历史节点无时间戳，未参与时间筛选）`，明确区分“无变化”与“历史节点尚无时间戳”，避免误判。

---

### 2.3 Part A · 本周变化（基于时间窗 `[since, until]`）

时间窗采用闭区间判断：`sinceMs <= ts <= untilMs`。

#### 2.3.1 严格互斥主桶与归类判定优先级

一个节点在同一周内可能同时被创建、编辑结论并标记为完成。为防止外部 Agent 重复汇报和计数失真，**每个节点在 Part A 中至多进入 1 个主桶**，按以下判定优先级从高到低命中首个条件：

| 判定优先级 | 归类主桶 | 命中条件（在时间窗 `[since, until]` 内） | 补充规则与角标 |
| :--- | :--- | :--- | :--- |
| **1** | **本周完成** | `effectiveStatus === "done"` 且 `(statusChangedAt ?? updatedAt) ∈ 窗` | 若同时 `createdAt ∈ 窗`，附带 `[本周新建]` 角标。<br>**关键区分**：若节点上周已 `done`（`statusChangedAt < since`），本周仅补充修改了 `conclusion` / `metrics` / `attachments`（`updatedAt ∈ 窗`），则**不归入本周完成**，而降级归入「本周推进」并标注 `[补充更新]`，避免虚报本周完成数。 |
| **2** | **本周新阻塞、搁置与否决** | 节点**自身显式** `status ∈ { "blocked", "parked", "discarded" }` 且 `(statusChangedAt ?? updatedAt) ∈ 窗`；或当前有效状态为上述三者之一且本周更新了内容/备注（`updatedAt ∈ 窗`） | **容器继承防刷屏**：若某祖先容器被显式设为 `parked` / `discarded`，只报告该容器本身及其 `statusNote`，**不展开**仅因状态继承而变为 `parked` / `discarded` 的历史子节点。<br>`discarded` 条目显式标出「否决原因（避坑）」。 |
| **3** | **本周推进** | `updatedAt ∈ 窗`，或 `effectiveStatus === "active"` 且 `statusChangedAt ∈ 窗`，且未命中优先级 1、2（同时排除仅有 `createdAt ∈ 窗` 而无实质推进的新建 `todo` 节点） | 涵盖 `active` 推进、已有节点补充 `description` / `conclusion` / `metrics` / `attachments`，以及已 `done` 节点在完成后的内容补充（标 `[补充更新]`）。若同时 `createdAt ∈ 窗`，附带 `[本周新建]`。 |
| **4** | **本周新增** | `createdAt ∈ 窗` 且未命中优先级 1~3 | 主要是本周新拆解出的 `todo` 任务、新识别的 `decision` / `option` 分支。 |

#### 2.3.2 Markdown 展示顺序

为了符合周报阅读直觉，Markdown 中的展示顺序为：
1. **① 本周完成**
2. **② 本周推进**
3. **③ 本周新阻塞、搁置与否决**
4. **④ 本周新增**

#### 2.3.3 容器与叶子去重规则

- **仅子节点变化时，容器不单独入桶**：容器动态派生的 `subtreeUpdatedAt` 只用于前端 Inspector 提示子树活跃度，**不作为容器自身入桶依据**。容器未修改自身字段时，仅以**层级面包屑**（如 `G > H > H2`）形式出现在子节点条目中提供上下文。
- **容器自身变化时才独立入桶**：当容器本身在时间窗内被新建、填写/修改了 `title` / `description` / `conclusion` / `metrics` / `attachments`，或显式切换了 `status`（如整支被 `parked` / `discarded` / `done`），才作为独立条目进入对应主桶。

---

### 2.4 Part B · 持续项与下周焦点（基于当前图态快照）

Part B 不设停滞时间阈值，只客观反映当前图谱的状态快照，且**与 Part A 互斥**（已出现在 Part A 中的节点不在 Part B 的持续项中重复列出）。

5. **⑤ 持续阻塞与进行中（本周无更新）**
   - **持续阻塞中**：所有当前 `effectiveStatus === "blocked"` 且不在 Part A 中的节点。
     - 若祖先容器已被显式设为 `parked` / `discarded`，其后代的 `effectiveStatus` 已继承为 `parked` / `discarded` 而非 `blocked`，自动排除；
     - 平铺事实性附注 `上次更新于 YYYY-MM-DD（N 天前）` 与 `statusNote`；若节点三项时间字段全为空，标注 `无时间记录`（绝不编造天数）。
   - **当前进行中（本周无更新）**：所有当前 `effectiveStatus === "active"` 的**叶子节点**（容器的 `active` 为汇总值，不重复计入）且不在 Part A 中的节点。
     - 同样客观附注 `上次更新于 YYYY-MM-DD（N 天前）` 或 `无时间记录`。

6. **⑥ 下一步就绪前沿（供下周计划参考）**
   - 直接复用 `computeFocus(graph)` 返回的 `nextIds`（当全图无 `active` 节点时沿用 `computeFocus` 的全图就绪前沿与阻塞退化逻辑）；
   - 在条目中简要附带节点 `id`、`type`、`title`、路径面包屑及 `description` 摘要；
   - 支持通过参数 `includeNext: false`（CLI `--no-next`）关闭此段。

---

### 2.5 确定性排序规则

| 分段 | 排序规则 | 平局打破（Tie-breaker） |
| :--- | :--- | :--- |
| **① 本周完成** | 按 `statusChangedAt ?? updatedAt` **倒序**（最新完成在前） | 按图谱 `nodes` 数组模型顺序 |
| **② 本周推进** | 按 `updatedAt ?? statusChangedAt` **倒序**（最新更新在前） | 按图谱 `nodes` 数组模型顺序 |
| **③ 本周新阻塞、搁置与否决** | 按 `statusChangedAt ?? updatedAt` **倒序** | 按图谱 `nodes` 数组模型顺序 |
| **④ 本周新增** | 按 `createdAt` **倒序** | 按图谱 `nodes` 数组模型顺序 |
| **⑤ 持续阻塞中 / 当前进行中（无更新）** | 按 `lastTouch = max(updatedAt, statusChangedAt, createdAt)` **正序**（最久未更新在前，便于一眼识别老卡点与僵尸 `active`）；无时间戳节点排在末尾 | 按图谱 `nodes` 数组模型顺序 |
| **⑥ 下一步就绪前沿** | 保持 `computeFocus(graph).nextIds` 输出顺序 | — |

---

### 2.6 `maxTokens` 预算裁剪策略

复用 `@tchain/core` 中的 `estimateTokens(text)`。当指定 `maxTokens > 0` 且渲染文本超出预算时，按**低优先级 → 高优先级**逐条裁剪（多图谱模式下按同样顺序对各图谱统一逐轮裁剪）：

1. `⑥ 下一步就绪前沿`（从后往前裁）
2. `④ 本周新增`（从最旧/末尾往前裁）
3. `⑤ 当前进行中（本周无更新）`（从末尾往前裁）
4. `② 本周推进`（从最旧/末尾往前裁）

尽量保全 **① 本周完成**、**③ 本周新阻塞/搁置/否决** 与 **⑤ 持续阻塞中**。发生裁剪时，在文末附加注记说明被裁剪的分段名称（与 `compileContext` 一致）。

---

### 2.7 多图谱汇总规则

当工作区存在多张有效 `.tgraph.json` 图谱且未指定单个 `graphId` 时：

1. **工作区总览表**：在文档顶部输出所有有效图谱的汇总表（图谱标题 / ID、完成数、推进数、阻塞/搁置/否决数、新增数、持续阻塞数、无更新进行中数、时间覆盖率）。
2. **按图谱展开明细**：
   - 若某图谱存在 Part A 变化，或存在 Part B 的持续阻塞/进行中项，按图谱独立输出两层六段明细；
   - 若某图谱在时间窗内**全无变化且无持续阻塞/无更新进行中项**，仅在总览表中标明「本区间无变化」，**不展开空段落**以节省 token。
3. 存在校验失败的损坏图谱时，在元信息中标明跳过原因，不阻断其余有效图谱的周报生成。

---

## 3. 时间参数解析与时区规范

### 3.1 参数定义

| 参数 | 默认值 | 支持格式 | 解析规则（基于运行环境本地时区，支持显式注入 `now` 与 `tzOffsetMinutes`） |
| :--- | :--- | :--- | :--- |
| `since` | `"7d"` | 1. **相对时长**：`<N>h` / `<N>d` / `<N>w`（`N` 为正整数）<br>2. **自然周快捷词**：`this-week` / `last-week`<br>3. **本地日期**：`YYYY-MM-DD`<br>4. **ISO-8601**：带时区偏移或 `Z` 的完整日期时间 | - `<N>h/d/w`：从最终确定的 `until` 往前减对应小时 / 天（`24h * N`） / 周（`7 * 24h * N`）；<br>- `this-week`：本地时区**本周一 `00:00:00.000`**；<br>- `last-week`：本地时区**上周一 `00:00:00.000`**；若未显式传入 `until`，`until` 自动锁定为**上周日 `23:59:59.999`**；<br>- `YYYY-MM-DD`：本地时区当天 `00:00:00.000`；<br>- ISO-8601：按精确瞬时解析。 |
| `until` | 当前时刻 `now` | 1. **本地日期**：`YYYY-MM-DD`<br>2. **ISO-8601**：带时区偏移或 `Z` 的完整日期时间 | - `YYYY-MM-DD`：按本地时区当天 `23:59:59.999` **闭区间**解析（例如 `--since 2026-11-20 --until 2026-11-26` 包含 26 日全天）；<br>- ISO-8601：按精确瞬时解析。 |

### 3.2 非法输入与确定性

- 格式无法识别、日期不存在（如 `2026-02-30`）、或 `since > until` 时，抛出结构化错误 `INVALID_TIME_RANGE`（附 `hint` 说明合法格式）：
  - CLI 返回 JSON 错误并设退出码为 `1`；
  - HTTP API 返回 `400 Bad Request`；
  - MCP 返回 `isError: true` 的结构化错误。
- `parseActivityWindow` 与 `compileActivity` 均支持注入 `now`（ISO 字符串或 `Date`）与 `tzOffsetMinutes`（可选），确保所有单元测试与快照测试在任何主机时区下 100% 确定可复现。

---

## 4. 各层接口契约

### 4.1 `@tchain/core` 纯函数与类型

在 `packages/core/src/activity.ts` 实现并在 `packages/core/src/index.ts` 导出：

```ts
export interface ActivityWindow {
  sinceIso: string;          // UTC ISO-8601 下界
  untilIso: string;          // UTC ISO-8601 上界
  nowIso: string;            // 基准当前时间（用于计算“N 天前”）
  sinceExpr: string;         // 原始或归一化表达式（如 "7d" / "this-week"）
  untilExpr?: string;
  tzOffsetMinutes: number;   // 用于格式化本地日期显示（如 +480 表示 UTC+08:00）
}

export interface CompileActivityOptions {
  since?: string;            // 默认 "7d"
  until?: string;
  now?: string;              // 测试/确定性注入
  tzOffsetMinutes?: number;  // 测试/确定性注入
  format?: "md" | "json";    // 默认 "md"
  maxTokens?: number;
  includeNext?: boolean;     // 默认 true
}

export interface ActivityNodeItem {
  id: string;
  type: Node["type"];
  title: string;
  breadcrumb: string[];      // 祖先链 ["G 公告分析...", "H 小规模研究", "H2 费用估算"]
  status: Status;
  effectiveStatus: Status;
  eventAt?: string;          // 命中主桶的时间戳（Part A）或 lastTouch（Part B）
  daysSinceLastTouch?: number; // 仅 Part B 有时间戳节点提供
  tags: string[];            // 如 ["本周新建"] / ["补充更新"]
  description?: string;
  conclusion?: string;
  statusNote?: string;
  metrics?: Metric[];
  attachments?: Attachment[];
}

export interface CompiledActivityData {
  graphId: string;
  graphTitle: string;
  window: ActivityWindow;
  coverage: {
    totalNodes: number;
    timestampedNodes: number;
    untrackedNodes: number;
  };
  counts: {
    done: number;
    progressed: number;
    blockedOrParkedOrDiscarded: number;
    discarded: number;
    created: number;
    ongoingBlocked: number;
    ongoingActiveUntouched: number;
    nextReady: number;
  };
  sections: {
    done: ActivityNodeItem[];
    progressed: ActivityNodeItem[];
    blockedOrParkedOrDiscarded: ActivityNodeItem[];
    created: ActivityNodeItem[];
    ongoingBlocked: ActivityNodeItem[];
    ongoingActiveUntouched: ActivityNodeItem[];
    nextReady: ActivityNodeItem[];
  };
  truncatedSections: string[];
}

export function parseActivityWindow(opts?: {
  since?: string;
  until?: string;
  now?: string;
  tzOffsetMinutes?: number;
}): ActivityWindow;

export function compileActivity(
  graph: Graph,
  options?: CompileActivityOptions
): {
  format: "md" | "json";
  text: string;
  data: CompiledActivityData;
  estimatedTokens: number;
};

export function compileWorkspaceActivity(
  graphs: Graph[],
  options?: CompileActivityOptions
): {
  format: "md" | "json";
  text: string;
  data: {
    window: ActivityWindow;
    graphCount: number;
    graphs: CompiledActivityData[];
    truncatedSections: string[];
  };
  estimatedTokens: number;
};
```

---

### 4.2 CLI 命令

新增 `tchain activity` 子命令：

```text
tchain activity [graph] [options]
```

- **参数**：
  - `[graph]`：可选，图谱 ID 或 `.tgraph.json` 文件名/路径；**省略时自动汇总工作区所有有效图谱**。
- **选项**：
  - `--since <expr>`：默认 `7d`（支持 `24h` / `7d` / `14d` / `4w` / `this-week` / `last-week` / `YYYY-MM-DD` / ISO-8601）；
  - `--until <expr>`：默认当前时刻；
  - `-f, --format <format>`：`md`（默认）或 `json`；
  - `--max-tokens <n>`：最大估算 token 数；
  - `--no-next`：不输出「⑥ 下一步就绪前沿」。
- **输出行为**：
  - `md` 模式直接将 Markdown 打印到 `stdout`（方便终端复制、管道传给外部 Agent 或重定向到文件），与 `tchain context` 保持一致；
  - `json` 模式输出 2 空格缩进的多行 JSON；
  - 错误（如图谱不存在、图谱校验失败、时间参数非法）输出结构化 JSON 错误并设 `process.exitCode = 1`。

---

### 4.3 MCP Server 工具

在 `packages/server/src/mcp.ts` 新增第 6 个工具 **`get_graph_activity`**（MCP 工具总数：5 个只读发现工具 + 1 个写入提案工具 `propose_graph_patch`；本轮 `search_nodes` 保持简洁不变）：

- **工具名**：`get_graph_activity`
- **描述**：时间维度的活动简报 / 周报素材编译器。按节点 `createdAt` / `updatedAt` / `statusChangedAt` 提取指定时间窗内的完成、推进、阻塞/搁置/否决与新增节点，并附带当前持续阻塞、无更新进行中节点及下一步就绪前沿；省略 `graphId` 时自动汇总工作区全部图谱。修改图谱请调用 `propose_graph_patch`，不要直接编辑 `.tgraph.json`。
- **入参 Schema（Zod）**：
  - `graphId?: z.string().min(1)`：可选，不传则汇总工作区所有有效图谱；
  - `since?: z.string()`：可选，默认 `"7d"`；
  - `until?: z.string()`：可选，默认当前时刻；
  - `format?: z.enum(["md", "json"])`：可选，默认 `"md"`；
  - `maxTokens?: z.number().int().positive()`：可选；
  - `includeNext?: z.boolean()`：可选，默认 `true`。
- **返回**：
  - `format === "md"` 时直接返回纯 Markdown 文本 content（省 token，方便 Agent 直接润色成周报）；
  - `format === "json"` 时返回 `{ ok: true, estimatedTokens, data }`；
  - 异常时返回 `{ ok: false, code, message }`（`isError: true`）。

---

### 4.4 本地 HTTP API

在 `packages/server/src/server.ts` 新增两个只读接口，自动继承现有 `127.0.0.1` 绑定、`Host` / `Origin` / `Sec-Fetch-Site` 校验与 `token` 鉴权：

1. `GET /api/activity`：汇总工作区所有有效图谱的活动简报；
2. `GET /api/graphs/:id/activity`：获取指定图谱的活动简报。

**Query 参数**：`since`（默认 `7d`）、`until`、`format`（`md | json`，默认 `md`）、`maxTokens`、`includeNext`（`true | false`，默认 `true`）。

**响应格式（JSON 包裹）**：
```json
{
  "ok": true,
  "format": "md",
  "text": "# 活动简报：...",
  "estimatedTokens": 420,
  "data": { ... }
}
```
（与现有 `GET /api/graphs/:id/context` 响应结构对称。）

---

### 4.5 Web 工作台轻量入口

在 `packages/web/src/components/TopBar.tsx` 右侧工具区新增一个轻量入口，交互风格与 Inspector 中的「复制 AI 上下文」保持一致：

- **可见性**：仅在「工作态（workspace）」与「焦点态（focus）」显示；**在「汇报态（report）」自动隐藏**，保持现场投屏界面干净。
- **按钮与 Popover**：
  - 按钮文案：`周报素材`（图标采用 `CalendarRange` 或 `ClipboardList`）；
  - 点击展开轻量 Popover 面板：
    - **时间范围快选**：`近 7 天`（默认） / `本周` / `上周`；
    - **图谱范围**（仅当工作区有效图谱数 > 1 时显示）：`当前图谱` / `全部图谱`；
    - **主操作按钮**：「复制周报素材」（Markdown）。
- **执行与反馈**：
  - 调用 `/api/graphs/:id/activity` 或 `/api/activity` 获取确定性 Markdown，写入系统剪贴板；
  - 按钮短时变为「已复制」，并通过现有 `showToast` 弹出提示，例如：`已复制近 7 天周报素材（完成 2 / 推进 2 / 持续阻塞 1）`；
  - 允许用户在剪贴板复制后直接粘贴到 Codex / Antigravity 对话框中润色成周报。

---

## 5. 输出样例预览（Markdown）

以下以 0 号样板 `announcement-pipeline` 为例展示单图 Markdown 输出结构：

```markdown
# 活动简报：持续采集全市场公告并回补历史一年（announcement-pipeline）

- 统计区间：2026-11-20 00:00 ~ 2026-11-27 11:30 (+08:00，近 7 天)
- 概览：完成 2 | 推进 2 | 阻塞/搁置/否决 2 | 新增 1 | 持续阻塞 1 | 进行中(无更新) 0
- 时间覆盖：22/28 个节点含时间记录（6 个历史节点无时间戳，未参与时间筛选）

## ① 本周完成（2）
- **[milestone] H9 汇总全量处理基线**（路径：G > H > H2）`完成于 2026-11-24` `[月度基线: ~X元]`
  - 结论：已完成三项费用初版预算测算，等待目标板块名单与服务实测复核
  - 证据：`docs/cost-baseline.md`
- **[task] H8 汇总云解析费用**（路径：G > H > H2 > H4）`完成于 2026-11-23` `[本周新建]`

## ② 本周推进（2）
- **[task] K1 统计各公告类别数量与文本长度**（路径：G > H > K）`[active]` `更新于 2026-11-25`
  - 进展/结论：已完成类别数量统计，正在补充 PDF 页数与字符长度分布
- **[milestone] E 形成方案对比结论**（路径：B）`[done]` `[补充更新]` `更新于 2026-11-22`
  - 补充结论：补充外部并发上限核对记录

## ③ 本周新阻塞、搁置与否决（2）
- **[option] I 暂停公告分析，恢复新闻分析**（路径：G）`[parked]` `变更于 2026-11-22`
  - 搁置原因/恢复条件：先完成小规模降本测算后再评估是否切回新闻线
- **[task] X2 全市场云解析直出**（路径：B > D）`[discarded]` `变更于 2026-11-21`
  - 否决原因（避坑）：费用超出预算数量级，保留作为避坑约束

## ④ 本周新增（1）
- **[task] K3 核对结构化财报覆盖范围**（路径：G > H > K）`[todo]` `创建于 2026-11-25`
  - 说明：核对现有财报库对公告原件的替代比例

## ⑤ 持续阻塞与进行中（本周无更新）
- **持续阻塞中（1）**
  - **[task] H5 代理池费用调研**（路径：G > H > H2）`上次更新于 2026-11-08（19 天前）`
    - 阻塞原因：待确认目标抓取频率与并发上限
- **当前进行中（本周无更新，0）**
  - （无）

## ⑥ 下一步就绪前沿（供下周计划参考）
- **[task] K2 优先评估财报原件**（路径：G > H > K）`[todo]`
  - 说明：财报原件约占公告总数 7%，优先评估能否用已有结构化财报数据替代
```

多图谱汇总时顶部总览表样例：

```markdown
# 工作区活动简报汇总（2 张图谱）

- 统计区间：2026-11-20 00:00 ~ 2026-11-27 11:30 (+08:00，近 7 天)

| 图谱 | 完成 | 推进 | 阻塞/搁置/否决 | 新增 | 持续阻塞 | 进行中(无更新) | 时间覆盖 | 状态 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| 公告分析管道 (`announcement-pipeline`) | 2 | 2 | 2 | 1 | 1 | 0 | 22/28 | 有更新 |
| 新闻库重构 (`news-library`) | 0 | 0 | 0 | 0 | 0 | 0 | 12/12 | 本区间无变化 |
```

---

## 6. 测试与验收标准

### 6.1 `@tchain/core` 单元测试

- [ ] **时间参数解析**：覆盖 `24h` / `7d` / `4w`、`this-week`（周一边界与周日边界）、`last-week`（自动锁定上周日 `23:59:59.999`）、`YYYY-MM-DD` 闭区间、ISO-8601、非法格式与 `since > until` 报错 `INVALID_TIME_RANGE`；跨时区注入 `tzOffsetMinutes` 100% 确定；
- [ ] **互斥分桶优先级**：
  - 本周新建并完成 → 仅入「本周完成」且带 `[本周新建]`；
  - 上周已完成、本周补充结论/附件 → 归入「本周推进」且带 `[补充更新]`，不虚增「本周完成」；
  - 本周新建 `todo` 无后续更新 → 归入「本周新增」而非「本周推进」；
  - 显式 `parked` / `discarded` 容器 → 只报容器自身，不展开继承状态的旧子节点；
  - 容器仅因 `subtreeUpdatedAt` 变化但自身未改 → 不单独入桶，仅作为子节点面包屑；
- [ ] **Part B 持续项与兼容历史节点**：
  - 持续 `blocked`（上周及更早）且本周无更新 → 稳定出现在「持续阻塞中」，附注精确天数，且不含“停滞警报”措辞；
  - 被祖先 `parked` / `discarded` 屏蔽的旧 `blocked` 节点 → 不进入「持续阻塞中」；
  - 历史三时间字段全空节点 → 正确统计入 `untrackedNodes`，Part B 中标 `无时间记录` 而不编造天数；
  - 容器汇总 `active` 不进入「当前进行中（无更新）」叶子列表；
- [ ] **`maxTokens` 裁剪与多图谱汇总**：按 `⑥ → ④ → ⑤(进行中) → ②` 顺序裁剪；无变化图谱在汇总模式不展开空段。

### 6.2 CLI / HTTP / MCP 集成测试

- [ ] `tchain activity <graph> --since 7d` 输出合法 Markdown，`--format json` 输出完整结构化 JSON，省略 `<graph>` 时汇总工作区多张图谱；
- [ ] `tchain activity --since invalid` 返回非 0 退出码与 `INVALID_TIME_RANGE`；
- [ ] MCP `get_graph_activity` 支持单图与省略 `graphId` 工作区汇总，合法返回 Markdown / JSON，非法参数返回 `isError: true`；
- [ ] HTTP `GET /api/activity` 与 `GET /api/graphs/:id/activity` 正确校验 token、Host 与 Origin。

### 6.3 Web 工作台验收

- [ ] 工作态 / 焦点态顶栏显示「周报素材」入口，汇报态自动隐藏；
- [ ] Popover 支持切换 `近 7 天 / 本周 / 上周` 与（多图时）`当前图谱 / 全部图谱`；
- [ ] 点击复制后剪贴板内容与 API 返回一致，且弹出摘要 toast 提示。
