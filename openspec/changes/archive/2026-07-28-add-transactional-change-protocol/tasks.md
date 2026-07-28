## 1. Protocol Models

- [x] 1.1 Add failing tests and golden fixtures for canonical plan encoding, digests, typed conflicts, journals, and operation receipts
- [x] 1.2 Implement versioned immutable plan, action precondition, store revision, journal, and operation result types
- [x] 1.3 Extend `Env` with the minimal exclusive-lock and durable atomic-publication primitives

## 2. Exclusive Planning and Apply

- [x] 2.1 Add cross-process tests proving one mutation per store and safe handling of an abandoned lock
- [x] 2.2 Implement the store-scoped mutation lock with owner evidence and no age-only lock deletion
- [x] 2.3 Bind apply to plan digest, base revision, expiry, and target preconditions under the lock
- [x] 2.4 Route apply and revert through the receipt boundary and remove direct mutation paths

## 3. Journaling and Recovery

- [x] 3.1 Add interruption tests at every boundary between journal creation, target actions, state publication, and lock release
- [x] 3.2 Persist write-ahead intent and per-action receipts before atomically publishing the next state revision
- [x] 3.3 Implement evidence-based finalize, compensate, and manual-recovery outcomes
- [x] 3.4 Add doctor/recovery Core services and journal or snapshot retention rules

## 4. Verification and Callers

- [x] 4.1 Implement separate desired-versus-applied and applied-versus-disk verification results
- [x] 4.2 Adapt CLI and Web callers to surface plan IDs, revisions, operation receipts, and typed recovery errors
- [x] 4.3 Add integration tests for stale plans, target drift, partial failure, and successful recovery

## 5. Documentation and Gates

- [x] 5.1 Document plan/apply receipts, concurrency behavior, recovery procedures, and verification axes in synchronized public docs
- [x] 5.2 Run relevant Core, CLI, and Web tests, then run `pnpm lint`, `pnpm typecheck`, and `pnpm build`
