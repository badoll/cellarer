## 1. Characterization and Adapter Contract

- [x] 1.1 Capture canonical plan bytes, authority scope, ordered effect traces, conflicts, receipts, and recovery for config, adapter, collection, resource, profile, Inventory import, secret adoption, sync/apply/uninstall, revert, secret-metadata, and authority-lifecycle mutations.
- [x] 1.2 Define the typed `MutationOperationAdapter` lifecycle and closed exhaustive registry while keeping authority verification, locks, journals, execution, receipts, and recovery in the existing kernel.
- [x] 1.3 Add failing tests for unknown/duplicate registrations, cross-operation actions, message/reason-based policy, and direct Store/target/provider effect bypasses.

**Verification:** `CI=true pnpm vitest run packages/core/tests/mutation-operation-adapters.test.ts packages/core/tests/mutation-operation-characterization.test.ts`

## 2. Low-risk Store Operation Migration

- [x] 2.1 Migrate config, built-in/custom adapter, collection, and ordinary Store publication operations with before/after canonical and effect parity.
- [x] 2.2 Migrate resource create/update/rename/remove and profile mutations while preserving immutable identity, dependency checks, provenance, and receipts.
- [x] 2.3 Delete duplicated Store/resource choreography covered by the group fixtures and keep operation-specific domain validation in its owning module.

**Verification:** `CI=true pnpm vitest run packages/core/tests/config.test.ts packages/core/tests/adapters.test.ts packages/core/tests/control-plane-mutations.test.ts packages/core/tests/sync-profiles.test.ts packages/core/tests/resource-lifecycle-mutations.test.ts packages/core/tests/resource-lifecycle-update.test.ts packages/core/tests/transaction-callers-integration.test.ts`

## 3. Target, Inventory, and Secret Operation Migration

- [x] 3.1 Migrate Inventory import and secret adoption adapters with exact source/provider semantics and reference-only canaries.
- [x] 3.2 Migrate sync apply/uninstall, ordinary apply, and revert while preserving ownership, gitignore terminal actions, snapshots, drift, and recovery.
- [x] 3.3 Migrate secret-metadata and mutation-authority lifecycle operations without expanding ordinary provider capability or weakening authority-first ordering.

**Verification:** `CI=true pnpm vitest run packages/core/tests/inventory-store-import-planning.test.ts packages/core/tests/inventory-store-import-apply.test.ts packages/core/tests/inventory-store-import-transaction.test.ts packages/core/tests/inventory-secret-adoption-planning.test.ts packages/core/tests/inventory-secret-adoption-apply.test.ts packages/core/tests/inventory-secret-adoption-observability.test.ts packages/core/tests/inventory-secret-adoption-recovery.test.ts packages/core/tests/transactional-apply.test.ts packages/core/tests/revert-plan.test.ts packages/core/tests/sync-profiles.test.ts packages/core/tests/mutation-authority.test.ts packages/core/tests/mutation-authority-lifecycle.test.ts packages/core/tests/reference-only-secrets-e2e.test.ts`

## 4. Kernel and Dependency Cleanup

- [x] 4.1 Remove the superseded wrappers, canonical validation, and receipt projection enumerated by the migrated-family characterization map after their parity fixtures pass.
- [x] 4.2 Enforce that domain modules depend on adapter contracts and that only the registry/kernel composition can invoke prepared mutation effects.
- [x] 4.3 Measure module size, dependency cycles, and duplicated choreography against the baseline without using line count alone as a completion criterion.

**Verification:** `CI=true pnpm vitest run packages/core/tests/mutation-operation-architecture.test.ts packages/core/tests/mutation-operation-characterization.test.ts && CI=true pnpm --filter @cellarer/core typecheck`

## 5. Completion Gates

- [x] 5.1 Run focused mutation-authority, canonical plan, store-mutation, apply/revert/sync, Inventory, resource, secret, journal/recovery, CLI/API parity, and zero-interaction tests.
- [x] 5.2 Run the closure build/test/lint/typecheck gates, review the owned diff, run `git diff --check`, and strictly validate the selected change plus the repository specification graph.

**Verification:** `CI=true pnpm vitest run packages/core/tests packages/cli/tests packages/web/tests && CI=true pnpm build && CI=true pnpm test && CI=true pnpm lint && CI=true pnpm typecheck && git diff --check && openspec validate deepen-mutation-operation-adapters --strict && openspec validate --specs --strict`
