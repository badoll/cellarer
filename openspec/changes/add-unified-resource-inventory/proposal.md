## Why

Cellarer has overlapping discovery summary, resource catalog, and per-adapter scan views, and their defaults can hide registered sources behind enabled or detected state. Users first need one truthful, read-only answer to “what Rules, MCP definitions, and Skills exist in my bounded user and project sources?”

## What Changes

- Add one Core-owned live Inventory refresh across every registered built-in and custom adapter's declared user paths plus an explicitly selected project.
- Normalize, recursively secret-scan, fingerprint, deduplicate, group conflicts, and project candidates with stable exact IDs, provenance, typed findings, managed matches, simple states, and completeness.
- Keep enabled and detection state as metadata only; neither filters the default refresh.
- Expose read-only Inventory refresh through CLI and `/api/v1`, including full and explicit per-adapter refresh, using one shared browser-safe DTO.
- Isolate adapter/source/candidate failures and preserve safe results; perform zero Store, source, target, credential-provider, authority, or activity writes.
- Do not import resources, change `init`, remove legacy discovery/scan commands, adopt secrets, or add a persistent cache in this change.

## Capabilities

### New Capabilities

- `unified-resource-inventory`: Define bounded all-source enumeration, safe inspection, deduplication, exact candidate identity, findings, managed matching, and refresh completeness.

### Modified Capabilities

- `cli-control-plane`: Add the read-only `inventory refresh` surface without changing initialization or legacy commands yet.
- `agent-cli-protocol`: Add discoverable machine contracts for full and targeted Inventory refresh.
- `local-client-api`: Add the versioned read-only Inventory contract for the bundled Web client.

## Impact

- Adapter source enumeration, safe snapshots, resource normalization, secret guards, candidate projection, and control-plane DTOs.
- CLI command catalog/rendering and `/api/v1` route/OpenAPI/client types.
- Depends on explicit runtime exports, Core effect boundaries, Store snapshots, and unified CLI command contracts.
