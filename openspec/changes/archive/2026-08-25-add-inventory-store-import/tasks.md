## 1. Exact Planning Contract

- [x] 1.1 Add failing tests for explicit non-empty candidate IDs, unknown/duplicate/conflicted/blocked rejection, current refresh resolution, Store snapshot binding, and zero inferred selection.
- [x] 1.2 Extract reusable captured publications and provenance descriptors from the unified Inventory inspection path without weakening the legacy scan path's recursive, symlink, secret, or final-byte guards.
- [x] 1.3 Implement Inventory import planning with normalized intent, exact candidate/source bindings, Store revision, self-contained reference-only publications, authority seal, and plan/body budgets.

**Verification:** `CI=true pnpm exec vitest run packages/core/tests/inventory-store-import-planning.test.ts packages/core/tests/inventory-safety.test.ts packages/core/tests/scan.test.ts packages/core/tests/store-snapshot.test.ts`

## 2. Exact Atomic Apply

- [x] 2.1 Add failing tests for cross-process apply, altered plans, stale candidates, stale Store revision, action-set injection, atomic batch failure, and zero target/provider interactions.
- [x] 2.2 Implement operation-specific semantic validation before product observation and apply the unchanged plan through the existing Store mutation kernel.
- [x] 2.3 Record resource revisions, full provenance, optional collection membership, activity, journal, receipt, and recovery evidence in one atomic Store revision.

**Verification:** `CI=true pnpm exec vitest run packages/core/tests/inventory-store-import-apply.test.ts packages/core/tests/mutation-authority.test.ts packages/core/tests/mutation-lock.test.ts packages/core/tests/durable-journal-authority.test.ts packages/core/tests/activity.test.ts`

## 3. CLI and Local API Mutation Surface

- [x] 3.1 Add exact `inventory import plan` and `inventory import apply` command contracts, human previews, machine schemas, typed conflicts, and prompt-free non-interactive behavior.
- [x] 3.2 Add `/api/v1` exact import plan/apply routes and prove handlers neither reconstruct intent nor receive target or provider capabilities.
- [x] 3.3 Add Web client contract support and a plan/apply integration test without migrating first-run UX yet.
- [x] 3.4 Document the exact plan/apply workflow and keep the English and Simplified Chinese public documentation aligned.

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/inventory-import-command.test.ts packages/cli/tests/inventory-protocol.test.ts packages/web/tests/inventory-import-api.test.ts packages/web/tests/api-contract.test.ts packages/web/tests/client-api.test.ts`

## 4. Transaction Verification

- [x] 4.1 Add one transaction journey covering same-process and replacement-process application, stale source and Store rejection, a signed journal/receipt interruption recovered through the existing kernel, and no partial visible batch.
- [x] 4.2 Add observation sentinels proving tamper and injected target actions fail before Store, source, provider, or target observation; limit group-4 edits to `packages/core/tests/inventory-store-import-transaction.test.ts` plus bounded repairs in `packages/core/src/inventory/import.ts` or `packages/core/src/protocol/{execute,journal,recovery}.ts`.

**Verification:** `CI=true pnpm exec vitest run packages/core/tests/inventory-store-import-transaction.test.ts packages/core/tests/transaction-recovery.test.ts packages/core/tests/store.test.ts packages/core/tests/mutation-authority.test.ts packages/core/tests/durable-journal-authority.test.ts packages/cli/tests/inventory-import-command.test.ts packages/web/tests/inventory-import-api.test.ts`

## 5. Completion Gates

- [x] 5.1 Run the closure gates once; review the owned diff against proof obligations 1-8 and the explicit implementation/test/doc paths in the Execution Contract; verify the live change directory, four named main-spec directories, and dated archive target; then run whitespace validation, preflight, and strict validation.

**Verification:** `CI=true pnpm build && CI=true pnpm test && CI=true pnpm lint && CI=true pnpm typecheck && git diff --check && openspec validate add-inventory-store-import --strict --no-interactive && pnpm openspec:preflight --change add-inventory-store-import --json`
