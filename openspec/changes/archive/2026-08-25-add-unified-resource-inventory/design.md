## Context

Current discovery is fragmented: summary counts, the resource catalog, and `scan` each enumerate different shapes and can default to the persisted enabled-agent set. Registered shared sources such as `~/.agents/skills` can therefore disappear even though the adapter is known. This change supplies only the read model; mutation and first-run migration remain separate.

## Goals / Non-Goals

**Goals:**

- Observe every bounded registered source by default.
- Return one stable, redacted, deduplicated DTO across Core, CLI, API, and Web.
- Isolate failures and expose completeness without writes or protected-provider access.

**Non-Goals:**

- Do not import, sync, adopt secrets, prompt from init, remove legacy surfaces, crawl arbitrary roots, or cache results persistently.

## Decisions

### Compose four focused Core units

`SourceEnumerator` expands all registered adapter declarations for user scope and an optional canonical project root. `CandidateInspector` captures safe no-follow sources and returns typed local findings. `CandidateGrouper` performs physical and semantic deduplication. `InventoryProjector` joins the coherent Store snapshot and emits the public DTO. One monolithic scan engine was rejected because enumeration, inspection, identity, and presentation have different failure boundaries.

### Registration defines visibility; enabled does not

Default refresh includes every registered built-in and configured custom adapter. Enabled and detection states remain source metadata. An explicit adapter filter narrows a targeted refresh. This follows the distinction between “can observe” and “may distribute”.

Registry composition for refresh derives from the configuration already captured by the coherent Store snapshot. It may read the immutable packaged adapter catalog, but it does not reread mutable user configuration. Reusing the ordinary independently loading registry was rejected because custom adapter definitions and enabled metadata could otherwise come from different revisions.

### Candidate identity excludes provenance multiplicity

A versioned candidate ID derives from kind, normalized logical name, and canonical content fingerprint. Equivalent sources merge while retaining every redacted provenance entry; adding a source does not change identity. Same kind/name with different fingerprints forms a conflict group. Path-based IDs were rejected because aliases and shared pools make paths unstable product identity.

### Refresh is live and failure-isolated

Missing declared paths are empty evidence. Unreadable paths, unsafe links, invalid structures, and secret findings remain visible and local. Completeness is `complete`, `partial`, or `failed`. Bounded concurrency avoids serial Skill traversal without making result ordering nondeterministic.

### Project only transport-neutral data

Core owns closed DTOs and finding codes in the browser-safe contract closure. CLI and API add transport envelopes only; Web never reimplements grouping, safety, or managed matching.

## Risks / Trade-offs

- **[Risk] Live Skill scans are slow.** → Bound concurrency, collapse physical sources before repeated inspection when safe, measure latency, and defer caching until justified.
- **[Risk] Normalization merges intentional variants.** → Include kind and logical name in identity and preserve conflict/source details.
- **[Risk] One adapter throws outside candidate isolation.** → Catch at registry, adapter, capability, source, and candidate boundaries with adversarial partial-result tests.

## Proof Obligations

1. **Bounded enumeration:** The canonical roots inspected by refresh are exactly the registered adapter declarations plus the optional explicit project root. Containment tests reject traversal, links, and aliases that escape those roots.
2. **Read-only execution:** Capability spies prove refresh invokes no Store, source, target, provider, authority, activity, or other mutation operation, including on partial and failed refreshes.
3. **Secret non-observability:** Observable-secret canaries prove DTOs, findings, transport envelopes, renderer output, errors, and logs contain neither plaintext secret values nor reversible derivatives.
4. **Failure isolation:** Injected failures at registry, adapter, capability, source, candidate, and Store-snapshot projection boundaries preserve safe candidates and yield deterministic `partial` or `failed` completeness.
5. **Stable identity and provenance:** Fixture permutations prove canonical content produces the same versioned candidate ID regardless of traversal order or equivalent provenance multiplicity, while content changes produce a distinct ID and conflicts remain explicit.
6. **Transport parity:** CLI schemas, `/api/v1` registry/OpenAPI schemas, client types, and the browser bundle consume the same closed Core DTO and finding-code set without transport-local regrouping.
7. **Bounded concurrency:** A deterministic latency fixture records peak inspection concurrency at or below the configured limit and proves result ordering is independent of completion order.

## Migration Plan

1. Add Core fixtures reproducing hidden shared user sources and partial failures.
2. Implement the four units and public DTOs.
3. Add CLI and `/api/v1` read routes while legacy discovery/scan remains available.
4. Run a read-only real-machine acceptance after deterministic tests.
5. Rollback removes the new read surface; no persisted state changed.

## Open Questions

None.
