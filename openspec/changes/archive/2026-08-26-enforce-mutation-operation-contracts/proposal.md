## Why

The mutation operation registry currently checks only a coarse operation label and an action-kind allowlist. An authorized plan can therefore pass the shared adapter boundary with missing, extra, reordered, or mutation-kind-incompatible actions and reach product observation before a domain decoder rejects it, which does not satisfy the accepted fail-closed adapter contract.

## What Changes

- Add a statically composed, closed mutation-contract catalog beneath the existing operation registry so each executable plan is selected and validated by its exact typed domain contract.
- Reuse pure domain plan decoders at both the adapter boundary and the domain apply path so canonical action ordering, intent fields, and provenance constraints have one implementation.
- Keep authority and integrity verification ahead of semantic contract validation, and keep all product observation, locks, journals, providers, and effects after it.
- Separate executable action contracts from recovery-only historical action recognition so `scan-*` evidence cannot become an executable Store import.
- Preserve existing plan bytes, signatures, operation discriminants, receipts, Store data, CLI/API schemas, and valid no-op behavior.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mutation-operation-adapters`: Make the accepted closed semantic-validation requirement explicit at the per-mutation-contract level, including exact ordered action validation and recovery-only action isolation.

## Impact

This change affects internal `@cellarer/core` mutation protocol composition and the pure decoders used by Store, settings, secrets, Inventory, resource, sync, apply, and revert mutations. It adds no dependency, public API, wire-format, plan-format, or Store-format migration.

## Non-goals

- Changing mutation policy, user-visible mutation results, or canonical plan serialization.
- Adding runtime adapter or mutation-contract registration.
- Replacing domain currentness checks or moving side effects out of the shared execution kernel.

## Execution Contract

- Risk: high
- Depends on: none
- Allowed paths: `openspec/changes/enforce-mutation-operation-contracts/**`, `openspec/specs/mutation-operation-adapters/spec.md`, `packages/core/src/protocol/**`, `packages/core/src/store/**`, `packages/core/src/engine/**`, `packages/core/src/resources/**`, `packages/core/src/inventory/**`, `packages/core/src/sync/**`, `packages/core/src/secrets/**`, `packages/core/src/control-plane-mutations.ts`, `packages/core/tests/**`
