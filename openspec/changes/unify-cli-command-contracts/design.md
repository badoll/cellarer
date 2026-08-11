## Context

CLI leaf commands are constructed in domain command modules while machine traits, schemas, and bindings live in a 2,700-line registry. `program.ts`, input normalization, rendering, schema discovery, and tests reconcile these descriptions at runtime. Inventory will add several related commands, making duplication more costly.

## Goals / Non-Goals

**Goals:**

- Make one typed command contract authoritative for both human and machine surfaces.
- Keep domain modules small and independently testable.
- Preserve every existing command and protocol byte shape during migration.

**Non-Goals:**

- Do not move Commander or presentation logic into Core.
- Do not redesign commands, schemas, or protocol version in this change.

## Decisions

### A contract is data plus explicit handlers

Each leaf exports a `CommandContract<Input, Output, Event>` containing canonical path, description/help metadata, mutability, streaming trait, option/positional declarations, structured bindings, closed schemas, normalize/execute functions, presentation projection, and typed error mapping. Commander objects are generated at the composition edge. A decorator/reflection design was rejected because it hides static relationships and complicates ESM tests.

### Split catalog by domain and aggregate once

Init, control-plane, resource lifecycle, sync, secrets, diagnostics, and service contracts live near their handlers. One aggregate catalog validates unique paths/schema IDs and registers the tree. Replacing one 2,700-line file with another was rejected.

### Migrate with golden parity

Before converting a domain, tests snapshot leaf paths, help/options, capabilities, schema bundles, binding ambiguity, output envelopes, exit classes, and prompt classification. Old and new descriptors may coexist internally only behind one aggregate and must produce identical public output until the old path is deleted.

### Keep prompt effects outside contracts

Contracts declare whether interaction is allowed and what input is missing; the composition root supplies prompt capabilities only for text TTY invocations. This preserves machine isolation.

## Risks / Trade-offs

- **[Risk] Generic types become harder to understand than duplication.** → Keep the contract minimal and use domain-specific helpers rather than a schema DSL.
- **[Risk] Help text or variadic option semantics drift.** → Golden-test Commander inspection and real argv parsing for every migrated leaf.
- **[Trade-off] Temporary dual representation during migration.** → Migrate domain slices sequentially and forbid adding new commands to the legacy registry.

## Migration Plan

1. Capture complete command/protocol parity fixtures.
2. Introduce contract types and aggregate validation.
3. Migrate read-only, then ordinary mutations, then streaming/service and secret commands.
4. Delete legacy registry declarations and keep conformance tests as permanent guards.
5. Roll back per domain while public protocol remains unchanged.

## Open Questions

None.
