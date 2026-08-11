## Context

Store reads are spread across config, ledger, registry, profiles, receipts, diagnostics, and engines, with many modules rebuilding paths. Revision helpers protect particular operations, but control-plane projections can still be assembled from independently timed reads. Inventory requires a stable managed-match decision and import planning must bind exactly the state the user reviewed.

## Goals / Non-Goals

**Goals:**

- Centralize canonical Store path knowledge.
- Provide one immutable coherent observation for read models and planners.
- Make provenance and drift semantics explicit and testable.

**Non-Goals:**

- Do not change on-disk layout, add persistence, or hold mutation locks for ordinary reads.
- Do not make snapshots executable mutation plans.

## Decisions

### Introduce `StoreLayout` as a value object

One canonicalized Store root produces typed paths for config, revision, resource roots, metadata, ledger, profiles, journals, receipts, snapshots, locks, and secret metadata. Domain modules request named paths rather than joining Store-relative strings. A bag of constants was rejected because it cannot bind canonical root identity or validate containment.

### Observe revision before and after bounded reads

`observeStoreSnapshot` reads the protected revision descriptor, captures the selected immutable components with safe no-follow guards, then re-reads the revision. A mismatch retries a small bounded number of times or returns `STALE_STORE_SNAPSHOT`. Holding the mutation lock was rejected because read-only dashboards and Inventory should not block writers.

### Separate snapshot layers

A base snapshot contains canonical identity, revision, config, registry, and ledger; optional selectors add profiles or operation evidence only when needed. All layers share one observed revision and provenance set. Loading every receipt for every read was rejected for cost and unnecessary privilege.

### Snapshot values are immutable and reference-only
Parsed values are deeply immutable or treated as immutable data, and snapshot DTOs contain reference names and fingerprints only. Provider values are never part of Store observation.

## Risks / Trade-offs

- **[Risk] Writers not advancing revision create false coherence.** → Audit every durable Store publication and test that it advances or is explicitly outside product-state semantics.
- **[Risk] Central layout becomes a god object.** → Keep it path-only; parsing and domain rules stay in their owning modules.
- **[Trade-off] Retry can repeat filesystem work.** → Bound attempts and return typed staleness instead of unbounded waiting.

## Migration Plan

1. Add `StoreLayout` and compatibility tests against every current path helper.
2. Add snapshot consistency and race tests.
3. Migrate control-plane reads, then planners, one domain at a time.
4. Ban new ad hoc Store joins and remove superseded helpers.
5. Rollback retains the unchanged on-disk format.

## Open Questions

None.
