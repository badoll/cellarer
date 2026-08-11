## Why

Once unified Inventory refresh and exact Store import exist, `init` should stop asking users to choose implementation adapters before showing their resources. The product also needs one vocabulary instead of retaining overlapping discovery and mutating scan journeys.

## What Changes

- Make interactive text `init` create or validate the Store, refresh the complete bounded Inventory, and offer one confirmation for Core-designated ready candidates through the existing exact import plan/apply flow.
- Make JSON, JSONL, structured, non-TTY, and explicitly non-interactive init return the redacted Inventory without prompting or importing.
- Remove init-time `--agent`/`--no-agent` activation selection; enabled state remains only an advanced distribution preference and never filters Inventory.
- Replace the first-run Web flow with Inventory review, safe-candidate confirmation, and separate Library and Sync next actions.
- Refresh a Custom Agent after successful add/update, with warning-only failure and an exact retry command.
- **BREAKING**: remove the overlapping `discovery` and mutating `scan` CLI surfaces and their unreleased `/api/v1` shapes without compatibility aliases.
- Supersede `simplify-init-agent-activation`; that active change MUST NOT be synchronized or archived independently as final accepted initialization behavior.

### Non-goals

- Do not implement Inventory enumeration, deduplication, Store import, or secret adoption here; those are prerequisite changes with independent safety gates.
- Do not distribute, replace, or delete agent targets during initialization or import.
- Do not preserve deprecated discovery/scan aliases or add Store migration state.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `cli-control-plane`: Replace activation-first initialization and legacy discovery/scan surfaces with the unified Inventory first-run journey.
- `agent-cli-protocol`: Remove obsolete init-selection and legacy command schemas while defining prompt-free machine initialization.
- `local-client-api`: Migrate the bundled first-run client and remove superseded discovery/scan route shapes.

## Impact

- CLI initialization, command catalog, renderers, capabilities, and tests.
- `/api/v1` route registry, OpenAPI, bundled Web first-run UI, and browser flows.
- English and Simplified Chinese public initialization and migration documentation.
- Depends on `unify-cli-command-contracts`, `add-unified-resource-inventory`, and `add-inventory-store-import`; secret adoption remains an optional later change.
