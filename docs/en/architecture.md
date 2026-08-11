# Architecture

[Documentation index](../README.md) | [简体中文](../zh-CN/architecture.md)

cellarer is a TypeScript monorepo with a strict core-first boundary.

## Packages

| Package | Responsibility |
| --- | --- |
| `@cellarer/core` | Store, adapters, planning, applying, scanning, status, revert, secret handling. |
| `@cellarer/cli` | Command-line parsing and presentation. |
| `@cellarer/web` | Local Hono API and React Web console. |

CLI and Web should not implement business logic. They parse input, call core,
and present results.

## Versioned Local Client and Sidecar

`@cellarer/web` exposes only `/api/v1`. One route registry owns operation IDs,
methods, paths, authentication requirements, closed request/response schemas,
and HTTP mappings; the OpenAPI 3.1 document and Hono surface are checked against
that registry. CLI and HTTP share transport-neutral Core DTOs and error codes.

The sidecar selects managed bearer or bundled browser-session authentication at
startup, binds loopback, and publishes a ready DTO only after the actual socket
and composition are ready. Programmatic close, lifetime EOF, SIGINT, and SIGTERM
share one bounded shutdown path. Sidecars do not add an in-memory mutation
queue: all processes converge through Core revision, authority, cross-process
lock, journal, and recovery rules.

## Core Boundaries

Core receives side effects through `Env`:

- file system
- home directory
- current working directory
- platform
- environment variables
- clock
- optional secret store

This keeps core behavior testable and avoids reading `process`, `os`, or
`node:fs` directly from business logic.

## Distribution Flow

```text
library resources
  -> select agents, scope, collections, capabilities
  -> load adapters and config
  -> render rules, MCP, and skills actions
  -> run secret guards
  -> preview plan or apply writes
  -> update state.json
```

Rules and MCP are rendered as content writes. Skills are linked or copied.

## Scan Flow

```text
agent files
  -> adapter paths and codecs
  -> canonical resources
  -> secret redaction
  -> conflict policy
  -> store writes
```

The local client boundary uses `planScanMutation` to return a serializable,
authority-sealed `MutationPlan`. `applyScanMutationPlan` consumes that exact
plan, rechecks bound source fingerprints, and never rescans or rebuilds
selection at apply time.

## Adapters

Adapters expose paths, capabilities, detection, and codecs for each agent.
Packaged built-ins and user `adapters` entries are resolved into the shared
`AgentSpec` shape, so recurring new layouts do not require engine branches.

## MCP Model

MCP servers are normalized into a canonical model:

- `stdio`
- `remote`
- `custom`

Codecs handle JSON/TOML formats and field dialects such as `command[]`,
`environment`, or `serverUrl`.

## Safety Invariants

- Business logic lives in core.
- Effects go through `Env`.
- Distribution is plan/apply separated.
- New agents go through adapters.
- Applies are idempotent and ledger-backed.
- Plaintext secrets must not be written to the store or generated outputs.
