# isolated-resource-e2e-acceptance Specification

## Purpose

Define deterministic installed-artifact acceptance for isolated Rules, MCP, and Skills discovery, Store import, multi-Agent distribution, verification, sidecar parity, and revert without mutating caller-owned sources or unrelated paths.

## Requirements

### Requirement: Resource acceptance runs in one bounded isolated environment
The project SHALL provide a deterministic resource acceptance entrypoint that invokes a cleanly installed `cellarer` command and confines its home, Store, temporary, source-staging, runtime-install, report, and Agent-target paths to the repository `test/` root. The harness MUST NOT resolve runtime packages or the command entrypoint from workspace source links.

#### Scenario: Acceptance starts from installed artifacts
- **WHEN** the resource acceptance entrypoint starts after the package set is packed and cleanly installed
- **THEN** it resolves `cellarer` from the isolated consumer command path and proves the resolved executable and runtime packages do not point into workspace source

#### Scenario: A path escapes the test root
- **WHEN** a requested mutable path, canonical target, cleanup target, or resolved runtime state path is outside the canonical `test/` root
- **THEN** the harness fails before cleanup, Store initialization, source copying, or product invocation and performs no write to that path

#### Scenario: A generated path is not harness-owned
- **WHEN** a cleanup target exists before the harness has established its ownership marker, or the marker is missing, altered, linked, or not a regular file
- **THEN** the harness refuses cleanup and preserves every existing path

#### Scenario: Native keychain is unavailable
- **WHEN** resource acceptance runs from the clean installation without optional native dependencies
- **THEN** initialization, planning, apply, verification, and revert complete without accessing a native credential manager

### Requirement: External Skills pools are staged without source mutation
The harness SHALL accept a repository fixture pool or one explicit absolute Skills-pool directory, SHALL copy eligible first-level Skill directories into harness-owned source staging without following symbolic links, and MUST prove the original source tree is unchanged after the run. Real-pool input MUST NOT be used as a Store or Agent target directly.

#### Scenario: A valid real Skills pool is supplied
- **WHEN** an absolute source directory contains regular first-level Skill directories with `SKILL.md`
- **THEN** the harness stages regular directory and file bytes beneath `test/.sandbox/source/skills` and retains a before/after fingerprint proving the caller's tree was not changed

#### Scenario: A source pool overlaps mutable harness state
- **WHEN** the canonical source pool is equal to, contains, or is contained by any cleanup or staging path
- **THEN** the harness rejects the input before cleanup and preserves the source tree

#### Scenario: The pool contains an unsupported filesystem node
- **WHEN** source staging encounters a symbolic link, escaping path, non-regular node, unstable identity, or unreadable entry
- **THEN** the harness returns a typed staging failure before Store import or Agent-target mutation and does not follow or copy that node

#### Scenario: Inventory observes staged resources
- **WHEN** the test-only source adapter is registered for the explicit `test/` project
- **THEN** Inventory discovers only its declared staged Rules, MCP, and Skills paths and does not recursively scan undeclared repository or home paths

### Requirement: Acceptance preserves Inventory, Store import, and distribution boundaries
The resource journey MUST assert Inventory refresh as read-only, Store import as an exact authority-sealed Store-only mutation, and distribution as the sole phase that writes Agent targets. Exact import and distribution plans SHALL be serializable and SHALL be applied unchanged by replacement CLI processes.

#### Scenario: Inventory refresh completes
- **WHEN** the staged source contains ready and needs-attention candidates
- **THEN** refresh returns both classes with stable typed evidence while Store and Agent-target snapshots remain unchanged

#### Scenario: Exact ready candidates are imported
- **WHEN** the controller selects a non-empty set of exact current `ready` candidate IDs
- **THEN** a replacement CLI process applies the unchanged sealed import plan, publishes one Store revision and receipt, and writes no Agent target

#### Scenario: Import selection is omitted or blocked
- **WHEN** the controller omits candidate IDs or includes an unknown, conflicted, unsafe, secret-bearing, or otherwise blocked candidate
- **THEN** import planning returns the typed rejection and creates no executable mutation plan

#### Scenario: A serialized plan or source is changed
- **WHEN** plan bytes are altered or a bound source changes between plan and apply
- **THEN** apply rejects the complete operation before publication and preserves the prior Store revision and target tree

### Requirement: Valid custom MCP adapters remain publishable without weakening secret guards
The system SHALL permit a closed-schema Cellarer configuration containing a custom MCP adapter's required non-secret `supportedSecretReferences` metadata to cross direct planning, serialized-plan apply final-byte checks, and the public CLI protocol renderer. This config-domain behavior MUST retain active-provider known-value detection and high-confidence plaintext-secret detection on the original serialized bytes, and MUST NOT alter the generic structured-secret or observable guard for other publication domains or unregistered lookalike values.

#### Scenario: A valid custom MCP adapter is added
- **WHEN** a typed custom adapter contains MCP paths, format, server key, and a schema-valid `supportedSecretReferences` enum list
- **THEN** direct mutation planning, unchanged serialized-plan apply, and the resulting schema-valid CLI envelope publish the adapter configuration without classifying that metadata as plaintext secret data

#### Scenario: Exact import assigns resources to a collection
- **WHEN** Inventory import derives a closed-schema membership configuration while a valid custom MCP adapter already exists
- **THEN** planning, serialized-plan decoding, and execution accept the non-secret adapter metadata and publish the exact requested membership

#### Scenario: An unvalidated protocol value resembles custom MCP metadata
- **WHEN** arbitrary or JSON-cloned output contains a `supportedSecretReferences` field without the identity of a Core-validated control-plane plan
- **THEN** observable serialization retains generic sensitive-field redaction and does not trust the field name alone

#### Scenario: The installed shell shim supplies its working directory
- **WHEN** the installed command process contains the standard uppercase `PWD` environment key and the same project path legitimately occurs in a signed mutation plan
- **THEN** environment secret inventory does not classify that standard working-directory value as a password while all other sensitive environment keys remain inventoried

#### Scenario: Valid configuration contains actual secret bytes
- **WHEN** any otherwise schema-valid configuration publication contains an active-provider known value or a high-confidence plaintext secret pattern
- **THEN** final-byte checking rejects the publication before a Store revision, receipt, or post-commit Inventory refresh is published

### Requirement: Acceptance verifies Rules, MCP, and copied Skills across multiple Agent layouts
The positive distribution journey SHALL target built-in Claude Code, Codex, and `agents-md` project adapters plus a test-only declarative `codebuddy-e2e` adapter. It MUST verify target containment, native Rules and MCP rendering, unsupported capability evidence, physical-target collision handling, and copy semantics for Skills.

#### Scenario: Positive multi-Agent distribution applies
- **WHEN** an unchanged current distribution plan selects project scope, Rules, MCP, Skills, and copy method for the four acceptance adapters
- **THEN** the installed CLI writes only the declared targets beneath `test/` and returns a committed operation receipt

#### Scenario: Agent-native targets are inspected
- **WHEN** the positive distribution completes
- **THEN** Claude Rules and Skills exist at `test/CLAUDE.md` and `test/.claude/skills`, Codex MCP exists at `test/.codex/config.toml`, shared generic Rules and Skills exist at `test/AGENTS.md` and `test/.agents/skills`, and the declarative fixture targets exist beneath `test/.codebuddy`

#### Scenario: Logical adapters share one physical target
- **WHEN** Codex and `agents-md` resolve Rules or Skills to the same normalized project target
- **THEN** the plan contains at most one physical write for that target and returns stable collision or de-confliction evidence for the skipped logical action

#### Scenario: Skills use copy method
- **WHEN** distribution applies a managed Skill to a supported target
- **THEN** no target node is a symbolic link and the target's portable relative file set and content hashes equal the managed Store revision

#### Scenario: A Skill mixes filename case and nested directories
- **WHEN** a no-follow Skill snapshot contains an uppercase `SKILL.md` and lowercase nested paths
- **THEN** source capture, Store installation, target ownership hashing, and postcondition verification use one deterministic code-point manifest order and produce the same content fingerprint

#### Scenario: An adapter does not support a selected capability
- **WHEN** `agents-md` is selected for MCP or another fixture lacks the selected scope
- **THEN** text and JSON protocol output record a typed unsupported skip with no target, executable actions retain non-empty targets, and apply does not create an undeclared target

#### Scenario: Existing distribution selectors are sealed in JSON output
- **WHEN** a distribution plan uses an existing optional resource, copy-method, MCP-strategy, or sync-profile selector
- **THEN** the JSON schema accepts the selector in normalized inputs and the unchanged sealed plan remains valid for replacement-process apply

### Requirement: Acceptance proves convergence, drift safety, non-disclosure, and revert
The harness SHALL verify a converged re-apply, healthy status and verification projections, default blocking of unowned or drifted targets, reference-only secret behavior, and previewed revert. A successful run MUST leave the original source and unrelated files unchanged.

#### Scenario: The same desired state is applied twice
- **WHEN** the positive distribution is planned and applied again without source, Store, selection, or target changes
- **THEN** target bytes and current ownership state remain unchanged and verification reports no desired or disk drift

#### Scenario: An unowned or owned-drifted target exists
- **WHEN** a negative scenario pre-creates an unmanaged target or edits an applied target
- **THEN** ordinary apply or revert is blocked with the exact typed conflict and no unacknowledged replacement or deletion occurs

#### Scenario: A secret canary backs a reference
- **WHEN** an MCP fixture uses a supported reference whose isolated provider value is a known canary
- **THEN** compatible targets preserve only the reference token, incompatible targets are rejected or skipped, and the canary is absent from Store bytes, targets, plans, journals, receipts, reports, stdout, and stderr

#### Scenario: Generated targets are reverted
- **WHEN** the controller persists a dry-run revert preview and a replacement process repeats the exact selector for intact harness-owned targets
- **THEN** only those owned targets and ownership records are removed or restored while the Store, staged source, original pool, tracked fixtures, and unrelated files remain unchanged

### Requirement: Deterministic and real-pool modes produce closed evidence
The repository fixture mode SHALL be the deterministic CI authority. Real-pool mode SHALL apply the same safety and product-boundary assertions to the explicit caller pool and SHALL fail before import when the pool cannot satisfy strict readiness. Both modes MUST emit one closed machine-readable report without raw authority material, secret values, arbitrary source contents, or absolute caller paths.

#### Scenario: Deterministic fixture mode succeeds
- **WHEN** the tracked fixtures satisfy the accepted positive and negative cases
- **THEN** the report identifies each completed phase, selected candidate and resource IDs, Store revisions, relative targets, portable hashes, and one final `passed` result

#### Scenario: Real-pool readiness fails
- **WHEN** a supplied pool contains a candidate that is invalid, unsafe, conflicted, secret-bearing, unreadable, or otherwise not ready under strict mode
- **THEN** the report identifies the candidate using typed redacted evidence, imports none of the pool, writes no Agent target, and returns a failing process status

#### Scenario: A phase fails unexpectedly
- **WHEN** an installed command, protocol assertion, filesystem assertion, or sidecar assertion fails
- **THEN** the report retains the last completed phase and a closed harness failure while ignored sandbox evidence remains available for inspection

### Requirement: Installed sidecar read models agree with the completed CLI journey
After the CLI journey commits, the artifact acceptance path SHALL start the installed loopback sidecar against the same isolated Store and home, authenticate through a supported local mode, and compare stable Inventory, resource, status, and verification fields with the CLI evidence. It MUST NOT duplicate the complete mutation journey through HTTP.

#### Scenario: Sidecar inspects the completed journey
- **WHEN** the installed sidecar reaches readiness after CLI distribution
- **THEN** authenticated `/api/v1` reads expose the same Store revision, managed resource identities, target health, and Inventory candidate states as the corresponding CLI results and dashboard assets are served from installed package files

#### Scenario: Sidecar lifetime ends
- **WHEN** the harness closes the inherited lifetime channel after parity checks
- **THEN** the sidecar exits cleanly without leaving a listener, child process, bearer value, or additional stdout record
