## 1. Store Layout Grammar

- [ ] 1.1 Inventory every current Store path helper and ad hoc managed-path join, and add compatibility tests for the existing on-disk layout.
- [ ] 1.2 Implement an immutable canonical `StoreLayout` value with named paths, containment checks, and physical Store identity.
- [ ] 1.3 Migrate Store/config/ledger/profile/journal/resource path consumers incrementally and add an architecture guard against new ad hoc Store-relative joins.

## 2. Coherent Observation

- [ ] 2.1 Add failing fake-Env tests for revision changes between config, registry, ledger, profile, and operation-evidence reads.
- [ ] 2.2 Implement base and selected-layer Store snapshots with before/after revision observation, bounded retry, immutable parsed values, and typed stale-snapshot results.
- [ ] 2.3 Add alias, symlink/reparse-point, missing-file, malformed-component, and reference-only secret tests for snapshot construction.

## 3. Consumer Migration

- [ ] 3.1 Migrate control-plane summary, resource/agent/collection/config, dashboard, status, diff, verify, and operation reads to coherent snapshots.
- [ ] 3.2 Migrate mutation planners to bind snapshot revision and provenance without holding mutation locks during ordinary reads.
- [ ] 3.3 Remove superseded read helpers only after parity tests prove equivalent DTOs, conflicts, and path evidence.

## 4. Verification

- [ ] 4.1 Run focused Store, control-plane, dashboard, protocol-revision, alias, source-safety, and concurrent-reader/writer tests.
- [ ] 4.2 Run full build/test/lint/typecheck gates, `git diff --check`, and strict validation for this and all OpenSpec changes.
