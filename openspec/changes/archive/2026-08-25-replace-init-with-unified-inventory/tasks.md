## 1. Prerequisite and Accepted-baseline Gate

**Verification:** `pnpm openspec:preflight --change replace-init-with-unified-inventory`

- [x] 1.1 Confirm `simplify-init-agent-activation`, `unify-cli-command-contracts`, `add-unified-resource-inventory`, and `add-inventory-store-import` are synced, archived, and independently validated before changing init behavior.
- [x] 1.2 Refresh the proposal's allowed paths, the accepted init requirement baseline, and the three delta specs against the post-dependency tree; keep post-commit Custom Agent refresh and discovery/scan removal outside this change.

## 2. Interactive CLI Inventory Onboarding

**Verification:** `CI=true pnpm exec vitest run packages/core/tests/init.test.ts packages/cli/tests/init-command.test.ts -t "Inventory|inventory|init"`

- [x] 2.1 Add failing tests for Store initialize/validate followed by live Inventory refresh, Core-default rendering, one import confirmation, decline, repeated init, partial/failed refresh, stale apply, and zero agent-target effects.
- [x] 2.2 Compose the existing Store initialization, Inventory refresh, exact import plan, and unchanged apply use cases; preserve separate typed results for Store, refresh, confirmation, and import phases.

## 3. Machine Init Contract

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/init-command.test.ts packages/cli/tests/input-protocol.test.ts packages/cli/tests/protocol-conformance.test.ts -t "init"`

- [x] 3.1 Add failing JSON, JSONL, structured-input, non-TTY, and explicitly non-interactive tests proving init returns a closed redacted Inventory result with zero prompt and zero import operations.
- [x] 3.2 Remove `--agent`, `--no-agent`, structured `agents`, selector injection, repeated-selection validation, and obsolete init schemas/help while preserving exact target inputs for later distribution mutations.

## 4. Local API First-run Contract

**Verification:** `CI=true pnpm exec vitest run packages/web/tests/api-contract-registry.test.ts packages/web/tests/api-contract.test.ts packages/web/tests/api-mutation-journeys.test.ts -t "Inventory|inventory|init"`

- [x] 4.1 Add failing API tests for first-run Inventory data, Store/refresh phase separation, exact import receipts, decline, partial refresh, and typed stale results.
- [x] 4.2 Compose existing Core Inventory/import use cases at `/api/v1` and update route registry, OpenAPI, closed schemas, and browser-safe client types without changing discovery/scan routes.

## 5. Bundled Web First-run Journey

**Verification:** `CI=true pnpm exec vitest run packages/web/tests/web-client-journeys.test.ts packages/web/tests/client-api.test.ts packages/web/tests/api-state.test.ts`

- [x] 5.1 Add failing client tests for kind/source/adapter/state filters, merged provenance, Core-ready defaults, confirmation, decline, reload, retry, partial refresh, and stale-plan remediation.
- [x] 5.2 Implement Inventory-first onboarding with one exact Store-import confirmation and separate Library and Sync next actions; do not add Custom Agent refresh or target distribution.

## 6. Public Initialization Guidance

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/init-command.test.ts packages/web/tests/web-client-journeys.test.ts`

- [x] 6.1 Update English and Simplified Chinese public docs with Inventory-first init, prompt-free machine behavior, removed init-selection inputs, exact import commands, decline/retry guidance, and separate Sync authorization verified against source and package metadata.

## 7. Built-client and Real-machine Acceptance

**Verification:** `CI=true pnpm exec vitest run packages/web/tests/client-bundle.test.ts packages/web/tests/client-imports.test.ts`

- [x] 7.1 Run the first-run journey against the built Hono UI at `http://127.0.0.1:4317/dashboard`, covering reload, decline, partial refresh, retry, and stale-plan remediation.
- [x] 7.2 Run read-only real-machine acceptance proving registered sources appear independently of enabled state, stdout/stderr/HTTP responses/receipts remain secret-free, and agent targets remain unchanged before separate Sync.

## 8. Change Closure

**Verification:** full repository and OpenSpec gates

- [x] 8.1 Confirm the modified/removed init requirements match the then-current main specs and run `openspec validate --all --strict --no-interactive`.
- [x] 8.2 Run `CI=true pnpm build`, `CI=true pnpm test`, `CI=true pnpm lint`, and `CI=true pnpm typecheck`; review the owned diff and run `git diff --check`.
