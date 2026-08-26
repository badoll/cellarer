## 1. Isolated harness boundary and fixtures

- [x] 1.1 Add the Node.js ESM harness modules for canonical test-root resolution, containment checks, isolated environment composition, subprocess capture, closed reports, and explicit generated-path cleanup.
- [x] 1.2 Add deterministic Rules, MCP, valid Skill, blocked Skill, source-adapter, and `codebuddy-e2e` adapter fixtures under `test/fixtures`.
- [x] 1.3 Implement no-follow real-pool staging for one explicit absolute source, including before/after source fingerprints and typed rejection of unsupported filesystem nodes.
- [x] 1.4 Add `test/README.md` with fixture mode, real-pool input contract, generated topology, cleanup ownership, failure evidence, and CodeBuddy-fixture limitation.
- [x] 1.5 Add exact root ignore entries for harness runtime state and canonical generated Agent targets without ignoring tracked E2E sources or fixtures.

**Verification:** `node --test test/e2e/harness-boundaries.test.mjs`

## 2. Inventory-to-Store subprocess journey

- [x] 2.0 Add config-domain final-byte and validated-plan observable hooks, exclude the exact shell `PWD` key from environment secret inventory, canonicalize safe directory snapshot ordering, and add Core/CLI regressions proving valid custom MCP metadata and copied Skills survive real plan/apply checks while secret bytes, sensitive environment keys, and unvalidated lookalikes remain blocked.
- [x] 2.1 Implement the JSON protocol subprocess client that requires an installed `cellarer` command and records command identity, exit class, closed stdout/stderr envelopes, and phase evidence.
- [x] 2.2 Implement isolated init dry-run, machine init, typed custom-adapter creation, targeted post-commit refresh, and explicit targeted Inventory refresh assertions.
- [x] 2.3 Select exact ready Rules, MCP, and Skill candidate IDs, persist the serializable Store-import plan as evidence, and apply its unchanged bytes in a replacement process while proving Agent targets remain absent.
- [x] 2.4 Add deterministic blocked-candidate, missing-selection, altered-plan, and source-drift scenarios that prove Store revision and target snapshots remain unchanged on rejection.

**Verification:** `node --test --test-name-pattern="inventory|store import" test/e2e/resource-journey.test.mjs`

## 3. Multi-Agent targets, convergence, and revert

- [x] 3.1 Implement the project distribution plan/apply phase for Claude Code, Codex, `agents-md`, and `codebuddy-e2e` with Rules, MCP, Skills, and copy method bound into the sealed plan; align the existing JSON schema with emitted optional selection fields and targetless typed skips.
- [x] 3.2 Assert native Rules and MCP structures, exact contained target paths, typed unsupported-capability skips, one-write shared-target de-confliction, no-follow Skill trees, and Store-to-target relative-file hashes.
- [x] 3.3 Assert repeat apply leaves target bytes and current ownership state unchanged and that status and verify distinguish healthy desired state from disk drift.
- [x] 3.4 Add isolated unowned-target, owned-drift, reference canary, incompatible reference, and recovery-blocked scenarios with non-disclosing protocol and filesystem evidence.
- [x] 3.5 Persist a revert dry-run preview, repeat its exact selector in a replacement process, and assert it removes or restores only harness-owned targets while preserving Store, staging, caller source, tracked fixtures, and unrelated files.

**Verification:** `node --test --test-name-pattern="distribution|convergence|drift|secret|revert" test/e2e/resource-journey.test.mjs`

## 4. Packed artifact and sidecar acceptance

- [x] 4.1 Add the root `e2e:resources` script and an artifact-gate mode that builds, packs, cleanly installs the synchronized package set once without optional native dependencies, then passes the installed command path to the fixture journey.
- [x] 4.2 Prove the installed command shim and Core/Web/CLI runtime packages resolve inside the isolated consumer and outside workspace source before the journey starts.
- [x] 4.3 Start the installed sidecar against the completed CLI Store, compare stable Inventory/resource/status/verify fields, verify installed dashboard assets, and close the lifetime channel cleanly.
- [x] 4.4 Invoke the same resource journey from ordinary release readiness and keep local preparation free of publish, tag, release, dist-tag, deployment, and remote Git effects.
- [x] 4.5 Add the strict real-pool mode to the focused entrypoint and retain a closed failing report when staged candidates are not ready.

**Verification:** `pnpm e2e:resources && CI=true pnpm release:readiness`

## 5. Closure validation

- [x] 5.1 Review the final change-owned diff for path containment, cleanup allowlisting, subprocess trust boundaries, no-follow traversal, report closure, secret non-disclosure, and absence of new production dependencies.
- [x] 5.2 Run strict OpenSpec validation and the change preflight, then resolve any artifact or scope-contract finding before claiming implementation readiness.
- [x] 5.3 Run the supported full repository gates once after the focused resource acceptance is green.

**Verification:** `openspec validate add-isolated-resource-e2e-harness --strict && pnpm openspec:preflight --change add-isolated-resource-e2e-harness --json && pnpm build && pnpm test && pnpm lint && pnpm typecheck && git diff --check`
