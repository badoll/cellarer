## Why

A newly added or updated Custom Agent can expose Rules, MCP definitions, or Skills immediately, but the live Inventory remains stale until a separate refresh. The committed adapter mutation and its follow-up observation need one shared result that never rolls back or misreports the mutation when refresh fails.

## What Changes

- After a Custom Agent add or update commits, invoke a targeted read-only Inventory refresh for that exact adapter.
- Return the committed mutation receipt and a separate typed post-commit refresh outcome through the shared Core control-plane boundary.
- Preserve mutation success when refresh is partial or fails and include the exact retry command `cellarer inventory refresh --agent <id>`.
- Keep refresh reference-only, secret-free, and independent of mutation authority after the adapter commit completes.
- Project the same typed result through CLI machine/human output and `/api/v1` without client-side retry, rollback, or success inference.
- Do not refresh after built-in enable/disable/configure/reset or Custom Agent removal in this change.

### Non-goals

- Do not change Custom Agent mutation planning, authority, locking, journaling, receipts, recovery, or Store format.
- Do not import refreshed candidates or write agent targets.
- Do not add background refresh, watchers, queues, retries, or a general post-commit hook framework.
- Do not change first-run onboarding or remove discovery/scan surfaces.

## Capabilities

### New Capabilities

- `post-commit-inventory-refresh`: Define targeted Inventory observation after a committed Custom Agent add/update, including failure isolation, exact retry guidance, and shared typed projection.

### Modified Capabilities

None.

## Impact

- Core control-plane Custom Agent mutation composition and public result types.
- CLI Custom Agent mutation presentation, machine schemas, and tests.
- `/api/v1` mutation result schemas, bundled Agents UI, and tests.
- English and Simplified Chinese Custom Agent guidance.
- Refresh this contract after each dependency is archived.

## Execution Contract

- Risk: integration
- Depends on: unify-cli-command-contracts, add-unified-resource-inventory, replace-init-with-unified-inventory
- Allowed paths: `packages/core/src/control-plane.ts`, `packages/core/src/index.ts`, `packages/core/tests/control-plane-mutations.test.ts`, `packages/cli/src/commands/control-plane-mutations.ts`, `packages/cli/src/protocol`, `packages/cli/tests/control-plane-mutation-commands.test.ts`, `packages/cli/tests/protocol-conformance.test.ts`, `packages/web/src/app.ts`, `packages/web/src/api-contract.ts`, `packages/web/client/agents-page.tsx`, `packages/web/client/api.ts`, `packages/web/tests`, `README.md`, `README.zh-CN.md`, `docs/README.md`, `docs/README.zh-CN.md`
