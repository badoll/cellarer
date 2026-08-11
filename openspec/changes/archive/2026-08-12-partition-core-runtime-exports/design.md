## Context

`@cellarer/core` exposes a single root barrel with hundreds of exports spanning pure protocol types, business use cases, filesystem code, credential providers, and Node composition. The bundled React client imports two client-contract constants from that barrel, causing Vite to analyze Node-only transitive imports. The local API contract must remain authored once in Core and usable by both Node and browser consumers.

## Goals / Non-Goals

**Goals:**

- Make runtime compatibility explicit in package exports.
- Prove the Web production graph includes only the portable client-contract module.
- Preserve one source of truth for DTOs and constants.

**Non-Goals:**

- Do not split the monorepo package, redesign `/api/v1`, or make all Core code browser-compatible.
- Do not expose business use cases through the portable subpath.

## Decisions

### Use a narrow package subpath, not another package

`@cellarer/core/client-api` will point directly to a leaf module whose value and type imports are themselves portable. The root barrel may re-export it for Node callers, but browser code must import the subpath. A new package was rejected because it would add release/version coordination without adding an ownership boundary.

### Enforce portability across the real runtime graph and source/type closure

A production Vite build with `write: false` will inspect emitted module provenance and require that Core contribution equal the approved portable module set. Every runtime module with a physical real path outside `node_modules` is an independent scan seed, including sibling, workspace, and other out-of-root modules; its violations are unioned with the recursively resolved TypeScript source/type closure. A safe TypeScript alias therefore cannot hide a dangerous Vite runtime target, and a safe Vite target cannot hide a dangerous erased type edge. Inspectable virtual executable modules are scanned and uninspectable first-party virtual modules fail closed. Source grep alone was rejected because type erasure, package conditions, aliases, and bundler resolution can change the actual graph.

### Correct OpenAPI metadata parity exposed by the split

The new exactness checks compare OpenAPI component schemas with canonical Core DTOs and runtime producers. `Agent.capabilityScopes` therefore requires `rules`, `mcp`, and `skills`, matching the three fields always returned by the server. Retaining the previous looser schema was rejected because it would preserve machine-contract drift. This is an OpenAPI metadata correction only: it changes no route, request, operational response payload, or protocol version.

### Keep DTO helpers pure

The subpath may use types and deterministic pure transformations. It must not import `Env`, Node built-ins, stores, engines, adapters, or provider code. A forbidden-import test and package-export test make this an architectural constraint rather than documentation.

## Risks / Trade-offs

- **[Risk] Future DTO growth imports a Node-only type through a value edge.** → Test the emitted graph and direct dependency closure on every build.
- **[Compatibility] A schema-only consumer may previously have accepted an Agent missing one capability-scope field.** → Tighten the schema to the shape the canonical producer already always emits and cover it with compile-time and runtime OpenAPI parity tests.
- **[Trade-off] More public subpaths require deliberate API stewardship.** → Start with one minimal subpath and add roles only when a real consumer requires them.

## Migration Plan

1. Add the package subpath and bundle/dependency tests.
2. Move Web imports to the subpath and verify Node API consumers remain unchanged.
3. Roll back by restoring the old import and export entry; no persisted state or protocol data changes.

## Open Questions

None.
