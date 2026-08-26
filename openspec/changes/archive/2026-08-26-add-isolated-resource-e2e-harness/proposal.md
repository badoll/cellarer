## Why

Cellarer has strong Core, CLI, Web, transaction, and packed-artifact tests, but it does not have one deterministic acceptance journey that proves an externally supplied Skills pool plus Rules and MCP resources can move through bounded Inventory discovery, exact Store import, packed-CLI plan/apply, and isolated multi-Agent project targets. Maintainers therefore cannot currently run one local command and distinguish source discovery, Store publication, target distribution, convergence, verification, and revert failures across the complete product boundary.

## What Changes

- Add a deterministic, packed-CLI end-to-end acceptance harness rooted under `test/` with isolated home, Store, temporary, runtime-install, source-staging, target, and report paths.
- Accept either repository fixtures or an explicit absolute Skills-pool path, copy that pool into harness-owned source staging without modifying the original, and discover it only through a bounded declarative source adapter.
- Exercise Rules, MCP, and Skills through Inventory refresh, exact serializable Store-import plan/apply, project distribution with copy semantics, status/verify, convergent re-apply, typed negative cases, and revert.
- Exercise built-in Claude Code, Codex, and `agents-md` project layouts plus a test-only declarative CodeBuddy-shaped adapter. This does not claim compatibility with an external CodeBuddy product contract.
- Extend installed-artifact acceptance so the resource journey resolves and invokes the cleanly installed `cellarer` command rather than workspace TypeScript or source-tree module links.
- Fix Store-publication and public-protocol checking for schema-validated Cellarer configuration so required custom-MCP metadata such as `supportedSecretReferences` is not mistaken for plaintext secret data, and prevent the standard shell `PWD` environment key from being inventoried as a password, while raw high-confidence and active-provider secret values remain blocked.
- Canonicalize no-follow directory snapshots with the same code-point ordering as target ownership hashing so copied Skill trees satisfy their signed postconditions independent of locale-aware filename ordering.
- Align the existing distribution-plan JSON schema with the already emitted optional selection fields and targetless typed skips so valid multi-Agent plans remain publishable through the installed CLI protocol.
- Keep generated targets and runtime state untracked, clean only an explicit allowlist of harness-owned paths, and emit machine-readable evidence for failed and successful phases.
- Do not launch real third-party Agent binaries, contact remote MCP servers, access a user's credential manager, mutate the supplied Skills pool, or perform publication, deployment, or remote Git actions.

## Capabilities

### New Capabilities

- `isolated-resource-e2e-acceptance`: Defines the isolated source-to-Store-to-multi-Agent acceptance journey, deterministic fixtures, real-pool mode, safety assertions, and convergence/revert evidence.

### Modified Capabilities

- `installable-cli-distribution`: Expands clean installed-artifact acceptance from minimal resource smoke coverage to the isolated Rules/MCP/Skills multi-Agent journey while preserving publication boundaries.

## Impact

- Adds a tracked `test/` harness and deterministic Rules, MCP, Skills, and declarative-adapter fixtures.
- Adds root package scripts and exact ignore rules for generated E2E state and Agent targets.
- Extends the local artifact/release acceptance path without adding a production dependency or adding public commands, Web API routes, Store layout, ledger semantics, or built-in Agent adapter behavior; the existing CLI schema is corrected to accept its existing distribution output.
- Adds one narrow Core correction for persisted custom MCP adapters: domain-validated non-secret configuration metadata survives final publication checking without weakening generic guards for arbitrary Store/resource bytes.
- Uses Node.js standard-library process and filesystem facilities to invoke the installed CLI and assert path containment, no-follow source handling, hashes, protocol envelopes, non-disclosure, idempotence, and cleanup boundaries.

## Execution Contract

- Risk: integration
- Depends on: none
- Allowed paths: `.gitignore`, `package.json`, `scripts/artifact-release-gate.mjs`, `test/**`, `packages/core/src/config-mutation.ts`, `packages/core/src/control-plane-mutations.ts`, `packages/core/src/inventory/import.ts`, `packages/core/src/protocol/store-mutation.ts`, `packages/core/src/runtime/filesystem-adapter.ts`, `packages/core/src/secrets/active-values.ts`, `packages/core/src/secrets/final-bytes.ts`, `packages/core/src/secrets/observable.ts`, `packages/core/src/secrets/safe-tree.ts`, `packages/core/tests/control-plane-mutations.test.ts`, `packages/core/tests/hashDir.test.ts`, `packages/core/tests/inventory-store-import-planning.test.ts`, `packages/core/tests/secret-observability.test.ts`, `packages/cli/src/protocol/command-schema-fragments.ts`, `packages/cli/tests/control-plane-mutation-commands.test.ts`, `packages/cli/tests/control-plane-read-commands.test.ts`, `openspec/changes/add-isolated-resource-e2e-harness/**`, `openspec/specs/installable-cli-distribution/spec.md`, `openspec/specs/isolated-resource-e2e-acceptance/spec.md`
