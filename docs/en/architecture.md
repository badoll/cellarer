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
store artifacts
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
  -> canonical artifacts
  -> secret redaction
  -> conflict policy
  -> store writes
```

`scanPlan` is read-only. `applyScan` writes to the store.

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
