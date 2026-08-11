## 1. Shared Client Contracts and Route Registry

- [x] 1.1 Add failing golden tests for the versioned HTTP result/error envelope, request IDs, stable Core error parity, closed schemas, and unexpected-error redaction
- [x] 1.2 Extract or add the minimal transport-neutral public DTO and error contracts in Core so CLI and Web can reuse semantics without either presentation package importing the other
- [x] 1.3 Implement a typed `/api/v1` route registry with operation IDs, methods, paths, authentication requirements, input/output schemas, and HTTP status mappings
- [x] 1.4 Generate or assemble OpenAPI 3.1 and JSON Schema discovery from the registry and add drift tests against the actual Hono route surface

## 2. Versioned Discovery, Health, and Read Control Plane

- [x] 2.1 Add failing API contract tests for version, capabilities, contract discovery, minimal liveness, authenticated readiness, and representative read-only control-plane operations
- [x] 2.2 Implement `/api/v1` discovery, health, and readiness with transport liveness separated from typed store, authority, lock, and recovery blockers
- [x] 2.3 Migrate resource, agent, collection, configuration, diff, verification, summary, activity, and operation reads to versioned handlers backed directly by Core application services
- [x] 2.4 Prove overlapping CLI and HTTP read operations preserve the same Core DTO fields, warnings, error codes, redaction, and remediation semantics

## 3. Explicit Local Authentication and Observable Safety

- [x] 3.1 Add adversarial tests for bearer leakage, argv/URL/stdout exposure, missing authentication, DNS rebinding, hostile Origin, CSRF, session fixation, cookie scope, and secret canaries in responses and errors
- [x] 3.2 Implement mutually exclusive managed-bearer and bundled-browser-session composition with protected descriptor input, random per-start credentials, exact loopback Host/Origin checks, Fetch Metadata validation, and HttpOnly SameSite=Strict cookies
- [x] 3.3 Apply the explicit route policy consistently: Host/CSP guards cover the uncredentialed static shell, bootstrap, discovery, and API routes; bootstrap requires exact same-origin browser metadata; discovery, reads, and mutations require the selected authentication mode; and only minimal liveness remains unauthenticated API surface
- [x] 3.4 Remove query-token and silent unauthenticated fallback behavior, retain least-privilege Web composition without general `SecretStore`, and enforce the final serialized-response guard across `/api/v1`

## 4. Versioned Planning and Mutation Control Plane

- [x] 4.1 Add failing HTTP journey tests for plan/apply, stale revision, altered seal, target drift, concurrent clients, typed busy/recovery results, and zero-effect unauthorized rejection
- [x] 4.2 Add Core `planScanMutation`/`applyScanMutationPlan` contracts whose serializable sealed plan binds selected reference-only publications, source fingerprints, target preconditions, and optional collection updates without apply-time rescanning
- [x] 4.3 Migrate agent, adapter, settings, collection, import/scan, apply, revert, recovery, resource lifecycle, and sync-profile mutations to versioned handlers and exact Core inputs
- [x] 4.4 Make every apply handler consume the exact authority-sealed immutable plan returned by its matching planning handler without transport-layer replanning or duplicated validation
- [x] 4.5 Prove overlapping CLI and HTTP mutations return equivalent Core plan/operation receipts and preserve lock, journal, ownership, reference-only secret, and recovery behavior

## 5. Managed Sidecar Lifecycle

- [x] 5.1 Add failing cross-platform tests for port `0`, delayed ready publication, startup failure, schema-valid machine output, redacted stderr, lifetime-descriptor EOF, SIGINT/SIGTERM, repeated close, bounded drain, and active-mutation shutdown
- [x] 5.2 Refactor server startup to await the actual bound loopback address and return a versioned ready DTO plus an idempotent asynchronous close handle
- [x] 5.3 Implement one shutdown state machine shared by programmatic close, lifetime ownership, and signals, preserving Core journal evidence when bounded drain cannot finish
- [x] 5.4 Update `cellarer ui` human and machine presentation so managed stdout contains exactly one ready result and no token, banner, progress text, or later incidental output
- [x] 5.5 Add multi-process tests proving two sidecars targeting one store still serialize only through the existing cross-process Core mutation protocol

## 6. Bundled Web Migration and Legacy Removal

- [x] 6.1 Add typed client tests for authentication bootstrap, discovery negotiation, error rendering, stale-plan handling, and preview-to-apply receipt identity
- [x] 6.2 Replace the React transport with one typed `/api/v1` client boundary and migrate all read and mutation call sites without moving business-state inference into React
- [x] 6.3 Add end-to-end Web journeys covering read inventory, preview/apply/verify/revert, recovery blockers, authentication expiry, and server restart
- [x] 6.4 Delete every unversioned `/api/*` handler, old request shape, query-token path, and compatibility branch, then assert legacy requests return not found before Core interaction

## 7. Installed Artifact and Documentation Gates

- [x] 7.1 Extend the installed-artifact gate to launch on port `0`, validate the ready record and OpenAPI contract, authenticate in both supported modes, serve bundled assets, close the lifetime channel, and observe a clean exit from an unrelated cwd
- [x] 7.2 Run the sidecar artifact lifecycle on the current Phase 4 macOS target with supported Node 20, isolated home/store paths, and no access to real agent files, credential stores, or product remote services; defer Ubuntu/Windows execution without claiming those targets were verified
  - macOS slice evidence (2026-08-10): `macOS 26.3.1 (25D771280a), arm64, Node 20.19.1`; `npm_config_cache=/tmp/cellarer-node20-cache npm exec --yes --package=node@20.19.1 -- pnpm release:readiness` passed with isolated `HOME`, `CELLARER_HOME`, `PNPM_HOME`, and empty `NODE_PATH`. Packed dependency installation used the configured pnpm registry; the installed CLI/sidecar journey itself stayed loopback-only and invoked no product remote service. Generated `artifacts/release-readiness/readiness.json` reported `darwin`, Node `20.19.1`, and `status: passed` (SHA-256 `dbb0752d138c01b715f1fc214628936fee090f614085035d3bc4f71b55b4f0ff`).
  - Deferred by explicit scope decision: `ubuntu-latest` and `windows-latest` are not Phase 4 closure gates and remain unverified until a later release-hardening run.
- [x] 7.3 Synchronize English and Simplified Chinese Web, CLI, architecture, security, and maintainer documentation for `/api/v1`, authentication modes, readiness, ownership, shutdown, and legacy-route removal

## 8. Phase 4 Closure Verification

- [x] 8.1 Run the complete HTTP contract, authentication, CSRF/DNS-rebinding, secret-canary, mutation, concurrency, recovery, lifecycle, Web journey, and installed-artifact regression matrix
- [x] 8.2 Run full test, typecheck, lint, build, release-readiness, strict OpenSpec validation, and diff checks without publishing, deploying, or modifying remote state
- [x] 8.3 Obtain a fresh independent review of Core/CLI/Web contract parity, authentication authority, lifecycle ownership, legacy removal, and roadmap scope; resolve all closure blockers before sync or archive
