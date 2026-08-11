## Why

A CLI command is currently described across Commander construction, a large protocol registry, input bindings, schemas, renderers, and error mappings. Conformance tests detect some drift after the fact, but adding Inventory commands would multiply the duplicated sources of truth.

## What Changes

- Define each leaf command once as a typed command contract covering path, traits, options/positionals, structured bindings, input/output/event schemas, execution, presentation, and error mapping.
- Generate Commander registration, capability discovery, schema bundles, input normalization, and protocol rendering metadata from that catalog.
- Split the catalog by domain while preserving one validated aggregate registry and exhaustive leaf-command parity.
- Preserve command names, flags, protocol version, JSON/JSONL envelopes, help behavior, and machine stdout isolation.
- Prohibit a command from registering executable behavior without a contract or advertising a contract without an executable leaf.
- Do not redesign individual product commands or introduce a generic framework into Core.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-cli-protocol`: Make executable commands, discoverable capabilities, schemas, bindings, and machine envelopes derive from one authoritative command contract.

## Impact

- `packages/cli/src/program.ts`, command factories, protocol registry/input/renderer/schema modules, and conformance tests.
- No Core business-logic move, protocol-version bump, or user-visible command migration.
- Must land before adding the new Inventory CLI surface to avoid recreating duplicated declarations.
