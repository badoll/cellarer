## 1. Characterization and Adapter Contract

- [ ] 1.1 Capture canonical plan bytes, authority scope, ordered effect traces, conflicts, receipts, and recovery for every current mutation operation family.
- [ ] 1.2 Define the typed `MutationOperationAdapter` lifecycle and closed exhaustive registry while keeping authority verification, locks, journals, execution, receipts, and recovery in the existing kernel.
- [ ] 1.3 Add failing tests for unknown/duplicate registrations, cross-operation actions, message/reason-based policy, and direct Store/target/provider effect bypasses.

## 2. Low-risk Store Operation Migration

- [ ] 2.1 Migrate config, built-in/custom adapter, collection, and ordinary Store publication operations with before/after canonical and effect parity.
- [ ] 2.2 Migrate resource create/update/rename/remove and profile mutations while preserving immutable identity, dependency checks, provenance, and receipts.
- [ ] 2.3 Delete only duplicated choreography proven equivalent and keep operation-specific domain validation in its owning module.

## 3. Target, Inventory, and Secret Operation Migration

- [ ] 3.1 Migrate Inventory import and secret adoption adapters with exact source/provider semantics and reference-only canaries.
- [ ] 3.2 Migrate sync apply/uninstall, ordinary apply, and revert while preserving ownership, gitignore terminal actions, snapshots, drift, and recovery.
- [ ] 3.3 Migrate secret-metadata and mutation-authority lifecycle operations without expanding ordinary provider capability or weakening authority-first ordering.

## 4. Kernel and Dependency Cleanup

- [ ] 4.1 Remove superseded per-operation kernel wrappers, repeated canonical validation, and duplicated receipt projection after every family passes parity.
- [ ] 4.2 Enforce that domain modules depend on adapter contracts and that only the registry/kernel composition can invoke prepared mutation effects.
- [ ] 4.3 Measure module size, dependency cycles, and duplicated choreography against the baseline without using line count alone as a completion criterion.

## 5. Completion Gates

- [ ] 5.1 Run focused mutation-authority, canonical plan, store-mutation, apply/revert/sync, Inventory, resource, secret, journal/recovery, CLI/API parity, and zero-interaction tests.
- [ ] 5.2 Run full build/test/lint/typecheck gates, review the owned diff, run `git diff --check`, and strictly validate this and all OpenSpec changes.
