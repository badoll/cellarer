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

## Proof Obligations

1. **Exact selection:** planning accepts one explicit non-empty candidate-ID set, refreshes the declared scope, and either seals precisely those eligible identities or returns a typed failure without an executable plan.
2. **Authority before observation:** apply authenticates the unchanged plan envelope and validates its import-only action shape before reading the Store, candidate sources, providers, or agent targets.
3. **Restart-safe execution:** the serialized receipt contains the normalized request, candidate identities, source preconditions, Store identity and revision, reference-only publications, provenance, guarded final bytes, and action set needed by a replacement process.
4. **Atomic Store transition:** a successful batch commits its resource revisions, provenance, collection membership, activity, journal, operation receipt, and recovery evidence in one Store revision; a failed precondition publishes none of the batch.
5. **Zero distribution authority:** Core import does not receive or invoke an agent-target adapter or secret-provider capability, and semantic validation rejects target actions before product observation.
6. **Drift closure:** source fingerprints and the coherent Store revision are revalidated inside the mutation boundary; drift returns a stable typed result requiring a fresh plan.
7. **Reference-only safety:** recursive source, symlink, secret-classification, plan/body budget, and guarded-final-byte protections remain at least as strict as the existing safe publication path.
8. **Owned-path closure:** every live implementation, focused-test, delta-sync, and archive path belongs to the reconciled Execution Contract before work proceeds; another same-class path mismatch stops the change rather than extending scope ad hoc.

## Attack Matrix

| Attack or fault | Required outcome | Focused evidence |
| --- | --- | --- |
| Omitted, duplicate, unknown, conflicted, blocked, stale, or secret-bearing selection | Planning returns a typed failure and does not emit an executable receipt | Planning contract tests |
| Any executable receipt byte is altered | Authority or semantic validation fails before product observation | Tamper and observation-sentinel tests |
| A target action is injected into an otherwise authentic import shape | Import-specific validation rejects the complete plan | Action-set injection test |
| Source content or Store revision changes after planning | Apply publishes no resource and returns the corresponding stale result | Drift and atomicity tests |
| Apply runs in a replacement process | The unchanged receipt applies without refresh, selection, grouping, or process-local handles | Replacement-process test |
| A publication fails after transaction preparation | Journal recovery preserves the pre-operation Store or completes the authorized revision without a partial batch | Recovery fault-injection test |
| A target or provider adapter is wired to import | Capability construction or observation sentinel proves zero calls | Negative capability test |
| A remaining task, delta sync, or archive operation resolves outside the reconciled owned paths | Stop before editing and report the repeated contract failure; do not add another patch-wave scope exception | Fresh owned-path audit plus preflight |

## State Matrix

| State | Permitted transition | Receipt or result |
| --- | --- | --- |
| Explicit eligible selection plus coherent Store snapshot | `requested -> planned` | Authority-sealed serializable import plan |
| Invalid selection or unsafe captured publication | `requested -> rejected` | Typed input, conflict, or safety result; no plan |
| Current authentic import plan | `planned -> applying -> committed` | One Store operation receipt and revision |
| Tampered or import-shape-invalid plan | `planned -> rejected` | Stable invalid-plan or authority result before observation |
| Source or Store drift | `planned -> stale` | Typed stale-candidate or stale-revision result; no publication |
| Prepared transaction interrupted | `applying -> recovered` or `applying -> committed` | Journal-backed recovery evidence; no partial visible batch |
| Completed implementation with reconciled owned paths | `verified -> synced -> archived` | Full gates, strict validation, delta sync, archive, and post-archive verification |

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
