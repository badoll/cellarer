## Why

cellarer already has a loopback Hono server and a functional Web console, but its unversioned `/api/*` routes, ad hoc error shapes, and incomplete startup/authentication contract are not a stable client boundary. With the Core safety protocol and machine CLI complete, the next dependency is a versioned local API and a predictable sidecar lifecycle that the bundled Web UI and future native clients can share without duplicating business rules.

## What Changes

- Add a synchronous `/api/v1` client API with version/capability discovery, health/readiness, shared typed result and error semantics, immutable plan receipts, revisions, and preconditions.
- Replace the current scan/import apply-time rescan with a Core-owned serializable scan mutation plan whose authority seal binds the selected redacted payloads, source fingerprints, store revision, target preconditions, and optional collection publication before HTTP apply.
- Add a managed loopback sidecar lifecycle with ephemeral-port support, one machine-readable ready record, explicit ownership/shutdown behavior, and store-scoped single-writer enforcement through the existing Core mutation protocol.
- Complete local authentication bootstrap: external clients provide bearer material through a protected inherited descriptor, never argv or URLs; the bundled same-origin Web client uses a protected HttpOnly session and origin-checked mutations.
- Publish an OpenAPI/JSON Schema contract and contract tests proving parity between HTTP DTOs, CLI protocol DTOs, and Core application results where their operations overlap.
- Migrate the current Web client to `/api/v1` before removing the old routes.
- **BREAKING**: remove the unreleased unversioned `/api/*` routes after the bundled Web client has migrated; no compatibility proxy or duplicate route implementation remains.
- Use the current macOS development target with supported Node 20 as the Phase 4 installed-artifact closure evidence. Ubuntu and Windows execution remain deferred release-hardening evidence and do not block this change.
- Keep requests synchronous. Do not add SSE, WebSocket, remote access, accounts, or a general approval broker without evidence from a real long-running operation.

## Capabilities

### New Capabilities

- `local-client-api`: Versioned loopback HTTP discovery, health, typed request/result/error contracts, safe authentication, and parity with Core application semantics.
- `managed-sidecar-lifecycle`: Deterministic sidecar startup, readiness publication, ownership, shutdown, crash behavior, and installed-artifact operation for local clients.

### Modified Capabilities

None. Existing transaction, CLI protocol, control-plane, and installable-artifact requirements remain prerequisites and are consumed without weakening their contracts.

## Impact

- `packages/web/src/app.ts`, `server.ts`, `security.ts`, exported Web types, and API contract tests.
- `packages/web/client/**` API transport and every current call site that uses `/api/*`.
- `packages/cli/src/commands/ui.ts` and CLI protocol schemas for ready/lifecycle presentation.
- Shared Core DTO/error mapping where an existing application result is not yet directly serializable by both CLI and Web, including the scan/import plan/apply boundary.
- Installed-artifact readiness tests on the current macOS target and synchronized English/Simplified Chinese Web, CLI, architecture, and security documentation. Existing Ubuntu/Windows CI configuration remains future evidence rather than a Phase 4 closure gate.
- No new production dependency, remote listener, credential-store exposure, publication, deployment, or native macOS shell is introduced by this change.
