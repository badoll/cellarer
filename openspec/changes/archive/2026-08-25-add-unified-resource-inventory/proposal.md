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

## Execution Contract

- Risk: high
- Depends on: `partition-core-runtime-exports`, `harden-core-effect-and-error-boundaries`, `establish-store-snapshot-boundary`, `unify-cli-command-contracts`
- Allowed paths: `openspec/changes/add-unified-resource-inventory/**`, `openspec/specs/unified-resource-inventory/spec.md`, `openspec/specs/cli-control-plane/spec.md`, `openspec/specs/agent-cli-protocol/spec.md`, `openspec/specs/local-client-api/spec.md`, `packages/core/src/inventory/**`, `packages/core/src/adapters/**`, `packages/core/src/store/config.ts`, `packages/core/src/protocol/client.ts`, `packages/core/src/protocol/client-types.ts`, `packages/core/src/index.ts`, `packages/core/tests/inventory-*.test.ts`, `packages/core/tests/package-exports.test.ts`, `packages/core/tests/fixtures/inventory/**`, `packages/core/tests/fixtures/package-exports-baseline.ts`, `packages/cli/src/commands/inventory.ts`, `packages/cli/src/commands/command-catalog.ts`, `packages/cli/src/program.ts`, `packages/cli/src/protocol/**`, `packages/cli/tests/inventory-*.test.ts`, `packages/cli/tests/protocol-conformance.test.ts`, `packages/cli/tests/protocol.test.ts`, `packages/cli/tests/program.test.ts`, `packages/cli/tests/command-parity-baseline.test.ts`, `packages/cli/tests/fixtures/command-surface-v1.json`, `packages/web/src/app.ts`, `packages/web/src/server.ts`, `packages/web/src/api-contract.ts`, `packages/web/client/**`, `packages/web/tests/inventory-*.test.ts`, `packages/web/tests/fixtures/local-client-api-v1.json`, `README.md`, `README.zh-CN.md`, `docs/README.md`, `docs/README.zh-CN.md`
