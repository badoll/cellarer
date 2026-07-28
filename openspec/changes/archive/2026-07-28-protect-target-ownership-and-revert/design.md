## Context

The current ledger key includes the input artifact identity, while Rules and MCP are aggregate writes and Skills are placed as individual directories. This allows one physical target to acquire multiple current ledger entries as its selected inputs change. Skill placement also clears any existing destination before writing, and revert deletes a target without proving that its current contents still match the applied receipt.

cellarer is pre-release, so the ledger model can be replaced cleanly. The design must remain Core-first, operate through `Env`, preserve plan/apply separation, and provide thin CLI and Web presentation layers.

## Goals / Non-Goals

**Goals:**

- Establish one current owner record per physical `(agent, scope, capability, target)`.
- Distinguish unowned targets, intact owned targets, drifted owned targets, and invalid ownership records before mutation.
- Prevent implicit deletion of user-managed files or directories.
- Make revert previewable, drift-aware, and target-deduplicated.
- Preserve enough before-state to restore explicitly replaced targets.
- Keep Rules, MCP, and Skills behavior consistent while retaining capability-specific snapshots.

**Non-Goals:**

- Cross-process locking, operation journals, crash recovery, and stale-plan receipts; these belong to `add-transactional-change-protocol`.
- Resource update/remove commands or sync profiles.
- Backward-compatible support for the unreleased version-1 ledger shape.
- A general filesystem snapshot product.

## Decisions

### Use physical target identity for ownership

The current ownership key will be `(agent, scope, capability, normalizedTarget)`. The record will contain a separate ordered set of concrete artifact IDs and the applied checksum or directory fingerprint. Input artifacts are provenance, not identity.

This is preferred over stabilizing aggregate identifiers such as `mcp/*` because the physical target is the unit that is written, checked, and reverted. It also lets collision detection and revert use the same identity.

### Classify target ownership during planning

Each mutating plan action will include an ownership classification:

- `absent`: the target does not exist;
- `owned-current`: a matching owner record exists and disk state matches its receipt;
- `owned-drifted`: a matching owner record exists but disk state changed;
- `unowned-existing`: disk state exists without a matching owner record;
- `invalid-owner`: ownership metadata is ambiguous, duplicated, or points outside the current adapter-managed target.

Planning will return typed conflicts rather than converting these cases into generic warnings. `unowned-existing`, `owned-drifted`, and `invalid-owner` are blocked by default.

### Require explicit replacement policy and a restorable snapshot

Callers may explicitly request replacement of `unowned-existing` targets. File and Skill before-state is persisted only as an encrypted snapshot with restrictive permissions; plaintext snapshot payloads are never stored in the cellarer store. The action is not eligible for apply if a complete snapshot cannot be encrypted and durably recorded. Temporary plaintext needed to create or restore a snapshot remains effect-scoped through `Env` and is removed on success or recovery.

Replacement of `owned-drifted` targets is a separate force decision because it discards edits made after apply. A caller must identify the exact target receipt being overridden.

### Separate revert planning from revert application

Core will expose a read-only revert plan containing current state, expected receipt, snapshot availability, and proposed action. Revert apply consumes that plan shape and blocks drifted or invalid targets unless the request carries the exact destructive acknowledgement defined by the plan.

Revert will deduplicate physical targets before mutation and update ownership records only after a target has been successfully restored or removed.

### Replace the ledger schema before release

The new state file will use a new schema version with target-keyed owner records. Development stores using the old schema will receive a clear pre-release reset or migration error rather than silent interpretation. A one-time migration helper may be implemented only if it can prove unique physical ownership; ambiguous records must be reported for manual recovery.

## Risks / Trade-offs

- [Directory snapshots can consume significant disk space] → Snapshot only explicitly replaced unowned directories, record size in the plan, and allow the user to cancel before apply.
- [An existing target can already contain plaintext credentials] → Persist snapshot payloads encrypted, redact snapshot metadata, and block replacement when safe encryption is unavailable.
- [Path aliases or ancestor symlinks can produce false ownership matches] → Normalize through adapter-resolved absolute paths and validate nearest existing ancestors before classifying ownership.
- [A strict default blocks workflows that previously overwrote targets] → Return exact conflict evidence and an explicit replacement path instead of restoring implicit overwrite behavior.
- [Pre-release state reset may inconvenience active development stores] → Provide a doctor diagnostic and documented backup/reset procedure before refusing the old schema.

## Migration Plan

1. Introduce the target ownership model and versioned state parser alongside fixtures for ambiguous old entries.
2. Update plan/status to classify ownership without changing writes.
3. Update Skill and aggregate MCP/Rules planning to emit target-keyed records and conflicts.
4. Add revert planning and drift guards, then switch revert apply to the new records.
5. Remove unconditional destination clearing from ordinary placement paths.
6. Add a pre-release doctor diagnostic and reset/migration guidance for old state files.

Rollback during development is performed by restoring the previous application build together with a backup of the previous state file; the two ledger schemas must not be mixed.

## Open Questions

None. Cross-process atomicity and persisted plan receipts are deliberately deferred to the next ordered change.
