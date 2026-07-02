# AGENTS.md — cellarer Engineering Guide

This file is the project-level guide for AI coding agents working in this
repository. Product documentation starts at [docs/README.md](docs/README.md);
stable architecture and concepts live under `docs/en/` and `docs/zh-CN/`.

## Project

cellarer is a local-first manager for AI agent `skills`, MCP server
configuration, and rules. It is a TypeScript monorepo:

- `@cellarer/core`: all business logic.
- `@cellarer/cli`: command-line parsing and presentation.
- `@cellarer/web`: local Hono API and React Web console.

## Architecture Invariants

1. **Core first**: put business logic in `@cellarer/core`. CLI and Web should be
   thin shells that parse input and present output.
2. **Effects through `Env`**: core file system, home, cwd, platform, environment,
   clock, and secret-store access must come from `packages/core/src/env.ts`.
   Do not read `process`, `os`, or `node:fs` directly from core business logic.
3. **Plan/apply split**: distribution first produces a `DistributePlan`; dry-run
   returns the plan only; apply executes the plan and records results.
4. **Agents through adapters**: add agent support via `AgentAdapter` or
   declarative adapter config. Do not scatter agent-id branches through engines.
5. **Idempotent and revertible**: repeated apply should converge. Every write
   that matters to revert/status must be represented in `state.json`.
6. **No plaintext secrets**: store artifacts and generated outputs must not
   contain plaintext secrets. Use `${ENV_VAR}` or `${CELLARER_SECRET:name}`
   references, vault, or keychain-backed resolution. MCP/secret changes need
   tests that assert plaintext values are not written.

## Development Workflow

- Prefer TDD for behavior changes. Use Vitest, temporary directories, and
  injected/fake `Env` objects for file-system logic.
- Use the repository tooling:
  - `pnpm build`
  - `pnpm test`
  - `pnpm lint`
  - `pnpm typecheck`
- Run the narrowest relevant check while iterating, then run the full relevant
  gate before claiming completion.
- Preserve unrelated user changes. The worktree may contain in-progress Web UI
  or documentation edits from another task.

## Code Style

- ESM + NodeNext: relative imports in TypeScript source use `.js` suffixes.
- Use `import type` for type-only imports.
- Names for functions, variables, and types are English.
- Comments may be Chinese when explaining why a non-obvious choice exists.
  Avoid comments that merely narrate what the next line already says.

## Documentation Boundaries

Public documentation:

- `README.md`
- `README.zh-CN.md`
- `docs/README.md`
- `docs/en/**`
- `docs/zh-CN/**`
- `examples/adapters/*.example.toml`

Local development notes:

- `docs/dev/**`

Use `docs/dev/**` for drafts, implementation journals, review material,
migration backups, and other local process records. It is ignored by Git and
must not be linked from public documentation.

When migrating or rewriting docs, first classify the content:

- user guide
- CLI/API reference
- concepts or architecture
- security
- maintainer procedure
- local process record

Do not put internal comparisons, one-time implementation status, review logs, or
temporary task lists into public docs. Extract stable conclusions and write them
as product, architecture, security, or maintainer documentation instead.

## Documentation Change Requirements

- Keep the English and Simplified Chinese public docs in sync.
- CLI examples must match the current implementation. Check source and package
  metadata before documenting commands, package names, release state, or flags.
- If a command is future-facing or release-dependent, label it as such instead
  of presenting it as currently available.
- Public docs should not link to `docs/dev/**` or to deleted legacy paths.
