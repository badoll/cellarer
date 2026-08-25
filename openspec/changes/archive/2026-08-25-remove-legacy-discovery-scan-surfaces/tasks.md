## 1. Dependency and Removal-manifest Gate

**Verification:** `pnpm openspec:preflight --change remove-legacy-discovery-scan-surfaces`

- [x] 1.1 Confirm `unify-cli-command-contracts`, `add-unified-resource-inventory`, `add-inventory-store-import`, and `replace-init-with-unified-inventory` are synced, archived, and independently validated.
- [x] 1.2 Refresh and freeze the design's exact CLI command, schema ID, API route, client call, Core symbol, resource projection, and recovery-only retention manifest against the post-dependency tree.

## 2. Retained Resource and Inventory Parity

**Verification:** `CI=true pnpm exec vitest run packages/core/tests/resource-catalog.test.ts packages/core/tests/discovery.test.ts packages/core/tests/scan.test.ts -t "parity|Inventory|inventory"`

- [x] 2.1 Add failing parity tests that bind retained resource identity, provenance, findings, redaction, and selection presentation to the accepted Inventory use cases rather than scan orchestration.
- [x] 2.2 Migrate retained first-party resource projections to the accepted Inventory/domain-owned observation boundary and prove they no longer import legacy discovery-summary or scan mutation orchestration.

## 3. CLI Contract Removal

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/discovery.test.ts packages/cli/tests/scan-command.test.ts packages/cli/tests/protocol-conformance.test.ts`

- [x] 3.1 Add failing negative tests for absent discovery-summary/scan leaves, capability entries, schema IDs, argv options, renderers, and aliases; assert rejection occurs before Core or mutation-authority use.
- [x] 3.2 Remove the legacy CLI registrations and authoritative command-contract surfaces while preserving `capabilities`, `schema`, Inventory refresh/import, resource, and Sync commands.

## 4. Local API and Bundled-client Removal

**Verification:** `CI=true pnpm exec vitest run packages/web/tests/api-contract-registry.test.ts packages/web/tests/api-contract.test.ts packages/web/tests/client-api.test.ts packages/web/tests/client-imports.test.ts`

- [x] 4.1 Add failing route/OpenAPI/schema/client-type tests for not-found discovery-summary, scan, and scan-backed import shapes, including captured-plan rejection and zero Core invocation.
- [x] 4.2 Remove the legacy route registrations, schemas, handlers, browser-safe types, bundled client calls/state/actions, and fixtures without translating requests to Inventory or changing accepted Inventory routes.

## 5. Core Public Surface and Recovery Boundary

**Verification:** `CI=true pnpm exec vitest run packages/core/tests/public-api.test.ts packages/core/tests/package-exports.test.ts packages/core/tests/transaction-recovery.test.ts`

- [x] 5.1 Add failing root/subpath/declaration/packed-consumer tests for removed discovery/scan public symbols plus recovery tests that preserve typed manual-only diagnosis for historical scan evidence.
- [x] 5.2 Remove public Core discovery/scan exports and dead orchestration after consumer migration; retain only generic non-advertised journal recognition and no legacy decoder/executor.

## 6. Mutation and Secret Attack Matrix

**Verification:** `CI=true pnpm exec vitest run packages/core/tests/mutation-authority.test.ts packages/core/tests/public-secret-boundary.test.ts packages/cli/tests/mutation-authority.test.ts packages/web/tests/api-contract.test.ts`

- [x] 6.1 Add negative tests for captured legacy plans, removed inputs, authority non-consumption, no implicit replanning, no external effects, and secret canaries across errors, logs, schemas, and client responses.
- [x] 6.2 Execute the design attack matrix against the final removal diff and repair the first finding wave within the declared paths; stop and revise the design if the same Important/Critical class recurs.

## 7. Public Migration Guidance

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/discovery.test.ts packages/cli/tests/scan-command.test.ts packages/web/tests/client-api.test.ts`

- [x] 7.1 Update English and Simplified Chinese docs with exact Inventory refresh/import plan/apply replacements, removed command/route behavior, and separate Sync guidance verified against command contracts and package metadata.

## 8. Change Closure

**Verification:** full repository and OpenSpec gates

- [x] 8.1 Run `openspec validate --all --strict --no-interactive` and confirm the modified requirements match the then-current main specs and frozen removal manifest.
- [x] 8.2 Run `CI=true pnpm build`, `CI=true pnpm test`, `CI=true pnpm lint`, and `CI=true pnpm typecheck`; review the owned diff and run `git diff --check`.
