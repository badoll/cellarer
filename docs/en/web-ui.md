# Web UI

[Documentation index](../README.md) | [简体中文](../zh-CN/web-ui.md)

The Web UI is a local console for inspecting and operating the cellarer store.
It is a thin shell over `@cellarer/core`.

## Start

```bash
pnpm build
node packages/cli/dist/bin.js ui
node packages/cli/dist/bin.js ui --port 4317 --token local-token
```

The server listens on `127.0.0.1` only.

## Runtime Shape

```text
React SPA -> Hono API -> @cellarer/web -> @cellarer/core -> Env -> local files
```

The browser does not write files directly. All file operations go through core.

## API Surface

| Route | Purpose |
| --- | --- |
| `GET /api/resources` | Resource catalog, state counts, collections, and sync targets. |
| `GET /api/resources/:kind` | Resource catalog filtered to `skills`, `mcp`, or `rules`. |
| `GET /api/discovery` | Existing agent files that can be imported. |
| `POST /api/import/plan` | Import preview. |
| `POST /api/import/apply` | Import selected previewed resources. |
| `POST /api/sync/plan` | Sync preview. |
| `POST /api/sync/apply` | Sync previewed resources to agents. |
| `GET /api/agents` | Registered adapters, enabled state, capabilities, and global detection status. |
| `GET /api/settings` | Store defaults, collections, adapter ids, and secret references. |
| `GET /api/status` | Ledger drift status. |
| `GET /api/secrets` | Secret reference names only. |

Project scope requests must include `dir`.

## Security Behavior

- API access can be protected with a bearer token.
- Host headers are checked to reduce DNS rebinding risk.
- Web distribution always uses `secretMode: "env"`.
- Secret values are not returned through API responses.

## Current Limits

- Import and sync flows are preview-first in the UI.
- Project-level sync requires an explicit project path.
- Secret values are never shown; only reference names are displayed.
