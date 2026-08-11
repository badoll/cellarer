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

## Risks / Trade-offs

- **[Risk] Abstraction hides security ordering.** → Keep authority and kernel ordering outside adapters and assert spies at the registry boundary.
- **[Risk] A universal adapter type becomes an untyped bag.** → Use generic associated input/receipt types and a small closed lifecycle; operation-specific details remain in domain modules.
- **[Trade-off] Some duplication remains.** → Remove only identical choreography; domain-specific validation is intentional.

## Migration Plan

1. Freeze canonical/effect characterization for every operation.
2. Add adapter contracts and registry with no migrated external behavior.
3. Migrate operation families sequentially and delete only proven-dead helpers.
4. Add forbidden bypass and exhaustive registry tests.
5. Roll back a family by restoring its former adapter implementation behind the same public operation.

## Open Questions

None.
