## Why

Current apply and revert operations mutate targets sequentially and record state afterward, so concurrent commands, stale dry-run output, or process interruption can leave disk state and `state.json` disagreeing. After establishing physical target ownership, cellarer needs a durable change protocol before expanding its CLI control plane.

## What Changes

- Add an exclusive store mutation lock and monotonic store revision for all state-changing Core operations.
- Make mutating plans immutable, identifiable receipts with a base revision, target preconditions, expiry policy, and deterministic action digest.
- Require apply to consume and validate the planned receipt instead of silently recalculating actions.
- Add a write-ahead operation journal, per-action outcomes, atomic state publication, and deterministic recovery for interrupted operations.
- Add desired-versus-applied and applied-versus-disk verification results with typed conflicts and recovery guidance.
- **BREAKING**: replace best-effort direct apply/revert entry points with the planned mutation protocol and reject stale or unverifiable plans.

## Capabilities

### New Capabilities
- `transactional-local-mutations`: Versioned plans, exclusive mutation, journaling, recovery, verification, and typed operation results for local state changes.

### Modified Capabilities

None. This repository does not yet contain accepted capability specs to modify.

## Impact

This change follows `protect-target-ownership-and-revert` and affects Core plan/apply/revert APIs, `Env`, store/state persistence, recovery and doctor services, and the thin CLI/Web callers. It introduces no remote service and no production dependency by default; any locking implementation must remain local and cross-platform within the supported Node.js runtime.
