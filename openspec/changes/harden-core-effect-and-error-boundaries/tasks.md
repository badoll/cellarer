## 1. Executable Boundary Tests

- [ ] 1.1 Add a Core dependency-graph test covering the allowed domain, port, provider, transaction, and runtime-composition directions and reproducing the current secret/store-mutation cycle.
- [ ] 1.2 Add forbidden-import and ambient-input tests for business-module `process`, Node filesystem, implicit cwd path resolution, and module-global mutable operation identity.
- [ ] 1.3 Add characterization tests for authority-first ordering, provider access, final-byte guards, atomic publication, errors, and observable-secret canaries across affected operations.

## 2. Typed Runtime Inputs and Outcomes

- [ ] 2.1 Introduce injected operation-local identity or temporary-name generation and migrate atomic publication tests away from the module counter.
- [ ] 2.2 Require canonical absolute roots or explicit `Env` cwd at path-safety boundaries and add POSIX/Windows alias and cross-drive tests.
- [ ] 2.3 Replace policy, retry, compensation, and transport decisions based on free-form reasons/messages with closed typed discriminants and exhaustive mappings.

## 3. Acyclic Provider and Runtime Composition

- [ ] 3.1 Extract secret observation and provider mutation ports that do not import Store transaction orchestration.
- [ ] 3.2 Move vault/keychain transaction composition to the secret-metadata operation boundary and remove the `store-mutation` / active-values / vault cycle without changing effect order.
- [ ] 3.3 Decompose `real-env.ts` into focused filesystem, process/platform, credential, and mutation-authority adapters behind the unchanged public `Env` contract.
- [ ] 3.4 Collapse or retain `RulesCodec` and `SkillsCodec` only according to real variant usage; add no hypothetical extension layer.

## 4. Verification

- [ ] 4.1 Run focused safety, secret-provider, mutation-authority, journal/recovery, fake-Env, and cross-platform path tests.
- [ ] 4.2 Run `CI=true pnpm build`, `CI=true pnpm test`, `CI=true pnpm lint`, and `CI=true pnpm typecheck`.
- [ ] 4.3 Review dependency output and observable canaries, run `git diff --check`, and validate this change and all OpenSpec changes strictly.
