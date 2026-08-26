## 1. Stable package and installed-command gate

**Verification:** `pnpm install --frozen-lockfile`, `CI=true pnpm version:check -- 0.1.0`, `CI=true pnpm vitest run --project cli tests/command-parity-baseline.test.ts`, and `npm_config_registry=https://registry.npmjs.org CI=true pnpm release:readiness`

- [x] 1.1 Prepare Core, Web, and CLI manifests at `0.1.0` with exact synchronized internal dependency versions, align the workspace lockfile importers, and leave the workspace root private.
- [x] 1.2 Advance the frozen CLI command-surface version from `0.1.0-alpha.0` to `0.1.0`, with the fixture diff limited to that field.
- [x] 1.3 Update the artifact release gate to reject prerelease package versions and invoke the isolated consumer's `cellarer` through its command search path without weakening source-boundary checks.
- [x] 1.4 Verify the stable package and installed-command slice with the focused Verification commands declared above.

## 2. Release-oriented public documentation

**Verification:** compare the English and Simplified Chinese usage sections, confirm the first-run command is `cellarer init`, and use focused `rg` checks to confine the source entrypoint to development guidance

- [x] 2.1 Rewrite the English and Simplified Chinese root installation, first-run, workflow, UI, and command-help examples to use the installed `cellarer` executable, with source execution confined to contributor guidance.
- [x] 2.2 Align the English and Simplified Chinese detailed release guidance and the CLI package README on version `0.1.0`, the `@cellarer/cli` install command, current publication status, and the external publication boundary.
- [x] 2.3 Verify the documentation slice by checking semantic parity, confirming `cellarer init` is the first-run command, and confirming `node packages/cli/dist/bin.js` appears only in contributor/development guidance.

## 3. Change closure

**Verification:** `CI=true pnpm build`, `CI=true pnpm test`, `CI=true pnpm lint`, `CI=true pnpm typecheck`, `openspec validate --all --strict --no-interactive`, and `git diff --check`

- [x] 3.1 Review the complete owned diff against the delta specification and confirm no remote publish, tag, release, deployment, dependency, Store, or command-semantics change was introduced.
- [x] 3.2 Run the closure Verification command set once and record its fresh results before spec sync and archive.
