## Why

Cellarer's generic mutation kernel already provides strong authority, locking, journaling, receipt, and recovery guarantees, but each domain operation repeats substantial translation and choreography around it. After Inventory operations settle, those repetitions should become explicit operation adapters rather than another transaction engine.

## What Changes

- Define a typed operation-adapter contract for canonical intent, observation/provenance, domain plan construction, semantic validation, effect preparation, receipt projection, and recovery metadata.
- Migrate Store config, resource lifecycle, Inventory import/adoption, sync, revert, and secret-metadata operations incrementally behind characterization tests.
- Keep one unchanged execution kernel as the sole owner of authority verification, locking, journal sequencing, atomic publications, action execution, receipts, and recovery.
- Require exhaustive operation registration and forbid engines from branching on human reason text or bypassing the kernel.
- Remove only duplication proven equivalent after each migration; preserve domain-specific plans where they express user intent.
- Do not introduce a generic workflow DSL, merge read-only planning with apply, or replace `MutationPlan`.

## Capabilities

### New Capabilities

- `mutation-operation-adapters`: Define how domain mutations adapt to the single transaction kernel without weakening operation-specific semantics.

### Modified Capabilities

None.

## Impact

- Store mutation protocol, apply/revert/sync/resource/control-plane/secret/Inventory operation modules, recovery, and tests.
- Scheduled after final Inventory operations to avoid designing adapters around superseded scan semantics.
- No user-visible behavior, plan compatibility, Store format, or second execution engine.

## Execution Contract

- Risk: high
- Depends on: none
- Allowed paths: `packages/core/src/**`, `packages/core/tests/**`, `packages/cli/src/**`, `packages/cli/tests/**`, `packages/web/src/**`, `packages/web/tests/**`, `openspec/changes/deepen-mutation-operation-adapters/**`, `openspec/specs/mutation-operation-adapters/spec.md`
