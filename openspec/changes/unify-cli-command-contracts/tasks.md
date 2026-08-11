## 1. Parity Baseline

- [ ] 1.1 Capture every executable leaf path, aliases, options, positionals, help text, mutability, streaming trait, schema ID, required feature, and structured binding in golden conformance fixtures.
- [ ] 1.2 Add failing tests for executable-without-contract, contract-without-executable, duplicate command/schema IDs, argv/input ambiguity, machine stdout isolation, prompt classification, and typed error/exit mapping.

## 2. Contract Catalog

- [ ] 2.1 Define the minimal generic `CommandContract` and domain helpers for Commander declarations, normalization, execution, presentation, schemas, and errors without moving product logic from Core.
- [ ] 2.2 Implement one aggregate catalog that validates uniqueness and generates the Commander tree, capability list, schema bundle, input bindings, and renderer metadata.
- [ ] 2.3 Split declarations into domain catalogs for initialization/discovery, control-plane reads/mutations, resource lifecycle/sync, secrets/authority, diagnostics, and service commands.

## 3. Sequential Command Migration

- [ ] 3.1 Migrate read-only and discovery/schema commands and prove help, argv, structured input, and JSON/JSONL parity.
- [ ] 3.2 Migrate ordinary Store and target mutation commands while preserving dry-run, acknowledgement, plan receipt, and error mappings.
- [ ] 3.3 Migrate streaming, recovery, secret protected-input, UI, and managed-sidecar commands with TTY and descriptor tests.
- [ ] 3.4 Delete legacy registry declarations and hand-built duplicate registration after the aggregate catalog owns every leaf.

## 4. Verification

- [ ] 4.1 Run focused program, command-registry, protocol-conformance, input-protocol, renderer, help, secret-input, and streaming tests.
- [ ] 4.2 Pack and invoke the CLI artifact to verify installed help/version/capabilities/schema and representative human/machine commands.
- [ ] 4.3 Run full build/test/lint/typecheck gates, `git diff --check`, and strict validation for this and all OpenSpec changes.
