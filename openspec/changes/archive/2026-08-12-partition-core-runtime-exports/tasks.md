## 1. Portable Export Contract

- [x] 1.1 Add failing package-export tests that resolve `@cellarer/core/client-api` for types and ESM while retaining the existing Core root export.
- [x] 1.2 Add failing production Vite bundle tests that union all physical first-party runtime seeds outside `node_modules` with the recursive TypeScript source/type closure and require the Core dependency closure to contain only approved browser-safe protocol modules and no Node built-ins.
- [x] 1.3 Define the minimal portable client API leaf and package subpath without duplicating constants, DTOs, or pure envelope helpers.

## 2. Consumer Migration

- [x] 2.1 Migrate bundled Web client value and type imports to `@cellarer/core/client-api` and reject new Core-root imports from browser source.
- [x] 2.2 Verify Node CLI/server consumers continue using supported exports, public type declarations resolve from a packed Core artifact, and OpenAPI Agent metadata exactly matches its canonical producer without a runtime protocol change.

## 3. Verification

- [x] 3.1 Run focused Core package-export, Windows launcher, Web production-bundle, and OpenAPI contract-parity tests, then `CI=true pnpm build` and `CI=true pnpm typecheck`.
- [x] 3.2 Review the owned diff, run `git diff --check`, and validate `partition-core-runtime-exports` plus all OpenSpec changes strictly.
