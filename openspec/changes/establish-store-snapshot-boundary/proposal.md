## Why

Read use cases currently assemble Store state from many independently joined paths and reads. A unified Inventory must classify candidates against one coherent managed revision, and mutation planning must bind the same observation rather than a mixture of revisions.

## What Changes

- Introduce one Core-owned Store layout grammar for all managed paths and reject ad hoc Store-relative path construction outside it.
- Add a stable read snapshot that captures canonical Store identity, revision, config, resource registry, ownership ledger, profiles, and relevant operation state under explicit consistency rules.
- Make control-plane reads and mutation planning consume the same snapshot types and provenance descriptors.
- Detect concurrent Store drift and retry bounded read-only observations or return a typed stale snapshot; never silently combine revisions.
- Keep snapshot construction read-only, reference-only, safe against Store aliases and symlink traversal, and independent of mutation authority.
- Do not add a database, daemon, persistent cache, or Store-format migration.

## Capabilities

### New Capabilities

- `store-observation-snapshot`: Define canonical Store layout and coherent read snapshots shared by control-plane reads and mutation planning.

### Modified Capabilities

None.

## Impact

- Store path helpers, revision observation, config/registry/ledger/profile readers, control-plane DTO composition, and plan provenance.
- Race, alias, symlink, missing-file, and fake-Env tests.
- Prerequisite for Inventory managed-revision matching and exact import planning.
