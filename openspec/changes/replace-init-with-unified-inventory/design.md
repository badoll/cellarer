## Context

The prerequisite changes provide a live unified Inventory, exact Store import, browser-safe contracts, coherent Store snapshots, and one CLI command catalog. At that point `init` can become a small onboarding composition rather than an owner of discovery or mutation semantics. The currently active `simplify-init-agent-activation` implemented an intermediate prompt-based enabled-agent choice that conflicts with this final model.

## Goals / Non-Goals

**Goals:**

- Make first run show resources before adapter preferences.
- Keep interactive convenience on top of the same exact plan/apply used by automation.
- Remove overlapping product vocabulary and migrate the bundled Web journey.

**Non-Goals:**

- Do not implement Inventory algorithms, import transactions, secret adoption, or target sync.
- Do not retain compatibility aliases for unreleased discovery/scan contracts.

## Decisions

### `init` composes existing use cases

Core Store initialization remains responsible only for creating or validating Store state. The CLI composition then invokes live Inventory refresh, presents aggregate state, creates an exact import plan for the current default-selected ready IDs, and asks once before applying that unchanged plan. No new “init transaction” combines Store creation and import.

### Machine init is read-only after Store initialization

JSON, JSONL, structured, non-TTY, and `--non-interactive` invocations return Inventory and never infer selection or import. Automation that wants import calls `inventory import plan/apply`. This preserves prompt isolation and makes omission unambiguous.

### Enabled state is not onboarding state

Init-time `--agent` and `--no-agent` are removed. Enabled configuration may remain as an advanced default for later distribution presentation, but Inventory ignores it and every target mutation still requires exact operation intent. Detection is evidence, not consent.

### Remove, do not alias, discovery and scan

After all clients use Inventory refresh/import, CLI registrations, schema entries, `/api/v1` shapes, Web calls, and dead Core orchestration are deleted together. Aliases were rejected because `scan` combines observation and mutation while Inventory intentionally separates them.

### Custom Agent refresh is post-commit composition

After adapter add/update commits, the composing client invokes targeted Inventory refresh. Failure becomes a warning with `cellarer inventory refresh --agent <id>` and never rolls back or misreports the committed configuration mutation.

### Superseded change is not accepted state

`simplify-init-agent-activation` remains historical implementation context only until this migration replaces it. Its deltas must not be synced to main specs or archived as the final behavior. Closure reconciles its active state explicitly.

## Risks / Trade-offs

- **[Risk] Interactive init plans against a changing source.** → Apply the exact plan and surface stale-candidate remediation; never silently replan after confirmation.
- **[Risk] Pre-release scripts use removed commands.** → Publish an exact migration table and reject old paths rather than ambiguous aliases.
- **[Risk] Store creation succeeds but refresh fails.** → Report initialization success separately from failed/partial Inventory and provide a retry command.

## Migration Plan

1. Require prerequisite changes to be synced and validated.
2. Replace CLI init composition and machine schemas.
3. Migrate Web first-run and Custom Agent post-commit refresh.
4. Remove discovery/scan CLI, API, Core orchestration, schemas, and docs.
5. Reconcile the superseded active change, run full gates, and perform real-machine read-only acceptance.
6. Rollback restores the prior command/UI surface; imported Store content remains valid and no target rollback is required.

## Open Questions

None.
