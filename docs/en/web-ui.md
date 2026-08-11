# Web UI and Local Client API

[Documentation index](../README.md) | [简体中文](../zh-CN/web-ui.md)

The Web UI is a local React console over the versioned Hono client API. Both are
thin presentation layers over `@cellarer/core`; the browser never writes files
or reconstructs mutation decisions.

## Start

For the bundled browser session:

```bash
pnpm build
node packages/cli/dist/bin.js ui
```

For a managed client, pass bearer material and process ownership through
separate protected inherited descriptors:

```bash
node packages/cli/dist/bin.js --output json ui --port 0 \
  --token-fd 3 --lifetime-fd 4 3< /path/to/ui-token 4< /path/to/lifetime-pipe
```

The server binds only to `127.0.0.1`. Port `0` requests an OS-assigned port; the
versioned ready result reports the actual base URL only after the socket,
authentication, static assets, API contract, and Core composition are ready.

## Versioned Contract

Every supported operation is under `/api/v1`. `GET /api/v1/openapi.json`
returns the implemented OpenAPI 3.1 document in the normal result envelope;
`GET /api/v1/capabilities` lists the operation IDs. The bundled client negotiates
the exact API version and contract ID before ordinary requests.

| Route family | Purpose |
| --- | --- |
| `GET /api/v1/health` | Minimal unauthenticated transport liveness. |
| `GET /api/v1/version`, `/capabilities`, `/openapi.json` | Authenticated contract discovery. |
| `GET /api/v1/readiness` | Typed Store, authority, lock, and recovery blockers; a not-ready result uses HTTP 503 with a success envelope. |
| `/api/v1/resources`, `/agents`, `/collections`, `/config`, `/settings` | Read-only control-plane DTOs. |
| `/api/v1/discovery`, `/diff`, `/status`, `/verify`, `/summary`, `/activity`, `/operations` | Discovery, verification, status, and operation evidence. |
| `/api/v1/{sync,scan,import,revert}/{plan,apply}` | Exact preview/apply workflows. |
| `/api/v1/resources/*/{plan,apply}` | Resource update, rename, remove, export, and bundle-import workflows. |
| `/api/v1/profiles/*` | Profile definition, sync, verification, and uninstall workflows. |
| `GET /api/v1/recovery`, `POST /api/v1/recovery/apply` | Diagnose and apply authorized interrupted-operation recovery. |

The unversioned `/api/*` surface has been removed and returns not found before
Core interaction.

## Result and Mutation Semantics

All JSON operations return the stable `apiVersion`, `requestId`, `status`, and
`warnings` envelope with either `data` or a typed `error`. A planning endpoint
returns an authority-sealed `MutationPlan`. Its matching apply endpoint accepts
that exact immutable plan; the browser does not rescan, replan, or infer success
from HTTP text. A successful apply returns the Core operation receipt, including
the committed revision and per-action outcomes.

Project-scoped requests require an explicit project path. Profile invocations
require `workspaceRoot` when the profile scope is project; machine-local paths
are not persisted in profile definitions.

## Authentication and Ownership

Startup selects exactly one mode:

- Browser mode creates a new random session on every start. The SPA bootstraps
  it through exact same-origin Host, Origin, and Fetch Metadata checks. The
  cookie is `HttpOnly`, `SameSite=Strict`, and scoped to `/api/v1`; every
  mutation requires the exact loopback Origin.
- Managed mode accepts only `Authorization: Bearer ...`. The token is read from
  `--token-fd`; it is never accepted from argv, environment fallback, query
  strings, ready records, logs, or response bodies.

Only `/api/v1/health` is public API liveness. Static assets remain
uncredentialed so the browser can load the shell, while Host and CSP policy
still cover them. Web receives a narrow in-memory mutation authority and no
general `SecretStore` or plaintext resolver. Final `/api/v1` serialization
passes through the reference-only secret guard.

Programmatic close, lifetime-descriptor EOF, SIGINT, and SIGTERM share one
idempotent bounded shutdown path. It stops accepting requests, drains in-flight
work up to the configured limit, and leaves Core journal evidence intact if a
mutation is interrupted.
