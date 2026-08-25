## Why

A CLI command is currently described across Commander construction, a large protocol registry, input bindings, schemas, renderers, and error mappings. Conformance tests detect some drift after the fact, while supported composition helpers can still select inconsistent descriptions or fallback behavior. Adding Inventory commands would multiply both failure modes.

## What Changes

- Define each leaf command once as a typed command contract covering path, traits, options/positionals, structured bindings, input/output/event schemas, execution, presentation, and error mapping.
- Generate Commander registration, capability discovery, schema bundles, input normalization, and protocol rendering metadata from that catalog.
- Split definitions by domain while establishing one complete, sealed aggregate catalog in each supported CLI composition.
- Bind executable matching, known/unknown classification, rendering, input normalization, machine-error projection, capability discovery, and schema retrieval to that catalog without caller-selected catalog or fallback injection.
- Canonicalize and recursively freeze the catalog metadata used by protocol publication so supported composition paths cannot drift after initialization.
- Preserve command names, flags, protocol version, JSON/JSONL envelopes, help behavior, and machine stdout isolation.
- Prohibit a command from registering executable behavior without a contract or advertising a contract without an executable leaf.
- Do not redesign individual product commands, introduce a generic framework into Core, or claim a security boundary against arbitrary code that can patch or replace the installed package.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-cli-protocol`: Make executable commands, discoverable capabilities, schemas, bindings, and machine envelopes derive from one complete catalog, and prevent known commands from entering unknown-command fallback through supported composition APIs.

## Impact

- `packages/cli/src/program.ts`, command factories, protocol registry/input/renderer/schema modules, packed CLI behavior, and conformance tests.
- Closure-only timeout stabilization in the three existing integration tests that exceeded Vitest's default five-second budget only under the full parallel repository run; assertions and product behavior remain unchanged.
- No Core business-logic move, protocol-version bump, or user-visible command migration.
- The sealed catalog is a supported-composition integrity boundary, not protection from arbitrary same-process or filesystem-level code modification.
- Must land before adding the new Inventory CLI surface to avoid recreating duplicated declarations.

## Execution Contract

- Risk: integration
- Depends on: none
- Allowed paths: `packages/cli/src/program.ts`, `packages/cli/src/commands`, `packages/cli/src/protocol`, `packages/cli/tests`, `packages/core/tests/resource-lifecycle-update.test.ts`, `packages/core/tests/sync-profiles.test.ts`, `packages/web/tests/api-v1-mutation-families.test.ts`
