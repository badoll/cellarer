## 1. Enumeration and Failure Boundaries

- [ ] 1.1 Add failing Core tests for every built-in/custom registered source, enabled/detected independence, bounded user/project roots, exact adapter filters, absent paths, and source/candidate partial failures.
- [ ] 1.2 Add a deterministic regression fixture with a disabled registered adapter and a populated shared `~/.agents/skills`-style path so hidden shared Skills cannot regress.
- [ ] 1.3 Implement `SourceEnumerator` and bounded refresh orchestration using injected `Env`, the adapter registry, canonical project input, deterministic ordering, and bounded concurrency.

## 2. Inspection, Identity, and Projection

- [ ] 2.1 Add failing tests for no-follow snapshots, recursive secret/structure guards, unsafe links, normalization, physical-source collapse, semantic merging, conflicts, and candidate-local findings.
- [ ] 2.2 Implement `CandidateInspector` by extracting reusable read-only snapshot/normalization primitives without importing Store mutation or protected-provider capabilities.
- [ ] 2.3 Implement `CandidateGrouper` with versioned kind/name/fingerprint identities, full provenance retention, conflict groups, and stable deterministic result order.
- [ ] 2.4 Implement `InventoryProjector` against one coherent Store snapshot with `ready`/`needs-attention`/`in-store`, default selection, counts, and complete/partial/failed completeness.
- [ ] 2.5 Add browser-safe public Inventory DTOs and closed finding codes without plaintext or reversible secret derivatives.

## 3. CLI and Local API Read Surface

- [ ] 3.1 Add `inventory refresh` full/targeted command contracts, human rendering, JSON/JSONL envelopes, closed schemas, capabilities, and prompt-free machine tests.
- [ ] 3.2 Add authenticated `/api/v1` full/targeted Inventory routes, registry/OpenAPI/schema parity, body/path validation, and partial-result tests.
- [ ] 3.3 Add bundled client API functions and a read-only Inventory view sufficient to exercise the shared DTO while leaving first-run migration out of scope.

## 4. Safety and Performance Verification

- [ ] 4.1 Prove refresh performs zero Store/source/target/provider/authority/activity writes with capability spies and observable-secret canaries.
- [ ] 4.2 Run focused Inventory, adapter, safe-tree, secret-guard, control-plane, CLI protocol, API contract, Web bundle, and built-Hono browser tests.
- [ ] 4.3 Measure bounded fixture latency and peak concurrency without introducing a cache or watcher.

## 5. Completion Gates

- [ ] 5.1 Run a read-only real-machine acceptance showing all registered bounded user sources are visible independently of enabled state and no observable value leaks.
- [ ] 5.2 Run full build/test/lint/typecheck gates, review the owned diff, run `git diff --check`, and validate this and all OpenSpec changes strictly.
