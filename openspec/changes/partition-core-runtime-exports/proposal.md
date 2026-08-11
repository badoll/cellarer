## Why

The bundled Web client currently imports the `@cellarer/core` root barrel, so a two-constant browser dependency can pull Node-only Core modules into Vite's graph. Core needs explicit runtime-role exports so each consumer can depend only on code valid in its execution environment.

## What Changes

- Add a browser-safe `@cellarer/core/client-api` export containing only transport-neutral local-client constants, DTOs, and pure helpers.
- Keep Node-only use cases, filesystem effects, providers, and composition helpers behind the Core root or explicit Node-facing exports.
- Add package export and production-bundle tests that fail when the browser-safe subpath reaches Node built-ins or unrelated Core modules.
- Migrate the bundled Web client to the browser-safe subpath without changing `/api/v1` behavior.
- Do not split Core into new packages or add a second copy of client contracts.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-client-api`: Require the bundled Web client contract surface to remain browser-safe and free of Node runtime dependencies.

## Impact

- `packages/core/package.json`, Core protocol exports, and Core public API tests.
- `packages/web/client/**` imports and production bundle verification.
- No protocol-version bump, route change, production dependency, or product-state migration.
