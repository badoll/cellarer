# local-client-api Specification

## Purpose

Define the versioned, typed, authenticated, and non-disclosing local client API shared by supported clients.

## Requirements

### Requirement: Local client routes use one versioned boundary
The server MUST expose its supported client API under `/api/v1` and MUST provide version, capability, health, readiness, and contract discovery without relying on human CLI output. After the bundled Web client migrates, the unreleased unversioned `/api/*` routes MUST be removed rather than proxied or maintained as a second implementation.

#### Scenario: Client discovers the API
- **WHEN** an authenticated local client requests API version and capabilities
- **THEN** the server returns the API schema version, implemented operation identifiers, and discoverable contract identifiers under `/api/v1`

#### Scenario: Legacy route is requested after migration
- **WHEN** a caller requests an old unversioned `/api/*` operation
- **THEN** the server returns not found without invoking Core or mutating state

### Requirement: HTTP results and errors use a stable typed contract
Every `/api/v1` operation MUST return a versioned result or error envelope with a request identifier. HTTP status mapping MAY differ from CLI exit mapping, but overlapping CLI and HTTP operations MUST preserve the same transport-neutral Core DTO semantics, stable error code, non-disclosing details, and remediation meaning.

#### Scenario: Core rejects a stale mutation
- **WHEN** an HTTP apply request reaches the same stale-plan result as the CLI operation
- **THEN** the HTTP response uses the shared stale-plan error code and evidence while mapping it to the documented conflict status

#### Scenario: Unexpected exception crosses the HTTP boundary
- **WHEN** an unexpected internal exception occurs
- **THEN** the server returns a typed internal error with a request identifier and no stack, secret value, filesystem payload, or raw exception text

### Requirement: The implemented HTTP contract is machine discoverable
The server MUST publish an OpenAPI 3.1 contract and closed JSON Schemas derived from the same versioned route registry used by the implementation. The published contract MUST describe only implemented routes, authentication modes, result envelopes, stable error codes, and request/response bodies.

#### Scenario: Client validates a request offline
- **WHEN** a client obtains the local API contract
- **THEN** it can validate the request shape and determine the possible typed results without invoking the mutation

#### Scenario: Route and contract drift
- **WHEN** an implemented route, method, or envelope no longer matches the published contract
- **THEN** contract tests fail before the change can be closed

### Requirement: HTTP mutations preserve the Core plan and transaction protocol
Planning endpoints MUST return the exact immutable, authority-sealed plan receipt required by the corresponding apply endpoint. Mutation handlers MUST consume that receipt without independently reconstructing intent and MUST preserve store revision, target precondition, ownership, secret-safety, journal, recovery, and mutation-authority checks from Core.

#### Scenario: Previewed plan is applied
- **WHEN** a client submits the unchanged current plan receipt returned by the matching planning endpoint
- **THEN** the server invokes the Core application service once and returns its typed operation receipt

#### Scenario: Concurrent clients submit mutations
- **WHEN** two local clients submit plans against the same store revision
- **THEN** Core store locking and revision checks permit at most one current commit and the other request receives a typed busy or stale result

#### Scenario: Client alters a plan
- **WHEN** a client changes any executable plan field before applying it
- **THEN** authorization fails before canonical replanning, product-state observation, or external effects

#### Scenario: Client applies a scan/import plan
- **WHEN** a client submits the unchanged scan mutation plan returned by Core planning
- **THEN** apply executes the selected redacted rules/MCP publications and fingerprint-bound skill sources without repeating discovery, selection, conflict resolution, or secret redaction

#### Scenario: A planned scan source drifts
- **WHEN** an authorized scan mutation plan refers to a skill or agent source whose safe snapshot fingerprint changed after planning
- **THEN** Core returns a typed target-precondition conflict without importing the changed source or rebuilding the plan

#### Scenario: A scan plan crosses a process restart
- **WHEN** a client submits a previously returned scan mutation plan to a replacement sidecar using the same current mutation authority epoch
- **THEN** Core can validate and apply the plan from its serializable receipt without an in-memory plan registry, process-local closure, or server-side operation queue

### Requirement: Local authentication is explicit and browser-safe
The server MUST bind only to loopback and MUST start in exactly one explicit authentication mode. Managed clients MUST use bearer material received through a protected inherited descriptor; the material MUST NOT appear in argv, URLs, ready records, logs, errors, or response bodies. The bundled Web mode MUST use a random HttpOnly, SameSite=Strict session established by a same-origin bootstrap and MUST require an allowed Origin for every mutation. Host validation and DNS-rebinding defenses MUST cover static, bootstrap, discovery, and API routes.

#### Scenario: Managed client authenticates
- **WHEN** a sidecar starts in bearer mode and a request presents the exact token in the Authorization header
- **THEN** the request proceeds without exposing the token to the Web bundle or any observable output

#### Scenario: Bundled Web client bootstraps a session
- **WHEN** the bundled SPA makes the session bootstrap request from the sidecar's exact loopback origin
- **THEN** the server creates a scoped HttpOnly session and JavaScript never observes its credential value

#### Scenario: Cross-origin mutation is attempted
- **WHEN** a browser request has a missing or unapproved Origin for a mutation
- **THEN** the server rejects it before parsing mutation input or invoking Core

#### Scenario: Authentication is misconfigured
- **WHEN** startup cannot establish the selected authentication mode
- **THEN** the sidecar fails closed instead of silently serving an unauthenticated API

### Requirement: API observables remain reference-only and non-disclosing
Every API response, error, contract example, request log, and readiness diagnostic MUST pass the existing reference-only secret and serialization boundaries. The Web composition MUST NOT regain access to a general `SecretStore` or a plaintext resolver.

#### Scenario: Core payload contains a secret canary
- **WHEN** a handler or thrown error accidentally includes a known secret value
- **THEN** the final response guard blocks or redacts the value and the canary is absent from all client-observable bytes

### Requirement: The bundled Web client uses only the versioned contract
The React client MUST access server capabilities through one typed `/api/v1` client boundary, MUST import shared contract values and types only through a browser-safe Core export, and MUST NOT duplicate Core validation, plan, ownership, error, or recovery rules. The browser-safe export MUST NOT transitively include Node built-ins, filesystem effects, credential providers, mutation engines, or unrelated Core modules. The OpenAPI metadata schema MUST remain exact with canonical Core DTOs and runtime producers; a metadata parity correction MAY tighten fields the server already always emits but MUST NOT change a route, request, operational response payload, or protocol version. Migration MUST complete before legacy route removal.

#### Scenario: Web performs a mutation journey
- **WHEN** a user previews and applies a supported operation in the bundled Web UI
- **THEN** the client sends the exact versioned request and plan receipt and renders the typed Core result without inferring success from HTTP text

#### Scenario: Production client is bundled
- **WHEN** the bundled Web client production artifact is built
- **THEN** every physical first-party Vite runtime module outside `node_modules` is scanned as an independent seed, its findings are unioned with the recursive TypeScript source/type closure, and its Core module graph contains only the explicitly browser-safe client-contract closure with no Node-only Core runtime module
- **AND** the OpenAPI `Agent.capabilityScopes` metadata requires `rules`, `mcp`, and `skills`, matching the canonical producer without changing `/api/v1` routes, requests, operational response payloads, or the protocol version

### Requirement: Local clients share one live Inventory contract
The `/api/v1` boundary SHALL expose the browser-safe Core Inventory DTO, including exact candidate IDs, states, default selection, redacted sources, related adapters, findings, managed matches, counts, and completeness. Full and targeted Inventory reads MUST invoke the same live read-only Core operation used by CLI.

#### Scenario: Web loads Inventory
- **WHEN** the authenticated bundled client requests Inventory for user sources and a current project
- **THEN** the API returns one deduplicated redacted result from Core

#### Scenario: One source fails
- **WHEN** Core returns partial Inventory with source findings
- **THEN** the API preserves successful candidates, completeness, typed findings, and remediation without converting the result into a raw exception
