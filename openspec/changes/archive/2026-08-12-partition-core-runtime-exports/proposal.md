## Why

The bundled Web client currently imports the `@cellarer/core` root barrel, so a two-constant browser dependency can pull Node-only Core modules into Vite's graph. Core needs explicit runtime-role exports so each consumer can depend only on code valid in its execution environment.

## What Changes

- Add a browser-safe `@cellarer/core/client-api` export containing only transport-neutral local-client constants, DTOs, and pure helpers.
- Keep Node-only use cases, filesystem effects, providers, and composition helpers behind the Core root or explicit Node-facing exports.
- Add package export and production-bundle tests that union the real Vite runtime graph, including physical first-party modules outside the browser root, with the recursive TypeScript source/type closure and fail when either reaches Node built-ins or unrelated Core modules.
- Migrate the bundled Web client to the browser-safe subpath without changing `/api/v1` behavior.
- Use the package/browser split's exactness checks to correct OpenAPI Agent metadata parity: `Agent.capabilityScopes` requires the canonical `rules`, `mcp`, and `skills` fields already emitted by the server.
- Do not split Core into new packages or add a second copy of client contracts.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-client-api`: Require the bundled Web client contract surface to remain browser-safe and free of Node runtime dependencies.

## Impact

- `packages/core/package.json`, Core protocol exports, and Core public API tests.
- `packages/web/client/**` imports and production bundle verification.
- OpenAPI metadata becomes stricter for clients that previously accepted an Agent schema missing a capability-scope field, although the runtime producer has never emitted that incomplete shape.
- No protocol-version bump, route, request, operational response payload, production dependency, or product-state migration.
