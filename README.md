# tchain — ThoughtChain Decision Workbench

Local-first, AI-native recursive decision & thought-chain workbench.

## Packages

- `packages/core`: Pure functions, zero IO (`schema`, `derive`, `validate`, `canonicalize`, `apply`, `diff`, `focus`, `compileContext`).
- `packages/server`: CLI (`tchain`), storage layer, and (Phase 1+) local HTTP/SSE workbench server & MCP stdio server.
- `packages/web`: React + React Flow + ELK.js desktop workbench (Phase 1).
- `fixtures/`: Reference `.tgraph.json` test fixtures (including 0 号样板 `announcement-pipeline.tgraph.json`).

## Phase 0 Quick Start

```bash
pnpm install
pnpm build
pnpm test

# Run CLI against a workspace
pnpm --filter tchain exec node dist/cli.js init <dir>
pnpm --filter tchain exec node dist/cli.js validate [graph]
pnpm --filter tchain exec node dist/cli.js fmt [graph]
pnpm --filter tchain exec node dist/cli.js context <graph> --node <id>
```

## Shared Web + MCP service

Opening a graph defaults to collapsing completed, parked, and discarded containers
in all three views, including containers whose child statuses roll up to `done`,
`parked`, or `discarded`. The summary card stays visible when the view's status
filters allow it; leaf nodes stay visible under the same filters. Expand a card individually to
inspect its children. Manual expansion is retained when switching views during
the current graph session. Report view also keeps its usual detail-container
collapse defaults.

The top-bar **全部展开** button expands every container in the current view,
returns from a drilled subgraph to the whole graph, reveals parked/discarded
branches, disables focus hiding, and fits the canvas. Other views keep their
own collapse state. Report view retains its node-type filtering rules.

```powershell
node C:/aProject/tchain/packages/server/dist/cli.js serve "C:/your/workspace" --port 4377
```

`serve` starts the Web workbench and a Streamable HTTP MCP endpoint at
`http://127.0.0.1:4377/mcp` in the **same process**. The output includes the actual
port, browser URL, MCP URL, PID, token file, and `reused` flag. Repeating `serve`
for the same canonical directory verifies the existing service's identity and
returns its address, even when a different port was requested. The second
command exits without stopping the original service. Concurrent starts are
serialized with a workspace startup lock; dead process records are replaced.
A live but unhealthy service causes an error instead of starting a duplicate.

Each workspace has its own service. Point Codex, Cursor, and other clients at
the same workspace URL to share it. Tool calls are stateless and isolated per
request; connecting, refreshing, and disconnecting clients do not start more
service processes. The five tools and Patch review workflow are identical to
stdio. A parent workspace does not recursively include child workspaces.

The token is saved in `<workspace>/.thoughtchain/.server-token`, remains stable
across restarts, and is required for HTTP requests. Runtime files are ignored by
Git. Copy the token locally into the clients' Authorization headers; do not
commit these client credentials. For predictable URLs, restart with the same
`--port` and use the actual port printed at startup if it was occupied.

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.tchain_project]
url = "http://127.0.0.1:4377/mcp"
http_headers = { Authorization = "Bearer <contents-of-.server-token>" }
```

Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "tchain_project": {
      "url": "http://127.0.0.1:4377/mcp",
      "headers": { "Authorization": "Bearer <contents-of-.server-token>" }
    }
  }
}
```

Reload MCP connections after changing client configuration. Start the workspace
service before connecting; URL configurations do not launch it automatically.
Servers started by older versions lack the instance record and HTTP MCP endpoint;
stop those servers once before migrating to this version.

### Optional stdio compatibility

`tchain mcp <workspace>` still starts a private stdio subprocess for temporary
use and clients requiring stdio. The transport is selected explicitly by client
configuration: `command`/`args` selects stdio, while `url` selects HTTP. Retaining
the CLI command does not make a client choose it automatically. Configure only
the HTTP entry for each workspace in normal use; configuring both transports
exposes duplicate tool sets and launches additional stdio subprocesses.
