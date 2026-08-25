## Context

CLI leaf commands are constructed in domain command modules while machine traits, schemas, and bindings live in a 2,700-line registry. `program.ts`, input normalization, rendering, schema discovery, and tests reconcile these descriptions at runtime. Inventory will add several related commands, making duplication more costly.

## Goals / Non-Goals

**Goals:**

- Make one typed command contract authoritative for both human and machine surfaces.
- Prevent supported composition paths from replacing the initialized catalog or downgrading a known command to generic fallback.
- Keep domain modules small and independently testable.
- Preserve every existing command and protocol byte shape during migration.

**Non-Goals:**

- Do not move Commander or presentation logic into Core.
- Do not redesign commands, schemas, or protocol version in this change.
- Do not treat the catalog boundary as protection from arbitrary same-process code or filesystem-level package modification.

## Decisions

### A contract is data plus explicit handlers

Each leaf exports a `CommandContract<Input, Output, Event>` containing canonical path, description/help metadata, mutability, streaming trait, option/positional declarations, structured bindings, closed schemas, normalize/execute functions, presentation projection, and typed error mapping. Commander objects are generated at the composition edge. A decorator/reflection design was rejected because it hides static relationships and complicates ESM tests.

### Split definitions by domain and seal one supported composition catalog

Init, control-plane, resource lifecycle, sync, secrets, diagnostics, and service contracts live near their handlers. Domain factories return contracts or domain definitions only; they do not construct a publishable partial `CommandCatalog` protocol view. Each CLI composition canonicalizes those definitions once into one complete aggregate catalog containing every known executable leaf. The catalog validates unique paths and schema IDs, registers the tree, and is the sole runtime lookup for command definitions. Structured-input normalization, the contract runner, parse-time/build-time/Commander machine-error handling, rendering, and standalone or test composition all resolve through that catalog. Capability and schema discovery likewise always project the complete aggregate rather than a domain subset. Replacing one 2,700-line file with another was rejected.

Only the CLI composition root creates the active catalog used by its service set. Catalog construction is not a supported injection point for an initialized composition. The root creates the renderer, runner, structured-input normalizer, schema/capability discovery, and machine-error projection as one closed service set; none of those services accepts a caller-supplied catalog, command classification, or fallback policy. Standalone tests may create a fresh complete composition, but they cannot install an independently assembled catalog into an existing composition.

Catalog initialization canonicalizes and recursively freezes the complete reachable definition graph, including nested input/output/event schemas, structured bindings, and required-feature metadata. The renderer and the published protocol schema bundle retain references to that same canonical schema graph rather than independently cloning or rebuilding structurally equivalent schemas. Once initialized, the active catalog cannot be replaced through supported composition APIs. Each catalog has a process-local issuer identity used to reject accidental cross-composition handles or definitions even when their data is structurally identical. That identity is a conformance mechanism, not a credential or hostile-code security boundary.

The renderer does not accept a structurally shaped command definition as catalog authority. Its normal entry point accepts a command key and resolves the canonical definition through the active catalog. Any internal pre-resolved fast path carries provenance issued by that catalog, and runtime validation checks issuer plus canonical object identity before rendering. This prevents supported helper paths from substituting alternate schemas or error metadata.

Known and unknown commands take separate paths from one executable-matching result. The composition's matcher issues a result that either binds a known executable leaf to its canonical catalog definition or records that no executable leaf matched. Downstream supported APIs cannot manufacture this classification, substitute an empty catalog, or pass an `allowUnknown`-style boolean to downgrade a known leaf. A known match whose canonical lookup is missing or whose provenance is invalid is an invariant/conformance failure and cannot enter the generic unregistered-command branch. Only the matcher's genuine no-executable result may use the stable unregistered-command projection, and that projection cannot acquire known-leaf schema, binding, or feature metadata. Optional definition lookup, generic fallback rendering for known leaves, publishable subset protocol catalogs, caller-selected catalogs, and replaceable lookup hooks were rejected because each permits protocol behavior to diverge after composition.

### Composition integrity proof matrix

The matrix covers supported composition and package entry points. It does not claim protection from code that can patch loaded modules, mutate the filesystem outside the API, or replace the installed package. Structural equality, a passing aggregate test count, or source inspection alone is not evidence for these behavioral obligations.

| Observation | Required result |
|---|---|
| A supported consumer supplies an independently constructed catalog to an initialized composition | No supported install seam exists, and the active service set retains its original catalog. |
| A handle or definition from composition A is presented to composition B | Rejected by issuer and canonical-object identity without changing either composition. |
| A caller combines an empty catalog with an unknown/`allowUnknown` marker for a known executable leaf | The executable-match result keeps the leaf known and the attempt fails closed. |
| A known executable match cannot resolve its canonical definition | Report an invariant/conformance failure; never use the unregistered-command fallback. |
| Nested schema, binding, or required-feature metadata is mutated | The recursively frozen canonical graph and observed protocol behavior remain unchanged. |
| Renderer validation and schema-bundle publication are observed | Both retain the identical canonical schema nodes from the active catalog. |
| The packed binary or a declared package entry point is exercised | No supported catalog/classification injection is exposed; help, discovery, and execution use the packed composition's active catalog. |
| The executable matcher reports a genuine unknown command | Preserve the stable unregistered-command parity without known-leaf metadata. |

After implementation and the matrix rows are green, the remaining catalog-integrity slices receive one fresh final targeted review. If that review reports an Important or Critical finding, work stops with the finding reported and the affected slice left open; there is no automatic repair or repeated review loop. Further repair requires an explicit artifact update or user direction.

### Migrate with golden parity

Before converting a domain, tests snapshot leaf paths, help/options, capabilities, schema bundles, binding ambiguity, output envelopes, exit classes, and prompt classification. Old and new descriptors may coexist internally only behind one aggregate and must produce identical public output until the old path is deleted.

### Keep prompt effects outside contracts

Contracts declare whether interaction is allowed and what input is missing; the composition root supplies prompt capabilities only for text TTY invocations. This preserves machine isolation.

### Keep closure timing budgets local to slow integration cases

The full parallel repository test run can delay three unchanged filesystem-heavy integration cases beyond Vitest's default five-second budget even though each passes in isolation with the same assertions. Do not increase the global timeout or change product behavior. Give only the affected cases explicit local budgets consistent with neighboring slow integration tests: 15 seconds for the resource lifecycle owner-root case, 20 seconds for the sync-profile drift acknowledgement case, and 15 seconds for the Web sync-profile round trip. A timeout-only repair must retain the existing assertions and fixtures.

## Risks / Trade-offs

- **[Risk] Generic types become harder to understand than duplication.** → Keep the contract minimal and use domain-specific helpers rather than a schema DSL.
- **[Risk] Help text or variadic option semantics drift.** → Golden-test Commander inspection and real argv parsing for every migrated leaf.
- **[Risk] Mutable nested metadata or caller-selected catalog/fallback seams can silently split protocol behavior.** → Bind the composition-root catalog into a closed service set, canonicalize and deep-freeze the reachable graph, and verify the finite integrity matrix at production and packed boundaries.
- **[Trade-off] Process-local issuer identity prevents accidental cross-composition substitution but is not a hostile-code boundary.** → Keep the claim limited to supported APIs and avoid security guarantees against arbitrary local code.
- **[Trade-off] Temporary dual representation during migration.** → Migrate domain slices sequentially and forbid adding new commands to the legacy registry.
- **[Risk] Full-suite resource contention can make valid filesystem-heavy integration coverage fail at the default timeout.** → Use bounded per-test budgets only for the three reproduced cases; do not weaken assertions or the global timeout.

## Migration Plan

1. Capture complete command/protocol parity fixtures.
2. Introduce contract types and aggregate validation.
3. Migrate read-only, then ordinary mutations, then streaming/service and secret commands.
4. Seal the aggregate catalog, remove supported replaceable/structural lookup paths, and keep conformance tests as permanent guards.
5. Verify the same catalog and canonical schema graph through the packed production artifact.
6. Roll back per domain while public protocol remains unchanged.

## Open Questions

None.
