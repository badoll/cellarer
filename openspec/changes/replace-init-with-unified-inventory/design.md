## Context

The prerequisite changes provide a live unified Inventory, exact Store import, browser-safe contracts, coherent Store snapshots, and one CLI command catalog. At that point `init` can become a small onboarding composition rather than an owner of discovery, adapter activation, or target mutation semantics. The accepted `simplify-init-agent-activation` behavior is an intermediate prompt-based enabled-agent choice that this change will explicitly replace.

## Goals / Non-Goals

**Goals:**

- Make first run show resources before adapter preferences.
- Keep interactive convenience on top of the same exact plan/apply used by automation.
- Keep CLI and bundled Web onboarding on the same Core Inventory/import contracts.

**Non-Goals:**

- Do not implement Inventory algorithms, import transactions, secret adoption, or target sync.
- Do not refresh Inventory after Custom Agent mutation.
- Do not remove discovery/scan CLI, API, Core, or schema surfaces.
- Do not retain compatibility aliases for removed init-selection inputs.

## Decisions

### Core owns state and selection; shells own confirmation

Core Store initialization remains responsible only for creating or validating Store state. Core Inventory refresh returns candidates, completeness, findings, and default-selected ready IDs. Core import planning accepts only exact candidate IDs and apply consumes only its unchanged authority-sealed receipt. CLI and Web composition may present those results and collect confirmation, but MUST NOT reproduce candidate classification, default selection, plan reconstruction, or mutation rules. No new “init transaction” combines Store creation and import.

### Machine init is read-only after Store initialization

JSON, JSONL, structured, non-TTY, and `--non-interactive` invocations return Inventory and never accept or infer import selection. Automation that wants import calls `inventory import plan/apply`. This preserves prompt isolation and makes omission unambiguous.

### Enabled state is not onboarding state

Init-time `--agent` and `--no-agent` are removed. Enabled configuration may remain as an advanced default for later distribution presentation, but Inventory ignores it and every target mutation still requires exact operation intent. Detection is evidence, not consent.

### Replace the accepted intermediate state explicitly

`simplify-init-agent-activation` describes the current implementation and is therefore synchronized and archived independently before this change starts. This change owns the later transition by removing that accepted requirement through its delta spec after all prerequisites pass. Future intent does not make the current main specification inaccurate in the meantime.

### Keep Store initialization, refresh, and import separately observable

Store initialization success is durable even if later refresh is partial or fails. Refresh never imports. Interactive confirmation applies only the exact plan constructed from the displayed default-selected candidate IDs. Decline performs no import. Stale apply returns Core's typed remediation and never silently refreshes, replans, or retries with different candidates. The bundled Web journey uses the same phase boundaries through `/api/v1`.

## State Matrix

| Store phase | Refresh phase | User/import phase | Required result | Forbidden result |
| --- | --- | --- | --- | --- |
| fails | not started | not started | Return the typed initialization failure | Refresh, import, or agent-target write |
| succeeds | complete | declines | Report Store plus Inventory and finish without import | Store rollback or implicit import |
| succeeds | complete | confirms current plan | Apply the unchanged exact Store-import plan | Reclassification, replanning, or agent-target write |
| succeeds | partial | not confirmed | Preserve candidates, findings, and completeness with exact retry guidance | Treat partial Inventory as complete |
| succeeds | fails | not started | Preserve Store success and return refresh failure/remediation separately | Undo Store creation or report full init failure |
| succeeds | complete | plan is stale | Return Core's typed stale result and require explicit refresh/replan | Silent retry or apply of changed candidates |
| existing Store validates | complete | any | Use the current live Inventory and select only current Core defaults | Reuse a prior in-memory selection |

## Proof Obligations

- CLI and Web default selection exactly matches the Core Inventory DTO.
- Machine init performs zero prompt and zero import operations.
- Interactive decline, partial refresh, refresh failure, and stale apply perform zero agent-target writes.
- An accepted import applies the unchanged Core plan receipt and no shell reconstructs it.
- Removed init-selection fields are absent from argv help, command contracts, structured schemas, capability discovery, and client types.
- Public results, warnings, logs, and browser-visible data remain reference-only and secret-free.

## Risks / Trade-offs

- **[Risk] Interactive init plans against a changing source.** → Apply the exact plan and surface stale-candidate remediation; never silently replan after confirmation.
- **[Risk] Pre-release scripts use removed init-selection fields.** → Publish an exact migration table and reject old input rather than retaining ambiguous aliases.
- **[Risk] Store creation succeeds but refresh fails.** → Report initialization success separately from failed/partial Inventory and provide a retry command.
- **[Risk] CLI and Web reproduce Core selection rules differently.** → Treat Core's default-selected IDs and exact plan receipt as authoritative and add cross-client parity tests.

## Migration Plan

1. Require each direct prerequisite change to be synced, archived, and validated; refresh this change's contract and delta baseline after each closure.
2. Add failing CLI, protocol, API, and Web parity tests for the state matrix and explicit removal of init-selection inputs.
3. Replace CLI init composition and machine schemas using the existing Core Inventory/import use cases.
4. Migrate the `/api/v1` and bundled Web first-run journey without changing discovery/scan or Custom Agent mutation behavior.
5. Confirm the explicit requirement modification/removal matches the then-current main specs, update public guidance, run full gates, and perform real-machine read-only acceptance.
6. Rollback restores the prior init command/UI surface; imported Store content remains valid and no target rollback is required.

## Open Questions

None.
