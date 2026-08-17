## Why

After unified Inventory refresh/import and Inventory-first onboarding replace the old journeys, retaining discovery-summary and mutating scan surfaces leaves two vocabularies and two mutation paths for the same user job. The pre-release product should remove the obsolete contracts cleanly rather than preserve aliases that can bypass the reviewed Inventory plan/apply boundary.

## What Changes

- **BREAKING**: remove the legacy CLI discovery-summary leaf and mutating `scan` leaf, including their command contracts, structured schemas, capability entries, renderers, and help.
- **BREAKING**: remove superseded `/api/v1` discovery-summary and scan-backed plan/apply route shapes from the route registry, OpenAPI, closed schemas, client types, and bundled Web calls.
- Remove Core discovery-summary and scan-mutation orchestration exports only after the accepted Inventory implementation supplies each retained safe observation/import responsibility.
- Freeze an exact removal/retention manifest after dependencies close and prove no first-party runtime or declaration consumer still reaches a removed symbol or route.
- Return not-found or unsupported-contract results for removed API/schema identifiers without compatibility aliases, translation handlers, or hidden fallback to legacy Core code.
- Update English and Simplified Chinese migration guidance from discovery/scan commands to Inventory refresh/import plan/apply.

### Non-goals

- Do not change unified Inventory enumeration, candidate identity, default selection, import planning, mutation authority, receipts, or recovery semantics.
- Do not remove generic capability/schema discovery commands, resource catalog behavior still required by accepted product journeys, or safe primitives owned by Inventory.
- Do not change first-run onboarding, Custom Agent post-commit refresh, secret adoption, or Sync target distribution.
- Do not migrate Store data or preserve deprecated command/route aliases.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-cli-protocol`: Remove discovery-summary and scan command contracts and their retrievable schemas while preserving authoritative Inventory contracts.
- `cli-control-plane`: Remove legacy discovery-summary and mutating scan product paths after Inventory parity.
- `local-client-api`: Remove superseded discovery/scan routes and replace scan-specific plan scenarios with accepted Inventory import behavior.

## Impact

- Core discovery/scan orchestration, public exports, protocol DTOs, recovery decoding, and tests.
- CLI command registration, command catalog, schemas, renderers, help, and tests.
- `/api/v1` route registry, OpenAPI, browser-safe types, bundled client calls, and tests.
- English and Simplified Chinese command migration documentation.
- Refresh the exact removal/retention manifest and allowed paths after each dependency is archived.

## Execution Contract

- Risk: high
- Depends on: unify-cli-command-contracts, add-unified-resource-inventory, add-inventory-store-import, replace-init-with-unified-inventory
- Allowed paths: `packages/core/src/engine/scan.ts`, `packages/core/src/resources/discovery.ts`, `packages/core/src/resources/catalog.ts`, `packages/core/src/control-plane.ts`, `packages/core/src/index.ts`, `packages/core/src/protocol`, `packages/core/tests`, `packages/cli/src/commands/control-plane-read.ts`, `packages/cli/src/commands/scan.ts`, `packages/cli/src/program.ts`, `packages/cli/src/protocol`, `packages/cli/tests`, `packages/web/src/app.ts`, `packages/web/src/api-contract.ts`, `packages/web/client`, `packages/web/tests`, `README.md`, `README.zh-CN.md`, `docs/README.md`, `docs/README.zh-CN.md`
