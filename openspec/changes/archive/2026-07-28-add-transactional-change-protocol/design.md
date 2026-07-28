## Context

Mutation currently spans generated target writes, state updates, settings, secrets, and revert operations without one concurrency or recovery boundary. A plan is useful for preview but is not yet a durable authorization bound to the store version and observed target state. This change builds on the target ownership model from `protect-target-ownership-and-revert` and remains Core-first through injected `Env` effects.

## Goals / Non-Goals

**Goals:**

- Prevent concurrent cellarer processes from mutating one store.
- Bind every applied mutation to an immutable plan and exact preconditions.
- Make interrupted operations observable and recoverable without guessing.
- Publish state only after target outcomes are durably known.
- Distinguish intended-state divergence from post-apply target drift.
- Return stable typed failures suitable for human and machine callers.

**Non-Goals:**

- Distributed transactions across remote systems.
- Guaranteeing atomic replacement of multiple unrelated filesystem targets.
- CLI JSON presentation; that belongs to `standardize-agent-cli-protocol`.
- Secret content policy; that belongs to `enforce-reference-only-secrets`.
- Backward compatibility for unreleased direct-mutation APIs.

## Decisions

### Use a store-scoped lease lock with owner metadata

Every mutation acquires an exclusive lock under the cellarer store containing operation ID, process metadata, and acquisition time. A live lock blocks immediately with a typed conflict; an apparently abandoned lock is never deleted merely by age and is resolved through recovery after inspecting the journal.

This is preferred over an in-process mutex because multiple CLI/Web processes can share the store. The primitive will be exposed through `Env` so platform-specific implementation does not enter business logic.

### Treat plans as immutable change receipts

A mutation plan will contain `schemaVersion`, `planId`, `operation`, `baseRevision`, normalized inputs, target preconditions, ordered actions, expiry, and a canonical digest. Apply receives this plan, verifies its digest and current preconditions under the lock, and never silently replans.

This makes dry-run output meaningful to agents and humans. A convenience call may plan and immediately apply, but Core still crosses the same receipt boundary.

### Journal intent before target mutation

After validation and before the first write, Core persists an operation journal containing the plan and pending action list. It durably records each action outcome and then atomically publishes the next state revision. The completed journal becomes an operation receipt and may be compacted according to a retention policy.

The journal is preferred over optimistic state-only writes because it can distinguish “nothing started,” “partially mutated,” and “state committed” after a crash.

### Recover by observed evidence, not replay by default

Recovery compares each journal action's before/after receipts with disk. It finalizes state if all after-receipts are present, compensates only actions with a verified restorable before-state, and otherwise stops with a typed manual-recovery report. It does not blindly rerun actions.

### Maintain one monotonic store revision

All state-changing operations, including settings and secret metadata updates, advance a store revision. Atomic temp-file replacement is used for state and journal publication. Revision and target precondition conflicts are separate error classes so callers know whether to replan or inspect drift.

### Expose two verification axes

Verification reports desired-versus-applied differences from current selections/configuration separately from applied-versus-disk drift proven by receipts. A green result requires both axes to converge and no incomplete journal.

## Risks / Trade-offs

- [A crashed lock holder can stop all later mutations] → Provide read-only diagnosis and explicit recovery bound to the matching journal instead of unsafe age-based lock removal.
- [Multi-target operations cannot be perfectly atomic] → Journal each verified transition and use compensation only when before-state is provable.
- [Canonical plan hashing can vary across runtimes] → Define one versioned canonical JSON encoding and golden fixtures.
- [Journals and snapshots can grow] → Retain compact operation receipts and garbage-collect only data unreachable from current ownership or recovery state.

## Migration Plan

1. Add plan, revision, journal, and typed error models with golden fixtures.
2. Add `Env` locking and atomic persistence primitives plus process-concurrency tests.
3. Route apply and revert through the protocol while temporarily adapting existing callers.
4. Add recovery and verification, then remove direct mutating entry points.
5. Reset development stores that cannot acquire a valid initial revision after backing them up.

Rollback requires finishing or manually resolving any active journal, then restoring the prior binary and its compatible store backup. A store with a newer revision/journal schema must not be opened by the prior build.

## Open Questions

None. Lock implementation details may vary by platform, but the Core protocol and failure semantics are fixed by this change.
