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

## Migration Plan

1. Add Core fixtures reproducing hidden shared user sources and partial failures.
2. Implement the four units and public DTOs.
3. Add CLI and `/api/v1` read routes while legacy discovery/scan remains available.
4. Run a read-only real-machine acceptance after deterministic tests.
5. Rollback removes the new read surface; no persisted state changed.

## Open Questions

None.
