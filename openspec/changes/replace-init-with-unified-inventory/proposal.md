## Why

Once unified Inventory refresh and exact Store import exist, `init` should stop asking users to choose implementation adapters before showing their resources. First-run CLI and Web clients need one Inventory-first onboarding contract without turning initialization into implicit target distribution.

## What Changes

- Make interactive text `init` create or validate the Store, refresh the complete bounded Inventory, and offer one confirmation for Core-designated ready candidates through the existing exact import plan/apply flow.
- Make JSON, JSONL, structured, non-TTY, and explicitly non-interactive init return the redacted Inventory without prompting or importing.
- **BREAKING**: remove init-time `--agent`/`--no-agent` activation selection, structured agent-selection fields, and their command schemas; enabled state remains only an advanced distribution preference and never filters Inventory.
- Replace the first-run Web flow with Inventory review, safe-candidate confirmation, and separate Library and Sync next actions.
- Replace the accepted `simplify-init-agent-activation` behavior through explicit requirement modification/removal after the prerequisite Inventory changes are complete; until then, the main specs continue to describe the currently implemented initialization behavior.
- Defer post-commit Custom Agent refresh and legacy discovery/scan removal to independently gated changes.

### Non-goals

- Do not implement Inventory enumeration, deduplication, Store import, secret adoption, or target sync here; those are separate changes with independent safety gates.
- Do not distribute, replace, or delete agent targets during initialization or import.
- Do not remove discovery/scan CLI, API, Core, or schema surfaces in this change.
- Do not refresh Inventory after Custom Agent add/update in this change.
- Do not add Store migration state or compatibility aliases for the removed init-selection inputs.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `cli-control-plane`: Replace activation-first initialization with the unified Inventory first-run journey.
- `agent-cli-protocol`: Remove init-selection inputs and define prompt-free machine initialization while preserving generic non-interactive behavior.
- `local-client-api`: Migrate the bundled first-run client to Inventory review and exact Store import.

## Impact

- Core Store initialization validation and public init types.
- CLI initialization composition, command contract, renderer, protocol schemas, and tests.
- `/api/v1` first-run composition, OpenAPI, bundled Web onboarding, and browser flows.
- English and Simplified Chinese public initialization documentation.
- Directly depends on `simplify-init-agent-activation`, `unify-cli-command-contracts`, `add-unified-resource-inventory`, and `add-inventory-store-import`; secret adoption remains an optional later change.
- Refresh the allowed paths and affected contract details after each active dependency is archived.

## Execution Contract

- Risk: integration
- Depends on: simplify-init-agent-activation, unify-cli-command-contracts, add-unified-resource-inventory, add-inventory-store-import
- Allowed paths: `packages/core/src/store/initialize.ts`, `packages/core/src/index.ts`, `packages/core/src/protocol`, `packages/core/tests`, `packages/cli/src/commands/init.ts`, `packages/cli/src/program.ts`, `packages/cli/src/protocol`, `packages/cli/tests`, `packages/web/src/app.ts`, `packages/web/src/api-contract.ts`, `packages/web/client`, `packages/web/tests`, `README.md`, `README.zh-CN.md`, `docs/README.md`, `docs/README.zh-CN.md`
