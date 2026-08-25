## Context

`executeMutationPlan` is the correct generic transaction kernel, while apply, revert, sync, resource lifecycle, control-plane mutations, scan/import, and secret metadata each contain repeated code for normalizing intent, collecting provenance, constructing canonical actions, validating semantics, and projecting receipts. Replacing the kernel would discard mature safety work; leaving all repetition makes new operations inconsistent.

## Goals / Non-Goals

**Goals:**

- Make the domain-to-kernel boundary explicit and reusable.
- Migrate operations incrementally with byte- and effect-parity evidence.
- Preserve one generic execution and recovery kernel.

**Non-Goals:**

- Do not create a workflow DSL, erase domain plans, change plan bytes, or combine planning and apply.

## Decisions

### Define a narrow `MutationOperationAdapter`

An adapter owns operation code, normalized intent schema, observation/provenance builder, domain-plan-to-action translation, semantic validator, prepared effect factory, receipt projector, and recovery descriptor. The kernel continues to own authority verification, locks, current revision, journal sequencing, final-byte checks, effect execution, receipts, and compensation control.

### Domain plans remain first-class

Sync profiles, resource lifecycle proposals, Inventory selections, and revert targets express user intent before they become generic actions. They are retained and adapted; forcing all use cases to construct `MutationPlan` directly was rejected because it would leak protocol machinery into domain policy.

### Registration is exhaustive and closed

One operation registry maps stable operation discriminants to adapters. External plan validation first verifies authority, then selects the exact adapter, which validates the complete action set. Unknown or duplicate registration fails closed. Runtime plugin registration was rejected because executable mutation policy must be auditable.

### Migrate lowest-risk operations first

Config-only Store publications establish the seam, followed by resource operations, Inventory import, sync/apply/revert, and secret adoption. Each migration retains characterization fixtures for canonical plan bytes, zero-interaction invalid plans, call order, receipts, and recovery.

## Proof Obligations

| Boundary | Frozen invariant | Required attack or evidence |
| --- | --- | --- |
| Canonical plan | Adapter migration does not change normalized intent, sealed canonical bytes, authority scope, action order, or Store format. | Before/after characterization fixtures compare exact bytes and action sequences for the named operation families. |
| Authority first | External plans verify authority before adapter selection, product observation, locks, journals, or prepared effects. | Unknown, duplicate, cross-operation, extra, missing, and reordered-action attacks return the constant invalid-plan result with zero interaction. |
| Closed registry | Each executable operation discriminant has one statically composed adapter; custom agent or runtime configuration cannot install mutation policy. | Exhaustiveness checks cover the operation union, and duplicate/unknown registration tests fail closed. |
| Kernel ownership | `executeMutationPlan` remains the only component that checks currentness, acquires locks, sequences journals, invokes prepared effects, publishes receipts, and controls compensation/recovery. | Effect spies assert the kernel order and architecture tests reject direct Store, target, provider, journal, or recovery invocation from adapter/domain paths. |
| Operation semantics | Adapters validate typed intent and the complete action set without consulting message or reason text. | Message/reason mutations preserve decisions; foreign and structurally altered actions are rejected before effects. |
| Locking and journal | Lock acquisition, revision checks, prepared/committed journal transitions, and terminal action ordering remain unchanged. | Conflict and failure-injection traces compare exact ordering for Store publication, target mutation, provider mutation, and rollback cases. |
| Receipt and recovery | Receipt projection, durable recovery metadata, compensation authority, ownership, drift, snapshots, and replay behavior remain operation-equivalent. | Success, conflict, interrupted, compensated, and recovery fixtures compare receipt/recovery results before and after each family migration. |
| Reference-only secrets | Secret values never enter normalized intent, canonical bytes, actions, journals, receipts, recovery evidence, logs, argv, CLI/API results, or Store artifacts. | Unique-value canaries cover Inventory secret adoption and secret-metadata/provider paths, including failures and recovery. |
| Boundary parity | CLI and loopback API keep their existing result mapping and do not gain mutation-policy authority. | Focused CLI/API parity tests compare success and constant failure projections with Core results. |

A task group may check off migration only when its rows above have fresh focused evidence. One repair wave may address related findings. A repeated Important or Critical class requires a design-level artifact correction before another implementation attempt.

## Risks / Trade-offs

- **[Risk] Abstraction hides security ordering.** → Keep authority and kernel ordering outside adapters and assert spies at the registry boundary.
- **[Risk] A universal adapter type becomes an untyped bag.** → Use generic associated input/receipt types and a small closed lifecycle; operation-specific details remain in domain modules.
- **[Trade-off] Some duplication remains.** → Remove only identical choreography; domain-specific validation is intentional.

## Migration Plan

1. Freeze canonical/effect characterization for the operation families named in the task slices.
2. Add adapter contracts and registry with no migrated external behavior.
3. Migrate operation families sequentially and delete only proven-dead helpers.
4. Add forbidden bypass and exhaustive registry tests.
5. Roll back a family by restoring its former adapter implementation behind the same public operation.

## Open Questions

None.
