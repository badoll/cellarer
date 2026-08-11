## Context

The current `@cellarer/web` package already composes Core behind Hono, binds to `127.0.0.1`, validates Host headers, applies CSP, optionally checks a bearer token, and serves the bundled React application. Its routes are nevertheless an internal unversioned `/api/*` surface, most unexpected errors are flattened to HTTP 400, the token-enabled page path expects query-string material, and `startServer()` returns only `{ port, close }` before the caller has a durable ready/lifetime contract.

Phase 0–3 established target ownership, reference-only secret safety, store-scoped mutation authority, cross-process locking and recovery, shared Core control-plane DTOs, a versioned CLI protocol, and installable artifacts. Phase 4 must expose those semantics to local clients without building a second business-logic or transaction layer. The immediate consumers are the bundled React client and automated local clients; a future macOS shell is a contract consumer, not part of this change.

## Goals / Non-Goals

**Goals:**

- Provide a versioned, discoverable, typed, loopback-only `/api/v1` boundary.
- Preserve exact Core result, error, plan receipt, authority, revision, ownership, secret, and recovery semantics across CLI and HTTP.
- Make startup, readiness, authentication, ownership, and shutdown predictable for both the human `cellarer ui` flow and a spawned managed sidecar.
- Migrate the bundled Web client completely and then remove the unreleased unversioned routes.
- Verify the lifecycle from packed artifacts on the current macOS development target using supported Node 20. Defer Ubuntu/Windows execution to later release hardening without treating either platform as verified in this change.

**Non-Goals:**

- Remote access, user accounts, cloud synchronization, a background daemon, or multiple remote users.
- SSE, WebSocket, JSON-RPC, asynchronous operation brokers, or cancellation until a measured long-running operation requires them.
- A native macOS shell, team approval flow, plugin runtime, or new resource domain.
- A compatibility proxy for old `/api/*` routes or duplicated legacy request shapes.

## Decisions

### 1. Deliver one vertical Phase 4 change

The implementation order is shared transport contracts, versioned routes, authentication, managed lifecycle, Web migration, and installed-artifact verification. This keeps one end-to-end acceptance boundary while retaining small top-level task groups.

Splitting API versioning and lifecycle into separate changes was considered, but it would leave either an API without a safe launch contract or a lifecycle that advertises an unstable API. Migrating the Web client first was rejected because it would deepen reliance on the current ad hoc routes.

### 2. Keep Core DTOs transport-neutral and map transports at the edge

Core remains the owner of application inputs, results, stable domain errors, plan receipts, and operation evidence. A small transport-neutral public envelope/error schema will be shared where CLI-owned protocol definitions currently prevent reuse. HTTP maps domain error codes to documented statuses; CLI maps the same codes to exit classes. Neither transport parses prose or changes Core meaning.

The Web package will own a versioned route registry containing method, path, operation ID, authentication requirement, input schema, and result schema. Hono handlers and the published OpenAPI 3.1 document derive from or are checked against that registry. This avoids a new production dependency and prevents an independently maintained OpenAPI file from drifting.

### 3. Use synchronous `/api/v1` request/response

The initial API exposes version, capabilities, contract, liveness, readiness, and the current control-plane operations needed by the bundled Web UI. Planning returns the exact authority-sealed plan accepted by apply. Apply never reconstructs intent and never bypasses Core locking or journaling.

Operation IDs in existing Core receipts remain observable, but there is no new server-side operation queue. SSE, cancellation, and asynchronous polling are deferred until real duration and interruption evidence justifies them.

### 4. Make scan/import a Core-owned exact mutation plan

The existing `scanPlan()` result is a presentation preview, while `applyScan()` currently scans the agent source again and closes over process-local snapshots and execute functions. That contract cannot be exposed as the exact immutable HTTP plan required by this change. Core will therefore add a separate executable boundary:

- `planScanMutation()` returns the presentation `ScanPlan` plus a public `MutationPlan` whose normalized inputs and actions bind the selected agent, scope, capabilities, conflict policy, optional collection, source descriptors and fingerprints, redacted rules/MCP payloads, skill source fingerprints, target preconditions, and self-contained Store publications.
- `applyScanMutationPlan()` first validates the closed runtime shape, digest, and authority seal without reading agent sources, Store state, or providers. Only an authorized plan may acquire the current authority lease, re-capture an explicitly bound skill or source snapshot, compare its fingerprint, and execute the already selected actions through the existing store-scoped mutation protocol.
- Rules and MCP actions carry the exact guarded reference-only publication bytes in the sealed plan. Skill actions carry an authorized source path and fingerprint; apply may re-capture bytes only from that path and must reject a fingerprint mismatch rather than re-running discovery, selection, conflict resolution, or secret redaction.
- The plan is sufficient across HTTP requests and process restarts while the same authority epoch remains current. No closure, in-memory plan registry, temporary artifact, plaintext secret value, or server-side operation queue is required for apply.

Scan plan creation keeps the existing safe-recursive snapshot and plaintext/structured-secret budgets. The HTTP boundary also enforces the shared request-body budget before parsing. Plans that exceed that bounded public contract fail during planning rather than returning a partially executable receipt. Embedding arbitrary skill trees in the plan was rejected because it would duplicate snapshot bytes in client memory and enlarge the disclosure surface. Re-running `applyScan()` from the original `ScanOptions` was rejected because it would authorize intent but execute newly observed state.

### 5. Separate managed bearer mode from bundled browser-session mode

Startup selects exactly one authentication mode:

- Managed clients pass a random bearer token through a protected inherited descriptor. The sidecar accepts Authorization headers and never exposes the token through argv, environment fallback, URL, stdout, ready records, logs, or HTTP payloads.
- Human `cellarer ui` uses a random HttpOnly, SameSite=Strict browser session. The uncredentialed static shell calls a same-origin bootstrap endpoint; Host, exact Origin, Fetch Metadata, and CSP checks prevent a hostile website from bootstrapping or using the session. Mutations require an approved exact Origin.

The current query-token page gate and optional unauthenticated API fallback are removed. A single bearer stored in browser JavaScript was rejected because it would expose the credential to the DOM runtime and storage. Letting browser bootstrap coexist with bearer mode was rejected because it would bypass the managed client's explicit credential boundary.

### 6. Distinguish transport liveness, operational readiness, and the ready record

`GET /api/v1/health` is a minimal unauthenticated liveness response containing no store information. Authenticated `GET /api/v1/readiness` reports typed initialization, authority, lock, and recovery blockers. The process emits its ready record only after binding and composition succeed; the record promises that the transport and contracts are available, not that every mutation is currently permissible.

The ready DTO is versioned and includes the actual loopback base URL, PID, API version, contract ID, authentication mode, and lifecycle protocol. It excludes credentials, absolute store paths, environment contents, and secret-provider details.

### 7. Model ownership with a lifetime descriptor and one shutdown path

Managed callers may provide an inherited lifetime descriptor. EOF, programmatic `close()`, SIGINT, and SIGTERM all enter one idempotent shutdown state machine: stop accepting requests, allow a bounded drain, close the listener, and exit. If a mutation cannot finish within the bound, its Core journal is preserved for authorized recovery; the sidecar never guesses or cleans transaction evidence.

An inherited pipe is preferred to parent-PID polling because PID reuse and platform process-tree differences make polling unreliable. No pidfile, detach mode, auto-restart, or background daemon is introduced.

### 8. Migrate then delete the legacy route surface

The typed Web client moves endpoint groups to `/api/v1` while contract and journey tests remain green. Once every bundled call site is migrated, all old `/api/*` handlers and query-token logic are deleted in the same change. Because cellarer is unreleased, no compatibility alias or deprecation window is retained.

## Risks / Trade-offs

- [Browser session bootstrap is a security-sensitive flow] → Require exact loopback Host and Origin, Fetch Metadata checks, HttpOnly SameSite=Strict cookies, mutation Origin enforcement, session rotation on restart, and adversarial DNS-rebinding/CSRF tests.
- [A large route migration can hide semantic drift] → Migrate by operation group, validate every response against the route registry, and compare overlapping CLI/HTTP outputs to the same Core fixtures.
- [A scan source can drift after preview] → Bind the exact source descriptor and fingerprint in the authority-sealed plan, verify authorization before source observation, and return a typed target-precondition conflict instead of rescanning or rebuilding intent.
- [A scan plan can become an unbounded transport payload] → Keep skill bytes at the authorized source, include only guarded rules/MCP publication bytes, retain recursive-snapshot budgets, and reject request or response bodies outside the shared API budget.
- [One ready record can be mistaken for store readiness] → Name and document transport versus operational readiness separately and include no boolean that conflates them.
- [Bounded shutdown can interrupt a mutation] → Reuse durable Core journals and test interruption at listener, action, publication, and recovery boundaries.
- [OpenAPI generation without a library requires discipline] → Keep one closed route/schema registry and fail tests when Hono routes, schemas, or published operations differ.
- [Cookie behavior differs across browsers and loopback hostnames] → Standardize the browser origin on `http://127.0.0.1:<port>`, test the supported browser path, and keep managed bearer mode independent.
- [macOS-only Phase 4 artifact evidence does not prove other operating systems] → Keep the existing cross-platform implementation and CI definitions, record Ubuntu/Windows as explicitly unverified, and require fresh evidence before making later release-readiness claims for those targets.

## Migration Plan

1. Add shared envelope/error contracts and golden parity fixtures without changing current routes.
2. Add the `/api/v1` registry, discovery, health/readiness, and versioned handlers beside the current internal routes during development.
3. Add explicit bearer and browser-session composition plus adversarial security tests; remove query-token behavior.
4. Add port-0 readiness, managed output, lifetime ownership, and idempotent shutdown.
5. Add the Core scan mutation plan/apply boundary and migrate HTTP mutation families to exact authorized plans.
6. Migrate the bundled typed Web client group by group to `/api/v1`.
7. Delete old `/api/*` handlers and assert they cannot invoke Core.
8. Update installed-artifact, public documentation, and full repository gates; close Phase 4 with macOS + Node 20 artifact evidence and defer Ubuntu/Windows execution.

Rollback before archival is a Git/OpenSpec revert to the prior unreleased server. No persisted store migration is introduced; Core state, journals, ownership, and mutation authority formats remain unchanged.

## Open Questions

None required before implementation. The scan plan is explicitly source-referential for skills and self-contained for guarded rules/MCP publications; cookie names, shared body-budget constants, shutdown timeout constants, and exact module file boundaries are implementation details constrained by the requirements and existing project conventions.
