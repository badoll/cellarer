## Context

The existing CLI exposes initialization, add, agent listing, resource listing, apply, scan, revert, status, secrets, doctor, and UI startup. Core/Web additionally model resource catalogs, discovery summaries, settings, activity, diff, dashboard data, custom adapters, and exact multi-dimensional selections. Duplicating Web route behavior in CLI would violate Core-first architecture, so missing application services must be normalized in Core first.

## Goals / Non-Goals

**Goals:**

- Cover every ordinary local management and inspection journey from the CLI.
- Give human and machine modes the same command semantics and Core DTOs.
- Make resources and selections unambiguous across kind, name, source, and ID.
- Manage built-in overrides, custom adapters, collections, and settings without file editing.
- Give first-run and ongoing verification an accurate multi-agent inventory.
- Route all mutations through the plan/transaction protocol.

**Non-Goals:**

- Source-aware resource update, store deletion, export, or target uninstall.
- Reusable sync profiles and scheduled/remote synchronization.
- Plugin marketplace search, `find`, or arbitrary remote Skill execution.
- Reimplementing Core logic in CLI handlers.
- Maintaining ambiguous unreleased name-only selection semantics.

## Decisions

### Organize commands by stable domain nouns

The primary groups will be `resource`, `agent`, `collection`, `config`, `operation`, plus top-level `init`, `plan`, `apply`, `revert`, `status`, `verify`, `doctor`, `capabilities`, `schema`, and `ui`. Each group has consistent `list`, `show`, and supported mutation verbs. Existing aliases may remain only as documented human conveniences and do not receive separate protocol schemas.

### Put application services and public DTOs in Core

CLI and Web call shared Core services for inventory, discovery, configuration, collection membership, settings validation, activity, diff, and verification. CLI handlers only decode protocol input and render the returned DTO. Web routes are not imported by CLI and CLI commands are not imported by Web.

### Use a canonical resource selector

The canonical selector is either immutable resource ID or the full tuple `(kind, name, source)`. Collections store resource IDs plus provenance constraints. Name-only input can be used only as a read filter; it cannot authorize a mutation when more than one match exists.

This replaces the CLI's legacy name-only `select` path with Core's exact selection model.

### Separate detected, configured, enabled, and supported agents

Agent inventory returns one row per adapter with detection evidence, support/capability matrix, configured state, enabled state, scope paths, and validation issues. Built-in customization persists under `adapterOverrides`; new agents persist under `customAdapters`. Commands never convert one model into the other implicitly.

First-run `init` previews this inventory and records only an explicit target set. Non-interactive initialization without targets fails rather than selecting every detected agent.

### Treat collection and configuration changes as planned store mutations

Agent, collection, and settings mutations use the same revisioned plan/receipt boundary as filesystem distribution. Simple human commands can plan and immediately apply after explicit input, while `--dry-run` and machine requests can retain the plan for separate apply.

### Present complete operational evidence

`status` shows ownership/current target health; `diff` shows desired-versus-applied actions; `verify` combines desired divergence, disk drift, reference readiness, and incomplete operations; `operation list/show` exposes redacted historical receipts. Summary output aggregates these DTOs but never replaces the detailed commands.

## Risks / Trade-offs

- [A broad command surface can become inconsistent] → Generate registration, help, capabilities, and schemas from the typed command registry and use shared verb conventions.
- [Exact selectors are more verbose] → Prefer immutable IDs in machine mode and offer read-only filters plus interactive exact choice in text mode.
- [Core services may be shaped around current Web views] → Define resource-oriented public DTOs independently and adapt both callers.
- [Immediate plan-and-apply convenience can hide the plan] → Return both plan identity and operation receipt and make `--dry-run` universally available for mutations.

## Migration Plan

1. Inventory existing Core/Web/CLI surfaces and define shared public DTOs and command schemas.
2. Add read-only resource, agent, collection, config, diff, activity, and verification commands.
3. Add planned agent/custom-adapter, collection, and settings mutations.
4. Replace name-only selection and first-run implicit targets with exact selectors.
5. Remove redundant CLI-only logic and synchronize all public command examples.

Pre-release config uses the current `adapterOverrides`/`customAdapters` split directly; no legacy configuration compatibility layer is added.

## Open Questions

None. Resource lifecycle and reusable profile semantics are intentionally left to the next ordered change.
