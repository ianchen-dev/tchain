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
