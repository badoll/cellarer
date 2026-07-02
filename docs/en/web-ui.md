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
| `GET /api/artifacts` | Store inventory and channel tags. |
| `GET /api/agents` | Registered adapters, capabilities, and global detection status. |
| `POST /api/plan` | Distribution preview. |
| `POST /api/apply` | Execute distribution. |
| `POST /api/scan` | Scan preview only. |
| `GET /api/status` | Ledger drift status. |
| `GET /api/secrets` | Secret reference names only. |

Project scope requests must include `dir`.

## Security Behavior

- API access can be protected with a bearer token.
- Host headers are checked to reduce DNS rebinding risk.
- Web distribution always uses `secretMode: "env"`.
- Secret values are not returned through API responses.

## Current Limits

- Web scan is preview-only; writing scan results still belongs to the CLI path.
- Status exposes drift status, not a detailed diff endpoint.
- Activity history is not persisted separately from the current apply ledger.
