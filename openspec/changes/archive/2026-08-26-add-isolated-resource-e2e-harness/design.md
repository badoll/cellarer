## Context

The repository currently verifies resource behavior primarily through injected `Env` tests, in-process CLI tests, local API tests, and a release gate that builds, packs, installs, and smoke-tests published package shapes. Those layers prove important contracts independently, but no one acceptance journey starts with an isolated Skills/Rules/MCP source, uses bounded Inventory discovery, crosses process boundaries with unchanged sealed plans, distributes through a clean installed CLI to several project adapters, and then proves convergence, verification, non-disclosure, and revert.

The harness must preserve the same architectural boundaries as the product. Inventory observes declared sources, Store import mutates only Store state, distribution alone writes Agent targets, and secret values never enter observable or durable artifacts. Existing dirty work and user-supplied source pools are outside harness ownership.

## Goals / Non-Goals

**Goals:**

- Provide one deterministic local and CI entrypoint for the complete Rules/MCP/Skills resource journey.
- Exercise the cleanly installed `cellarer` executable through subprocess protocol boundaries rather than importing workspace implementation modules.
- Keep the canonical visible project targets at `test/.claude`, `test/.agents`, `test/.codex`, and `test/.codebuddy`, with every other mutable path under `test/.sandbox`.
- Support a deterministic repository fixture pool and an explicit real-pool acceptance mode without modifying the caller's pool.
- Produce stable machine-readable phase evidence and leave enough ignored output for local inspection.
- Reuse existing product behavior and existing fault-injection tests instead of adding a second transaction, discovery, or rendering implementation to the harness.

**Non-Goals:**

- Launching Claude Code, Codex, CodeBuddy, or another third-party Agent binary.
- Claiming official CodeBuddy path or schema compatibility; the CodeBuddy-shaped adapter is a declarative adapter fixture.
- Contacting remote MCP servers, cloning remote Skills, publishing packages, or changing remote state.
- Accessing or smoke-testing a user's native credential manager.
- Replacing focused Core, CLI, Web, recovery, concurrency, or secret-guard tests with one expensive journey.
- Adding public commands or protocol fields, or changing adapter defaults, Store data, ledger semantics, or target rendering. Correcting the published schema to accept fields and typed skips already emitted by the existing distribution planner is in scope.
- Weakening generic final-byte secret checks for arbitrary resource, journal, receipt, target, or unvalidated configuration data.

## Decisions

### 1. Use a Node.js subprocess harness, not an in-process Vitest suite

The tracked entrypoint will be a Node.js ESM program under `test/e2e/`. It will receive an installed CLI command path and invoke only that command with JSON output. Process environment, cwd, stdin/descriptors, exit status, stdout, and stderr will therefore cross the same public boundary as a real consumer.

Using Vitest to import `buildProgram()` was rejected because it can pass while package metadata, command shims, dependency resolution, process environment, or restart-safe plans are broken. A shell script was rejected because structured JSON assertions, Windows portability, no-follow traversal, containment, and exact cleanup are safer and clearer in Node.js.

### 2. Split tracked inputs from harness-owned mutable state

The topology is:

```text
test/
  e2e/                 tracked controller and assertions
  fixtures/            tracked deterministic Rules, MCP, Skills, and adapters
  .sandbox/            ignored owner marker, home, Store, source staging, scenarios
  .reports/            ignored closed machine-readable reports
  .claude/             ignored canonical target
  .agents/             ignored canonical target
  .codex/              ignored canonical target
  .codebuddy/          ignored canonical target
  CLAUDE.md             ignored canonical target
  AGENTS.md             ignored canonical target
  .mcp.json             ignored canonical target
  .gitignore            ignored distribution ownership marker
```

The positive journey uses `test/` itself as the explicit project root so the requested Agent directories are directly inspectable. Destructive and drift scenarios use separate project roots beneath `test/.sandbox/scenarios/` so they cannot invalidate the positive evidence. Exact root ignore entries keep a completed run from dirtying Git.

At startup the harness canonicalizes the repository and test roots, rejects symbolic or escaping managed roots, proves the caller-owned source does not overlap any mutable path, and snapshots it before cleanup. A first run refuses any pre-existing generated target; subsequent runs remove only a hard-coded allowlist after validating a harness ownership marker beneath `test/.sandbox`. It never recursively removes `test/`, `test/e2e`, or `test/fixtures`.

### 3. Stage the Skills pool, then expose it through a bounded source adapter

Deterministic mode copies tracked fixture Skills. Real-pool mode requires one explicit absolute directory whose first-level child directories are Skill candidates. The harness validates no-follow identities, rejects source/staging or source/cleanup overlap, and copies regular directories and files into `test/.sandbox/source/skills`; unsupported nodes remain a typed staging failure. It compares the original source snapshot before cleanup, during staging, and after the run.

A test-only `pool-source` custom adapter declares project-scoped Rules, MCP, and Skills paths beneath `test/.sandbox/source`. Inventory refresh targets only that exact adapter and explicit project root. This exercises the supported bounded-source model and avoids treating arbitrary repository traversal or direct Store copying as acceptance.

Direct `cellarer add` loops and manual writes to `CELLARER_HOME/store` were rejected because they would bypass Inventory candidate identity, provenance, needs-attention state, exact import planning, and source-precondition validation.

### 4. Keep discovery, import, and distribution as independently asserted phases

The controller records filesystem and Store snapshots around each phase:

1. `init --dry-run` and machine `init` establish isolated Store behavior without importing or writing Agent targets.
2. Custom source and CodeBuddy-shaped adapters are created through typed CLI mutations; their post-commit Inventory result is asserted separately from the mutation receipt.
3. Targeted Inventory refresh must expose Rules, MCP, and Skills candidates, including deterministic blocked fixtures, without changing Store or target snapshots.
4. The controller selects exact `ready` candidate IDs, creates an authority-sealed import plan, serializes it to a report, and applies the unchanged plan in a replacement CLI process. Store changes once and Agent targets remain absent.
5. A distribution plan binds Claude Code, Codex, `agents-md`, and `codebuddy-e2e`, project scope, all three capabilities, and `copy`. A replacement process applies the unchanged sealed plan.
6. Status, verify, repeat plan/apply, drift/conflict scenarios, and revert close the journey. The current CLI revert contract has no serialized `--plan` input, so the harness persists the dry-run preview and repeats the exact selector in a replacement process before checking the resulting target set.

This phase separation makes a failed acceptance report identify which product boundary failed instead of returning one undifferentiated command failure.

### 5. Verify physical targets, not only protocol success

The harness asserts the exact built-in project mappings and the custom adapter mapping. Rules must contain managed source markers, MCP must use each target's native JSON or TOML container, unsupported capabilities must appear as typed skips, and shared Codex/`agents-md` physical targets must be de-conflicted to one write.

Every distributed Skill target is traversed without following links. Its relative regular-file set, modes where portable, and SHA-256 content hashes must match the managed Store revision; `lstat` must prove the target is a copy rather than a symbolic link. A second identical apply must leave target bytes and current ownership state unchanged.

Protocol success without these disk assertions was rejected because renderer, path, method, or collision defects can otherwise look green.

### 6. Run from a clean packed installation without native keychain coupling

The artifact gate remains responsible for building, packing, and installing the synchronized Core/Web/CLI artifacts into an isolated consumer. The resource harness receives that installation's command path and an isolated environment. The focused resource entrypoint uses an install without optional native dependencies and a fixed test-only headless mutation authority, so it cannot interact with a user's credential manager.

The ordinary release-readiness path will invoke the same resource journey rather than maintaining a second release-only copy. A dedicated root script will select the focused artifact mode for local resource acceptance.

Running `packages/cli/dist/bin.js` directly was rejected as the acceptance authority because it does not prove tarball contents, command shim resolution, or independence from workspace links.

### 7. Keep secret and failure evidence deterministic and non-disclosing

Fixtures use local no-network MCP commands. A separate reference fixture sets a known canary only in the isolated process environment. Compatible adapters must preserve the reference token, incompatible adapters must return a typed skip or rejection, and the canary must be absent from source staging copies, Store publications, targets, plans, journals, receipts, reports, stdout, and stderr.

Deterministic negative scenarios cover invalid Skill structure, unsafe links or unsupported source nodes, same-name/different-content conflicts, omitted candidate selection, altered plans, source drift between plan and apply, unowned targets, owned drift, and unsupported capabilities. Timing-sensitive partial writes, process crashes, and lock races remain in focused fault-injection tests; the E2E journey only verifies that exposed recovery state blocks unsafe continuation.

### 8. Add installed sidecar read parity without duplicating mutation journeys

After the CLI journey commits, the artifact gate starts the installed sidecar against the same isolated home and Store using its existing lifecycle and authentication boundary. The harness compares stable Inventory/resource/status/verify fields with the CLI evidence and verifies dashboard assets. It does not repeat the complete mutation journey through HTTP because existing API mutation parity tests own that boundary.

### 9. Emit one closed report and preserve bounded diagnostics

Each phase appends a closed record containing status, command identity, exit class, selected candidate/resource IDs, revisions, relative target paths, and hashes. Raw authority material, environment values, source contents, absolute caller paths, and arbitrary exception text are excluded. Success writes a final `passed` summary; failure writes the last completed phase plus a typed harness failure and retains ignored sandbox evidence for inspection.

### 10. Treat validated Cellarer configuration as a distinct publication and observable domain

The E2E journey exposed that the generic structured-secret scanner treats the required field name `supportedSecretReferences` as a sensitive-value container. A valid custom MCP adapter therefore cannot currently cross the real Store mutation boundary or the CLI protocol renderer even though its values are closed schema enums and not credentials.

Config planning and serialized-plan apply already validate the complete publication with the closed Cellarer config schema before final-byte checking and again under the mutation lock. Those paths, including the collection-membership configuration action created by exact Inventory import, will use an explicit config-domain final-byte hook: it still rejects active provider plaintext where the calling boundary supplies it and high-confidence secret byte patterns in the original serialized bytes, but it does not reinterpret schema-validated metadata field names or map keys as credential containers. Every other Store publication retains the generic structured-secret guard.

The protocol boundary will preserve the same metadata only inside a control-plane mutation plan whose object identity Core registers after decoding and validating its typed business input. A JSON clone, arbitrary lookalike, or unvalidated nested object retains generic sensitive-field redaction. This keeps the trust decision attached to the validated domain object instead of turning a field name into a global exception.

The packed shell shim also introduces the standard `PWD` environment variable. Environment secret inventory will exclude only that exact standard key before applying the general sensitive-name classifier; otherwise an isolated project path can be mistaken for a password and rejected when it legitimately appears in a signed plan. Lowercase or arbitrary `pwd` fields outside this environment-name boundary remain sensitive.

No-follow directory snapshots will normalize their flat node manifests by deterministic code-point path order before deriving fingerprints, identity evidence, publications, or later verification. The runtime verifier will compare the same canonical path order rather than depending on the filesystem adapter's capture-array position. This matches the existing target ownership directory hash and avoids locale-aware ordering differences for common Skill layouts such as uppercase `SKILL.md` beside lowercase subdirectories.

A global safe-field exception was rejected because arbitrary resource JSON or protocol data could then hide a secret beneath the same property name. Removing final-byte checks from config publication was also rejected because collection descriptions, paths, and future schema fields must still be checked against active provider values and high-confidence patterns.

### 11. Keep the distribution JSON schema aligned with existing typed plan output

The installed multi-Agent plan exposed two schema drift cases in behavior that the planner already emits and Core already validates: optional `method` in sealed normalized inputs, and a targetless `skip` when an adapter does not support a selected capability. Text output succeeds, but JSON output rejects the same valid plan before it can cross the protocol boundary.

The command schema will enumerate the existing optional distribution selectors accepted by the sealed-plan decoder (`resourceIds`, `method`, `mcpStrategy`, and `syncProfile`) and will permit an empty target only when the action is a typed `skip`. Executable actions continue to require a non-empty target, Core authorization and semantic validation remain unchanged, and no new command or plan field is introduced.

## Risks / Trade-offs

- [Running against `test/` can collide with pre-existing user files] → Preflight every canonical target, refuse unknown files by default, and clean only the explicit harness-owned allowlist.
- [A real Skills pool is not deterministic] → Keep repository fixtures as the CI authority and make real-pool mode a separate strict acceptance that reports the exact blocked candidate.
- [Packed install makes the focused test slower] → Pack and install once per gate, pass the installed command to the harness, and keep fault injection in focused tests.
- [Codex and `agents-md` intentionally share physical targets] → Assert one normalized physical write plus typed collision evidence instead of expecting one directory per logical adapter.
- [The CodeBuddy-shaped fixture could be mistaken for official support] → Name the adapter `codebuddy-e2e`, document it as test-only, and assert only declarative-adapter behavior.
- [OS file modes and symlink behavior differ] → Require no symlink targets everywhere, compare portable file sets and hashes, and condition mode assertions on platform support.
- [Native keychain loading would weaken isolation] → Use the clean no-optional installation and avoid provider-dependent acceptance in this change.
- [A config-specific exception could weaken non-disclosure] → Enable it only after closed config-schema validation, retain raw known-value and high-confidence byte scanning, and test that a valid custom MCP adapter succeeds while a real canary in another valid config field is still rejected.
- [Excluding `PWD` could hide a credential with an ambiguous name] → Exclude only the uppercase standard shell environment key during environment inventory; keep the shared field classifier and every other key unchanged.
- [Changing snapshot ordering changes candidate fingerprints] → Change only the canonical order, keep node paths/modes/bytes unchanged, and prove equivalent source and installed trees share one fingerprint; callers must replan from current Inventory as with any fingerprint-version change.
- [Relaxing the skip target schema could admit an executable empty target] → Make the empty-target allowance conditional on `op: "skip"`; retain non-empty targets for every executable action and preserve Core sealed-plan validation.

## Migration Plan

1. Add the validated-config final-byte correction and its focused Core/CLI regression tests.
2. Add fixtures, the standalone harness, bounded ignore rules, and the focused package script without changing the existing release command.
3. Integrate the harness with the clean installed-artifact path and make the focused command pass locally.
4. Add the same invocation to ordinary release readiness and verify the supported OS/Node matrix.
5. Roll back by removing the config-domain hook, new script, harness, fixtures, and release-gate invocation; no Store or product-data migration is required.

## Open Questions

None. Official CodeBuddy compatibility, real third-party Agent execution, and broader live MCP acceptance require separate changes with authoritative external contracts.
