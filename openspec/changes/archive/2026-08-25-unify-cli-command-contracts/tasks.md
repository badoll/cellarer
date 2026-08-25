## 1. Generated Parity Baseline

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/command-parity-baseline.test.ts packages/cli/tests/program.test.ts packages/cli/tests/protocol.test.ts packages/cli/tests/protocol-conformance.test.ts packages/cli/tests/input-protocol.test.ts`

- [x] 1.1 Generate and freeze a golden fixture for the current executable leaf set, including paths, aliases, options, positionals, help text, mutability, streaming traits, schema IDs, required features, and structured bindings.
- [x] 1.2 Add characterization coverage for argv/input ambiguity, machine stdout isolation, prompt classification, and typed error/exit mapping before catalog migration.

## 2. Command Contract Kernel

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/program.test.ts packages/cli/tests/protocol-conformance.test.ts packages/cli/tests/protocol.test.ts packages/cli/tests/input-protocol.test.ts`

- [x] 2.1 Define the minimal generic `CommandContract` and domain helpers for Commander declarations, normalization, execution, presentation, schemas, and errors without moving product logic from Core.
- [x] 2.2 Implement one aggregate catalog that validates path and schema uniqueness and generates the Commander tree, capability list, schema bundle, input bindings, and renderer metadata.
- [x] 2.3 Add conformance cases for executable-without-contract, contract-without-executable, duplicate command/schema IDs, and invalid trait/schema combinations.

## 3. Initialization and Discovery Catalog

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/init-command.test.ts packages/cli/tests/discovery.test.ts packages/cli/tests/scan-command.test.ts packages/cli/tests/protocol-conformance.test.ts`

- [x] 3.1 Add contract-driven parity cases for init, capability/schema discovery, discovery summary, and scan help, argv, structured input, schemas, envelopes, prompts, and exit classes.
- [x] 3.2 Migrate initialization and discovery declarations behind one domain catalog while preserving current Core requests and public protocol behavior.

## 4. Control-plane Read Catalog

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/control-plane-read-commands.test.ts packages/cli/tests/control-plane-contract.test.ts packages/cli/tests/http-read-parity.test.ts packages/cli/tests/protocol-conformance.test.ts`

- [x] 4.1 Add contract-driven parity cases for resource, agent, collection, config, diff, verify, summary, plan, and operation read leaves.
- [x] 4.2 Migrate control-plane read declarations behind one domain catalog without changing Core DTOs, filters, schemas, renderers, or HTTP parity.

## 5. Store and Target Mutation Catalog

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/control-plane-mutation-commands.test.ts packages/cli/tests/apply-plan-boundary.test.ts packages/cli/tests/apply-presentation.test.ts packages/cli/tests/mutation-authority.test.ts`

- [x] 5.1 Add contract-driven parity cases for configuration, adapter, collection, apply, and revert mutations, including dry-run, acknowledgement, authority, receipt, and error behavior.
- [x] 5.2 Migrate ordinary Store and target mutation declarations behind domain catalogs while preserving the unchanged authorized plan and existing mutation boundary.

## 6. Resource Lifecycle and Sync Catalog

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/resource-lifecycle-profile-commands.test.ts packages/cli/tests/command-migration.test.ts packages/cli/tests/protocol-conformance.test.ts`

- [x] 6.1 Add contract-driven parity cases for resource lifecycle, profile, and sync leaves, including variadic arguments, plan/apply separation, events, and receipts.
- [x] 6.2 Migrate resource lifecycle, profile, and sync declarations behind domain catalogs without changing resource identity, target selection, or recovery semantics.

## 7. Secret, Authority, and Recovery Catalog

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/secret-command.test.ts packages/cli/tests/mutation-authority.test.ts packages/cli/tests/control-plane-read-commands.test.ts packages/cli/tests/protocol-conformance.test.ts`

- [x] 7.1 Add contract-driven parity cases for secret, mutation-authority, and operation recovery leaves, including protected input, prompt eligibility, redaction, and zero-value publication.
- [x] 7.2 Migrate secret, authority, and recovery declarations behind domain catalogs without exposing secret values or weakening authority-first ordering.

## 8. Diagnostics and Service Catalog

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/program.test.ts packages/cli/tests/cli-boundary.test.ts packages/cli/tests/ui-lifecycle.test.ts packages/cli/tests/runner-internal-error.test.ts packages/cli/tests/protocol-conformance.test.ts`

- [x] 8.1 Add contract-driven parity cases for status, agents, doctor, UI, streaming, and managed-sidecar behavior, including TTY classification and stdout/stderr isolation.
- [x] 8.2 Migrate diagnostics and service declarations behind domain catalogs without changing process lifetime, event ordering, or internal-error projection.

## 9. Supported Composition Closure

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/program.test.ts packages/cli/tests/input-protocol.test.ts packages/cli/tests/cli-boundary.test.ts packages/cli/tests/runner-internal-error.test.ts`

- [x] 9.1 Bind Commander registration, runner, structured-input normalization, machine-error projection, rendering, and discovery to the catalog created by their composition root; remove supported caller-supplied catalog, classification, and fallback seams.
- [x] 9.2 Derive known versus unknown from the composition's executable match, reject foreign-composition results, treat a known-definition miss as an invariant, and preserve the genuine unknown-command projection.

## 10. Canonical Protocol Graph

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/protocol.test.ts packages/cli/tests/discovery.test.ts packages/cli/tests/scan-command.test.ts packages/cli/tests/command-migration.test.ts packages/cli/tests/protocol-conformance.test.ts`

- [x] 10.1 Canonicalize and recursively freeze command definitions, nested schemas, bindings, and required-feature metadata while keeping renderer validation and schema-bundle publication on the same canonical schema nodes.
- [x] 10.2 Prove catalog/executable bijection, schema closure, binding uniqueness, nested mutation resistance, canonical schema identity, and complete discovery from standalone compositions with behavioral assertions.

## 11. Packed Artifact Boundary

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/packed-artifact.test.ts packages/cli/tests/program.test.ts packages/cli/tests/protocol-conformance.test.ts`

- [x] 11.1 Pack and invoke the production CLI to verify installed help, version, capabilities, schemas, representative human and machine commands, known failures, genuine unknown fallback, and absence of catalog/classification injection from declared package entry points.
- [x] 11.2 Run one fresh targeted review of the supported-composition integrity matrix after the focused checks pass. If it reports an Important or Critical finding, leave the affected slice open, stop, and report it without an automatic repair or repeated review cycle.

## 12. Change Closure

**Verification:** focused timeout regressions, then full repository and OpenSpec gates

- [x] 12.1 Run `openspec validate unify-cli-command-contracts --strict --no-interactive` and `openspec validate --changes --strict --no-interactive`.
- [x] 12.2 Stabilize only the three reproduced filesystem-heavy integration cases with bounded per-test timeouts, preserving their existing assertions and fixtures. Verify with `CI=true pnpm exec vitest run packages/core/tests/resource-lifecycle-update.test.ts packages/core/tests/sync-profiles.test.ts packages/web/tests/api-v1-mutation-families.test.ts`.
- [x] 12.3 Run `CI=true pnpm build`, `CI=true pnpm test`, `CI=true pnpm lint`, and `CI=true pnpm typecheck`; review the owned diff and run `git diff --check`.
