# managed-sidecar-lifecycle Specification

## Purpose

Define deterministic startup, authenticated readiness, ownership, shutdown, and installed-artifact behavior for the managed local sidecar.

## Requirements

### Requirement: Sidecar startup publishes deterministic readiness
The sidecar MUST support an OS-assigned loopback port and MUST publish readiness only after the socket is bound, authentication is established, static assets and API contracts are available, and Core composition has completed. The versioned ready record MUST identify the actual loopback base URL, process, API version, contract identifier, authentication mode, and lifecycle protocol without exposing credentials or an absolute store path.

#### Scenario: Parent requests an ephemeral port
- **WHEN** a client starts the sidecar with port `0`
- **THEN** the ready record reports the actual bound loopback port after the server can answer health requests

#### Scenario: Startup dependency fails
- **WHEN** authentication, Core composition, binding, or required assets fail
- **THEN** no success ready record is emitted and the process exits with a typed non-disclosing failure

### Requirement: Managed output is parseable and secret-free
In machine mode the sidecar command MUST emit exactly one versioned ready result to stdout and MUST emit no banners, progress text, access tokens, or incidental logs there while running. Diagnostics MUST use stderr and MUST remain redacted. Human mode MAY render the same ready DTO as text without changing lifecycle semantics.

#### Scenario: Native client launches the process
- **WHEN** a client reads the managed process stdout
- **THEN** the first complete record is the schema-valid ready result and no later incidental stdout corrupts the channel

### Requirement: Sidecar lifetime has an explicit owner
The sidecar MUST expose an idempotent programmatic close handle and MUST support managed ownership through an inherited lifetime descriptor whose EOF triggers shutdown. SIGINT and SIGTERM MUST use the same bounded shutdown path. Shutdown MUST stop accepting new requests, allow bounded in-flight completion, release server resources, and rely on Core journals for any interrupted mutation rather than deleting recovery evidence.

#### Scenario: Parent process exits
- **WHEN** the inherited lifetime channel closes unexpectedly
- **THEN** the sidecar begins bounded graceful shutdown without remaining as an orphan daemon

#### Scenario: Close is requested twice
- **WHEN** two lifecycle signals request shutdown
- **THEN** one idempotent shutdown completes without double-closing resources or corrupting state

#### Scenario: Mutation is active during shutdown
- **WHEN** shutdown reaches its bounded drain limit while a mutation is active
- **THEN** the process preserves the durable journal and the next authorized process follows normal recovery semantics

### Requirement: Transport health and store readiness are distinct
The sidecar MUST expose a minimal unauthenticated liveness response that reveals no store details and an authenticated readiness response that reports typed operational blockers such as initialization, mutation-authority, lock, or manual-recovery state. A bound socket MUST NOT by itself imply mutation readiness.

#### Scenario: Store requires manual recovery
- **WHEN** the server is alive but Core reports an unprovable interrupted operation
- **THEN** liveness succeeds while authenticated readiness reports a typed not-ready recovery blocker

### Requirement: Sidecar clients cannot bypass store serialization
All sidecar mutation requests MUST use the existing store-scoped Core mutation protocol. The sidecar MUST NOT introduce an in-memory lock as a substitute for the cross-process lock, and multiple sidecar processes targeting one store MUST still converge through Core revision, authority, journal, and recovery rules.

#### Scenario: Two sidecars target one store
- **WHEN** separate sidecar processes attempt concurrent mutations
- **THEN** the cross-process Core protocol permits at most one current commit and neither process can bypass the store lock

### Requirement: Managed sidecar behavior works from installed artifacts
The packed CLI and Web packages MUST support sidecar startup, readiness, authentication, API contract discovery, static assets, and shutdown from an unrelated working directory on every documented supported Node and operating-system combination. Tests MUST use isolated home and store paths and MUST NOT access real agent configuration or credential stores.

#### Scenario: Installed artifact lifecycle smoke test
- **WHEN** the packed release set is installed in a clean temporary project on a documented supported runtime
- **THEN** a test launches on port `0`, validates the ready record and API contract, authenticates, serves the SPA, closes the lifetime channel, and observes a clean exit
