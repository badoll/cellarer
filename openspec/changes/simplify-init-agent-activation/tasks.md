## 1. Core Initialization Contract

- [x] 1.1 Add characterization tests in `packages/core/tests/init.test.ts` for the existing explicit empty first-run set and order-insensitive matching repeated initialization, plus a failing regression test for conflicting repeated initialization that preserves config; run `CI=true pnpm exec vitest run packages/core/tests/init.test.ts` and confirm the conflict assertion fails because current code silently succeeds.
- [x] 1.2 Add the typed initialization-selection validator/error in `packages/core/src/store/initialize.ts`, export its public types from `packages/core/src/index.ts`, reuse it for dry-run and committed initialization, and rerun the focused Core test to green without changing the config schema.

## 2. CLI Intent and Interaction

- [x] 2.1 Add focused command tests in `packages/cli/tests/init-command.test.ts` covering TTY selection, TTY empty selection, non-TTY omission, `--no-agent`, empty argv target lists, structured `agents: []`, structured file-input prompt suppression, conflicting argv/structured forms, and matching/conflicting repeated initialization; keep existing prompt-suppression cases as characterization, add empty-output schema coverage to `packages/cli/tests/protocol-conformance.test.ts`, then run the focused CLI tests and confirm the new selector/empty/conflict behaviors fail for the expected missing implementation.
- [x] 2.2 Implement injected text-mode selection and exact target-intent normalization in `packages/cli/src/commands/init.ts` and `packages/cli/src/program.ts`, using built-in Node readline for the production selector, classifying every structured-input source as non-interactive, rejecting empty argv `--agent` values and `--agent` plus `--no-agent` as typed input failures, and mapping Core selection conflicts to typed protocol failures without prompt output in machine modes.
- [x] 2.3 Update `packages/cli/src/protocol/command-registry.ts` only as required to keep structured `agents: []`, init dry-run output, and discoverable schemas valid; run `CI=true pnpm exec vitest run packages/cli/tests/init-command.test.ts packages/cli/tests/protocol-conformance.test.ts packages/cli/tests/input-protocol.test.ts` to green.

## 3. Public Guidance and Verification

- [x] 3.1 Update the init/agent-activation guidance and examples in `docs/README.md` and `docs/README.zh-CN.md`, keeping both languages semantically aligned and distinguishing activation from per-operation distribution authorization.
- [x] 3.2 Review the owned diff for unrelated changes and run `openspec validate simplify-init-agent-activation --strict --no-interactive`, `CI=true pnpm build`, `CI=true pnpm test`, `CI=true pnpm lint`, and `CI=true pnpm typecheck`; record only implementation tasks as complete and leave sync/archive/commit/push outside this change execution.
