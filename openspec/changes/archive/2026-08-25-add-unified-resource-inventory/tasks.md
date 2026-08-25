## 1. Enumeration and Failure Boundaries

- [x] 1.1 Add failing Core tests for the registered built-in/custom source fixture, enabled/detected independence, bounded user/project roots, exact adapter filters, absent paths, and source/candidate partial failures.
- [x] 1.2 Add a deterministic regression fixture with a disabled registered adapter and a populated shared `~/.agents/skills`-style path so hidden shared Skills cannot regress.
- [x] 1.3 Implement `SourceEnumerator` and bounded refresh orchestration using injected `Env`, the adapter registry, canonical project input, deterministic ordering, and bounded concurrency.

**Verification:** `CI=true pnpm exec vitest run packages/core/tests/inventory-enumeration.test.ts`

## 2. Inspection, Identity, and Projection

- [x] 2.1 Add failing tests for no-follow snapshots, recursive secret/structure guards, unsafe links, normalization, physical-source collapse, semantic merging, conflicts, and candidate-local findings.
- [x] 2.2 Implement `CandidateInspector` by extracting reusable read-only snapshot/normalization primitives without importing Store mutation or protected-provider capabilities.
- [x] 2.3 Implement `CandidateGrouper` with versioned kind/name/fingerprint identities, full provenance retention, conflict groups, and stable deterministic result order.
- [x] 2.4 Implement `InventoryProjector` against one coherent Store snapshot with `ready`/`needs-attention`/`in-store`, default selection, counts, and complete/partial/failed completeness.
- [x] 2.5 Add browser-safe public Inventory DTOs and closed finding codes without plaintext or reversible secret derivatives.

**Verification:** `CI=true pnpm exec vitest run packages/core/tests/inventory-inspection.test.ts packages/core/tests/inventory-projection.test.ts`

## 3. CLI and Local API Read Surface

- [x] 3.1 Add `inventory refresh` full/targeted command contracts, human rendering, JSON/JSONL envelopes, closed schemas, capabilities, and prompt-free machine tests.
- [x] 3.2 Add authenticated `/api/v1` full/targeted Inventory routes, registry/OpenAPI/schema parity, body/path validation, and partial-result tests.
- [x] 3.3 Add bundled client API functions and a read-only Inventory view sufficient to exercise the shared DTO while leaving first-run migration out of scope.
- [x] 3.4 Document the available CLI and local API read surface in aligned English and Simplified Chinese public docs.

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/inventory-command.test.ts packages/cli/tests/inventory-protocol.test.ts packages/web/tests/inventory-api.test.ts packages/web/tests/inventory-page.test.ts`

## 4. Safety and Performance Verification

- [x] 4.1 Prove refresh performs zero Store/source/target/provider/authority/activity writes with capability spies and observable-secret canaries.
- [x] 4.2 Run focused Inventory, adapter, safe-tree, secret-guard, control-plane, CLI protocol, API contract, Web bundle, and built-Hono browser tests.
- [x] 4.3 Measure bounded fixture latency and peak concurrency without introducing a cache or watcher.

**Verification:** `CI=true pnpm exec vitest run packages/core/tests/inventory-safety.test.ts packages/core/tests/inventory-performance.test.ts packages/cli/tests/inventory-protocol.test.ts packages/web/tests/inventory-api.test.ts packages/web/tests/inventory-page.test.ts`

## 5. Completion Gates

- [x] 5.1 Run a read-only real-machine acceptance showing the registered bounded user-source fixture is visible independently of enabled state and no observable value leaks.
- [x] 5.2 Run the repository build/test/lint/typecheck closure gates, review the owned diff, run `git diff --check`, and strictly validate the selected OpenSpec change.

**Verification:** `CI=true pnpm build && CI=true pnpm test && CI=true pnpm lint && CI=true pnpm typecheck && git diff --check && openspec validate add-unified-resource-inventory --strict --no-interactive`
