# Getting Started

[Documentation index](../README.md) | [简体中文](../zh-CN/getting-started.md)

cellarer is currently used from source. The packages are still `private: true`
with version `0.0.0`.

## Prerequisites

- Node.js `>=20.19`
- pnpm `10.12.1`

## Build the CLI

```bash
pnpm install
pnpm build
node packages/cli/dist/bin.js --help
```

The examples below use the built CLI path. After a public package is released,
the same command surface is expected to be available through the `cellarer` bin.

## Initialize the Store

```bash
node packages/cli/dist/bin.js init
```

By default this creates or reuses the store under `~/.cellarer`. Set
`CELLARER_HOME` when you want an isolated store for testing.

## Add Local Artifacts

```bash
node packages/cli/dist/bin.js add ./my-rules.md
node packages/cli/dist/bin.js add ./context7.json
node packages/cli/dist/bin.js add ./my-skill/
```

Current source support is intentionally local:

- `.md` files are imported as rules.
- `.json` files are imported as MCP server artifacts.
- directories are imported as skills.
- URL and `owner/repo` sources return a clear not-implemented message.

## List Stored Artifacts

```bash
node packages/cli/dist/bin.js ls
node packages/cli/dist/bin.js ls --channel common
```

## Preview and Apply

Always preview first:

```bash
node packages/cli/dist/bin.js apply --dry-run --agent claude-code,codex --rules --mcp --skills
```

Apply after the plan looks right:

```bash
node packages/cli/dist/bin.js apply --agent claude-code,codex --rules --mcp --skills
```

Use `--dir <path>` for project scope. Without `--dir`, cellarer writes to each
agent's global location.

## Scan Existing Agent Configuration

```bash
node packages/cli/dist/bin.js scan --agent codex --dry-run --json
node packages/cli/dist/bin.js scan --agent codex --into-channel common
```

`scan` accepts one agent at a time. The plan omits secret values and only returns
secret reference names.

## Check and Revert

```bash
node packages/cli/dist/bin.js status
node packages/cli/dist/bin.js revert --agent claude-code,codex
```

`revert` uses the ledger written by `apply`. To revert everything without an
agent or directory selector, pass `--all` explicitly.

## Start the Web UI

```bash
node packages/cli/dist/bin.js ui
node packages/cli/dist/bin.js ui --port 4317 --token local-token
```

The server listens on `127.0.0.1` only.
