## Context

Store reads are spread across configuration, resources, ownership, profiles, receipts, diagnostics, and engines. The first tractable inconsistency already exists in `showControlPlaneConfig`: configuration and revision are loaded independently. This change proves a narrow canonical-layout and coherent-snapshot seam there before any broader consumer migration.

## Goals / Non-Goals

**Goals:**

- Centralize the configuration and revision paths required by the first snapshot.
- Return one immutable configuration observation bound to a stable Store revision.
- Preserve the existing control-plane configuration DTO while proving the seam in one consumer.

**Non-Goals:**

- Do not migrate resource, ownership-ledger, profile, journal, receipt, dashboard, or mutation-planner consumers.
- Do not ban unrelated path joins before their owning domains migrate.
- Do not change the on-disk layout, add persistence, hold mutation locks for reads, or make snapshots executable plans.

## Decisions

### Introduce `StoreLayout` as a value object

The first `StoreLayout` exposes canonical physical Store identity plus named configuration and revision paths. It resolves a root alias once and validates that the two managed paths remain contained. Other paths remain in their current owners until a later change migrates them. A complete path god object was rejected because it would force unrelated domains into this pilot.

### Observe revision before and after bounded reads

`observeStoreConfigSnapshot` reads the protected revision descriptor, loads configuration through the canonical layout without following the managed file, and re-reads the revision. A mismatch discards the observation and permits at most one retry before returning `STALE_STORE_SNAPSHOT`. Holding the mutation lock was rejected because a read should not block a writer.

### Migrate one representative consumer

`showControlPlaneConfig` consumes the snapshot and continues returning the same revision plus public projected configuration. Migrating dashboard, catalog, status, diff, verification, or planners in this change was rejected because each adds different consistency and privilege obligations before the seam itself is proven.

### Snapshot values are immutable and reference-only
The snapshot is immutable data. Configuration continues to contain secret reference names rather than provider values, and construction receives no provider capability.

## Proof Obligations

| State | Required observation | Forbidden outcome |
| --- | --- | --- |
| Stable revision | Return the parsed configuration and that exact revision | A revision read outside the snapshot |
| One concurrent revision advance | Discard the first observation and retry once | Returning components from the discarded attempt |
| Revision advances again | Return `STALE_STORE_SNAPSHOT` | Unbounded retry or a mixed result |
| Store root alias | Resolve one canonical physical identity | Two identities for the same physical Store |
| Managed configuration path is a symlink | Return a typed unsafe observation before external content is read | Following the link |
| Mutation authority or secret provider is absent | Preserve the control-plane configuration result | Requesting either capability |

## Risks / Trade-offs

- **[Risk] A writer bypasses the revision protocol.** → This pilot relies on the existing publication invariant and does not claim coherence for out-of-protocol writes.
- **[Risk] Canonicalization accidentally follows the managed configuration file.** → Resolve only the Store root identity, then apply contained no-follow observation to the named file.
- **[Trade-off] The first snapshot contains only configuration.** → Accept the narrow seam and expand it through later independently reviewed changes.

## Migration Plan

1. Characterize current configuration and revision path behavior.
2. Add the limited `StoreLayout` and coherent configuration snapshot.
3. Migrate `showControlPlaneConfig` with DTO parity evidence.
4. Rollback restores that consumer's direct reads; the on-disk format is unchanged.

## Open Questions

None.
