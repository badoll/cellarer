## 1. Closed contract resolver

- [x] 1.1 Add red-path protocol tests for unknown mutation kinds, missing/extra/duplicated/reordered actions, cross-contract action mixing, executable recovery-only actions, and zero product interactions on rejection.
- [x] 1.2 Implement the frozen mutation-contract types, exact registry construction, selector, normalized-intent helpers, and resolver integration without changing canonical plan bytes.
- [x] 1.3 Route characterization through the selected contract and retain duplicate, missing, and unknown operation registration failures.

**Verification:** `CI=true pnpm exec vitest run packages/core/tests/mutation-operation-adapters.test.ts packages/core/tests/mutation-operation-characterization.test.ts packages/core/tests/mutation-operation-architecture.test.ts`

## 2. Store-backed mutation contracts

- [x] 2.1 Add and share pure contracts for initialize, settings control-plane/profile, and secret-metadata plans, including exact input keys, provenance, publication order, and contract-specific no-op policy.
- [x] 2.2 Add and share pure contracts for add, resource update, Inventory Store import, and Inventory secret adoption plans, binding dynamic action groups to normalized intent.
- [x] 2.3 Remove historical `scan-mcp`, `scan-rules`, and `scan-skills` from executable Store-import contracts while retaining their recovery descriptors.

**Verification:** `CI=true pnpm exec vitest run packages/core/tests/init.test.ts packages/core/tests/control-plane-mutations.test.ts packages/core/tests/sync-profiles.test.ts packages/core/tests/mutation-authority.test.ts packages/core/tests/inventory-store-import-planning.test.ts packages/core/tests/inventory-store-import-apply.test.ts packages/core/tests/inventory-secret-adoption-planning.test.ts packages/core/tests/inventory-secret-adoption-apply.test.ts packages/core/tests/resource-lifecycle-update.test.ts`

## 3. Target and resource mutation contracts

- [x] 3.1 Add and share fixed pure contracts for apply and revert plans, preserving valid converged action sets and the existing action/precondition ordering.
- [x] 3.2 Add and share exact resource-lifecycle and sync-uninstall contracts, including mutation-kind selection and plan-defined no-op behavior.
- [x] 3.3 Re-run canonical-plan, receipt, conflict, recovery, and ordered-effect characterization for the migrated operation families.

**Verification:** `CI=true pnpm exec vitest run packages/core/tests/transactional-apply.test.ts packages/core/tests/revert-plan.test.ts packages/core/tests/engine.test.ts packages/core/tests/resource-lifecycle-mutations.test.ts packages/core/tests/mutation-operation-characterization.test.ts packages/core/tests/closure-hardening.test.ts`

## 4. Integration closure

- [x] 4.1 Perform one combined and adversarial review against the proof obligations, repair confirmed findings within allowed paths, and re-run only affected focused tests.
- [x] 4.2 Validate the change and run the closure gate: `openspec validate enforce-mutation-operation-contracts --strict --no-interactive`, `CI=true pnpm build`, `CI=true pnpm test`, `CI=true pnpm lint`, `CI=true pnpm typecheck`, and `git diff --check`.

**Verification:** The strict OpenSpec validation and each closure command exit successfully with no test, build, lint-error, typecheck, or whitespace failure.
