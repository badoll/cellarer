## Why

Even the smallest control-plane read currently joins Store paths and reads configuration and revision independently. Before widening the boundary to Inventory or mutation planners, Cellarer needs one proven, reviewable seam that cannot return a configuration paired with the wrong revision.

## What Changes

- Introduce a Core-owned `StoreLayout` seam for only the configuration and revision paths needed by the first snapshot.
- Add a coherent configuration snapshot that binds canonical Store identity, parsed configuration, and revision using bounded observation.
- Migrate only `showControlPlaneConfig` as the representative read consumer while preserving its public DTO.
- Return typed stale or unsafe observation results instead of combining revisions or following a managed-path symlink.
- Keep the snapshot read-only and reference-only, without mutation authority or secret-provider access.
- Defer registry, ledger, profile, receipt, dashboard, remaining control-plane, and mutation-planner migration to later changes created after this seam is proven.
- Do not add a database, daemon, persistent cache, Store-format migration, or production dependency.

## Capabilities

### New Capabilities

- `store-observation-snapshot`: Establish the canonical layout and coherent configuration-snapshot seam, including one representative control-plane consumer.

### Modified Capabilities

None.

## Impact

- Core Store configuration/revision paths, configuration loading, one control-plane read, and Core exports.
- Focused fake-Env coverage for stable reads, drift, Store aliases, managed-path symlinks, and secret-provider independence.
- Establishes the seam for later snapshot expansion; it does not by itself satisfy Inventory or mutation-planner prerequisites.

## Execution Contract

- Risk: high
- Depends on: none
- Allowed paths: `packages/core/src/store`, `packages/core/src/protocol/store-revision.ts`, `packages/core/src/control-plane.ts`, `packages/core/src/index.ts`, `packages/core/tests`
