## Context

Unified Inventory deliberately observes without authority or writes. The current `scan` path combines per-agent discovery with a default Store mutation, which is the semantic coupling being removed. This change adds an independent import operation while leaving initialization and legacy-surface deletion for the later migration change.

## Goals / Non-Goals

**Goals:**

- Bind exact reviewed candidates to one immutable executable Store plan.
- Reuse the existing authority, lock, journal, receipt, recovery, and final-byte kernel.
- Guarantee zero agent-target effects.

**Non-Goals:**

- Do not infer candidate selection, adopt secrets, prompt from init, or redesign Store resources.

## Decisions

### Planning refreshes exact IDs and captures publications

The planning request contains an explicit non-empty candidate-ID set plus refresh scope. Core performs a current refresh, rejects missing or non-ready IDs, and transforms safe snapshots into normalized Store publications. The plan binds candidate IDs, all provenance preconditions required for trust, Store snapshot revision, normalized inputs, and final guarded publication bytes. An in-memory candidate registry was rejected because plans must survive a process restart.

### Apply never rediscovers intent

Apply verifies authority and exact operation semantics before product observation, then revalidates source and Store preconditions and executes the sealed publications. It does not refresh, select, regroup, or reconstruct conflict policy. Drift returns a typed stale-candidate or stale-revision result.

### One safe batch is atomic

All selected ready candidates publish in one Store mutation journal and one Store revision. Candidate-local inspection failures are excluded before planning; an apply-time precondition failure prevents publication. Best-effort partial import was rejected because it makes the user's confirmation ambiguous.

### Import and distribution remain different operations

The plan action set is limited to Store resource revisions, provenance, optional collection membership, activity, and transaction evidence. Any agent-target action makes semantic validation fail closed. Sync remains a later exact plan.

## Risks / Trade-offs

- **[Risk] Large Skill bytes make plans large.** → Enforce plan/body budgets and measure; do not weaken self-contained execution or use process-local handles.
- **[Risk] Duplicate managed matches race planning.** → Bind the coherent Store revision and revalidate under the mutation boundary.
- **[Trade-off] Planning performs a fresh scan.** → Correctness is preferred; callers use returned IDs as selection intent, not as a stale content cache.

## Migration Plan

1. Characterize reusable safe snapshot and Store publication primitives from scan.
2. Add Core plan/apply and adversarial authority/drift tests.
3. Add CLI and API contracts while old scan remains available.
4. Verify cross-process apply and zero target calls.
5. Rollback removes the import routes; Inventory remains read-only and Store format remains valid.

## Open Questions

None.
