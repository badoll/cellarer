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

- [ ] 3.1 Add contract-driven parity cases for init, capability/schema discovery, discovery summary, and scan help, argv, structured input, schemas, envelopes, prompts, and exit classes.
- [ ] 3.2 Migrate initialization and discovery declarations behind one domain catalog while preserving current Core requests and public protocol behavior.

## 4. Control-plane Read Catalog

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/control-plane-read-commands.test.ts packages/cli/tests/control-plane-contract.test.ts packages/cli/tests/http-read-parity.test.ts packages/cli/tests/protocol-conformance.test.ts`

- [ ] 4.1 Add contract-driven parity cases for resource, agent, collection, config, diff, verify, summary, plan, and operation read leaves.
- [ ] 4.2 Migrate control-plane read declarations behind one domain catalog without changing Core DTOs, filters, schemas, renderers, or HTTP parity.

## 5. Store and Target Mutation Catalog

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/control-plane-mutation-commands.test.ts packages/cli/tests/apply-plan-boundary.test.ts packages/cli/tests/apply-presentation.test.ts packages/cli/tests/mutation-authority.test.ts`

- [ ] 5.1 Add contract-driven parity cases for configuration, adapter, collection, apply, and revert mutations, including dry-run, acknowledgement, authority, receipt, and error behavior.
- [ ] 5.2 Migrate ordinary Store and target mutation declarations behind domain catalogs while preserving the unchanged authorized plan and existing mutation boundary.

## 6. Resource Lifecycle and Sync Catalog

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/resource-lifecycle-profile-commands.test.ts packages/cli/tests/command-migration.test.ts packages/cli/tests/protocol-conformance.test.ts`

- [ ] 6.1 Add contract-driven parity cases for resource lifecycle, profile, and sync leaves, including variadic arguments, plan/apply separation, events, and receipts.
- [ ] 6.2 Migrate resource lifecycle, profile, and sync declarations behind domain catalogs without changing resource identity, target selection, or recovery semantics.

## 7. Secret, Authority, and Recovery Catalog

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/secret-command.test.ts packages/cli/tests/mutation-authority.test.ts packages/cli/tests/control-plane-read-commands.test.ts packages/cli/tests/protocol-conformance.test.ts`

- [ ] 7.1 Add contract-driven parity cases for secret, mutation-authority, and operation recovery leaves, including protected input, prompt eligibility, redaction, and zero-value publication.
- [ ] 7.2 Migrate secret, authority, and recovery declarations behind domain catalogs without exposing secret values or weakening authority-first ordering.

## 8. Diagnostics and Service Catalog

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/program.test.ts packages/cli/tests/cli-boundary.test.ts packages/cli/tests/ui-lifecycle.test.ts packages/cli/tests/runner-internal-error.test.ts packages/cli/tests/protocol-conformance.test.ts`

- [ ] 8.1 Add contract-driven parity cases for status, agents, doctor, UI, streaming, and managed-sidecar behavior, including TTY classification and stdout/stderr isolation.
- [ ] 8.2 Migrate diagnostics and service declarations behind domain catalogs without changing process lifetime, event ordering, or internal-error projection.

## 9. Catalog Exclusivity and Built Artifact

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/program.test.ts packages/cli/tests/protocol-conformance.test.ts packages/cli/tests/packed-artifact.test.ts`

- [ ] 9.1 Remove legacy registry declarations and hand-built duplicate registration after the aggregate catalog owns the generated executable leaf set.
- [ ] 9.2 Prove catalog/executable bijection, schema closure, binding uniqueness, and frozen public parity from the generated fixtures.
- [ ] 9.3 Pack and invoke the CLI artifact to verify installed help/version/capabilities/schema plus representative human and machine commands.

## 10. Change Closure

**Verification:** full repository and OpenSpec gates

- [ ] 10.1 Run `openspec validate unify-cli-command-contracts --strict --no-interactive` and `openspec validate --changes --strict --no-interactive`.
- [ ] 10.2 Run `CI=true pnpm build`, `CI=true pnpm test`, `CI=true pnpm lint`, and `CI=true pnpm typecheck`; review the owned diff and run `git diff --check`.
