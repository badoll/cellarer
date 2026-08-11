## 1. Portable Export Contract

- [ ] 1.1 Add failing package-export tests that resolve `@cellarer/core/client-api` for types and ESM while retaining the existing Core root export.
- [ ] 1.2 Add a failing production Vite bundle test that requires the Web client's Core dependency closure to contain only approved browser-safe protocol modules and no Node built-ins.
- [ ] 1.3 Define the minimal portable client API leaf and package subpath without duplicating constants, DTOs, or pure envelope helpers.

## 2. Consumer Migration

- [ ] 2.1 Migrate bundled Web client value and type imports to `@cellarer/core/client-api` and reject new Core-root imports from browser source.
- [ ] 2.2 Verify Node CLI/server consumers continue using supported exports and that public type declarations resolve from a packed Core artifact.

## 3. Verification

- [ ] 3.1 Run focused Core package-export and Web production-bundle tests, then `CI=true pnpm build` and `CI=true pnpm typecheck`.
- [ ] 3.2 Review the owned diff, run `git diff --check`, and validate `partition-core-runtime-exports` plus all OpenSpec changes strictly.
