## Why

A truthful Inventory is useful only if selected safe candidates can enter the managed Store without reintroducing scan's ambiguous discover-and-mutate behavior. Import must be a separate exact mutation that binds what the user reviewed and never authorizes agent targets.

## What Changes

- Add exact Inventory import planning from explicit candidate IDs and the current live Inventory plus Store snapshot.
- Produce one serializable authority-sealed plan bound to candidate identities, source snapshots, normalized publications, Store revision, and provenance.
- Apply the unchanged plan atomically through the existing Store transaction kernel without re-running selection, conflict policy, or discovery.
- Reject unknown, blocked, conflicted, or stale candidates with typed results; keep import separate from target sync.
- Expose plan/apply through CLI and `/api/v1` with closed shared schemas and operation receipts.
- Do not support secret adoption, implicit “import all”, init-time prompting, or agent-target writes in this change.

## Capabilities

### New Capabilities

- `inventory-store-import`: Define exact Inventory-to-Store plan/apply, atomic publication, provenance, drift rejection, and zero target effects.

### Modified Capabilities

- `agent-cli-protocol`: Add discoverable exact import plan/apply inputs, outputs, errors, and serializable plan receipts.
- `cli-control-plane`: Add explicit Inventory import plan/apply commands.
- `local-client-api`: Add versioned exact Inventory import plan/apply routes that preserve Core authority and transaction semantics.

## Impact

- Inventory candidate lookup, Store publication planning, mutation authority, journal/recovery, provenance, CLI, local API, and Web client contract.
- Depends on `add-unified-resource-inventory` and `establish-store-snapshot-boundary`.
- No Store-format migration, target distribution, or secret-provider access.
