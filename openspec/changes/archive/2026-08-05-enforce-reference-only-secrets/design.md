## Context

Secret references are supported, but plaintext materialization can be globally permitted and enforcement is not one mandatory boundary around every staged output. Skill directories introduce recursive files, while plans, errors, logs, and Web responses create additional disclosure paths. This change uses the lock/journal/revision protocol from `add-transactional-change-protocol` for secret-store mutations.

## Goals / Non-Goals

**Goals:**

- Make reference-only target generation unconditional.
- Detect known values and likely embedded credentials throughout staged trees.
- Keep secret values out of plans, state, receipts, logs, errors, and response objects.
- Provide interactive and agent-safe secret input without shell argument exposure.
- Store vault values atomically with restrictive permissions or delegate to an OS keychain.
- Verify whether a reference is satisfiable without returning its value.
- Authenticate externally supplied plans and durable journals before they can authorize product-state observation or effects.

**Non-Goals:**

- A general-purpose secrets manager or secret synchronization service.
- Perfect detection of every unknown credential in arbitrary source text.
- Injecting plaintext into tools that do not natively resolve environment or cellarer references.
- Preserving the unreleased `allowResolvedPlaintext` setting.
- Accepting unsigned legacy plan or journal schemas.
- Persisting a mutation-authority key in the cellarer Store or exposing it through Core APIs.

## Decisions

### Preserve secret tokens until the consumer boundary

Core parses and validates `${ENV_VAR}` and `${CELLARER_SECRET:name}` as typed references. Rendering receives reference tokens, not resolved values. Resolution is allowed only for explicit secret verification or a future controlled process-launch boundary; target writers never receive resolved values.

This is stronger and easier to audit than resolving early and trying to redact later.

### Guard the complete staged tree before mutation

Every generated file and recursively staged Skill file passes one final secret guard before any destination write. The guard combines exact matching for values available from the configured secret providers with conservative credential-pattern detection. A finding identifies file, line/field location, and rule without echoing the matched value.

Probable unknown credentials are quarantined and require source remediation or an auditable pattern-specific suppression; there is no global “allow plaintext” switch.

Structured inspection operates on the exact captured bytes before protocol execution publishes a journal. It retains sensitive-field context through arrays and objects, and JSON/JSONC duplicate keys are ambiguous input that fails closed rather than allowing a later value to hide an earlier plaintext value. Skill, Rules, and MCP imports use this same pre-protocol guard; the final serialized-byte guard remains defense in depth, not the first place a normal validation failure can occur.

Sensitive field classification normalizes common lower, snake_case, kebab-case, dotted, camelCase, and PascalCase spellings before matching one shared vocabulary. Once a sensitive field establishes context, every descendant scalar type is sensitive: only an exact supported typed-reference string or the existing explicitly safe empty-string representation is accepted. Numbers, booleans, nulls, unsupported strings, and nested container descendants are findings. The same field normalization and parent-context propagation drives observable redaction so defense-in-depth output handling cannot disclose an object-shaped credential.

Reference-shaped field names are sensitive by default; only their values can prove an exception by matching the exact typed-reference grammar. Safe metadata exemptions are limited to fields whose values are non-secret enums, not generic `reference`, `references`, or `secretRefs` containers. The vocabulary explicitly closes singular, plural, separated, and fused forms for password, passphrase, access-key, private-key, client-secret, API-key, token, secret, and credential families.

### Centralize redaction at observable boundaries

Typed secret values use a non-serializable wrapper. Plan/state serializers reject it, while logger, error, activity, journal, CLI, and Web serializers share a redaction policy for known values and sensitive field names. Tests exercise every observable boundary.

Defense-in-depth redaction is retained even though renderers should never receive plaintext.

### Accept secret values through protected channels

Interactive CLI input is hidden and confirmation-capable. Non-interactive input uses a dedicated stdin mode or inherited file descriptor; values are never positional arguments, command options, environment echoes, or response data. If stdin is already used for a structured command request, a separate descriptor is required.

### Use transactional, permission-restricted providers

Vault writes use restrictive creation modes, atomic replacement, and the store mutation protocol. Keychain adapters operate through `Env`. Metadata may record provider and key name, but state and operation receipts never record the value or a reversible derivative.

### Treat digests as integrity evidence, not authorization

A plan or durable journal may carry a canonical digest or self-hash so accidental or partial corruption is detectable, but a matching digest never authorizes execution or recovery. Every externally supplied plan and every durable recovery record must also pass strict, versioned, exact-key schema validation plus operation-specific semantic authorization. That authorization proves the known operation and action kinds, the state-machine and receipt correspondence, the current ledger and ownership preconditions, the permitted target/effect, and the managed root before recovery claims, providers, target observation, or effects are allowed.

Records that are self-consistent but cannot prove their origin, target scope, operation-specific compensation, or current authorization fail closed to manual recovery. This deliberately rejects forged journals even when an attacker can recompute their self-digest.

### Bind external plans to one canonical execution context before effects

All product actions and auxiliary actions from an externally supplied apply or revert plan are validated as one ordered action set before provider access, secret prompts, lock or journal access, target or store observation, activity, or presentation. The validated object binds the operation, canonical execution options, managed store/project root, normalized targets, ownership and preconditions, and the exact derived helper actions. Execution consumes only that validated object.

Gitignore synchronization is derived from the validated product actions: each affected project has exactly one terminal sync action, and its project directory, target set, effect, digest, mode, and action identity must match the canonical execution context and result ledger. Missing, extra, reordered, re-signed, or cross-root helper actions invalidate the entire plan with zero calls or effects.

### Preload one scoped mutation authority at the composition root

`Env` receives a non-serializable `MutationAuthority` capability whose public surface can create and verify versioned domain-separated seals but never reveal the key. CLI and Web composition load the authority before handing any untrusted plan or journal bytes to Core. Persistent local use stores a randomly generated master key in the operating-system credential manager under a cellarer-owned service and a store-root-scoped account. Headless automation may instead inject the key through one explicit protected environment channel; it is never accepted through command arguments, JSON requests, config, state, plans, journals, logs, or responses.

There is no silent ephemeral fallback for a mutating operation. Dry-run presentation may remain unsigned only when it cannot be passed to an execution API; every executable plan requires a persistent or explicitly injected authority. Missing, unreadable, malformed, or newly rotated authority material blocks planning/execution and makes an existing journal manual-recovery-only. This intentionally favors loss of automation over accepting unauthenticated state.

The authority is loaded outside the Core mutation call. From the first Core preflight onward, seal verification is synchronous and side-effect-free. Reading the candidate plan bytes, or the one candidate active-journal file during recovery, is input acquisition; no config, registry, ledger, receipt, product Store path, target, provider, prompt, lock, claim, activity, presentation, or mutation effect is allowed until the applicable seal verifies.

### Seal plans, durable plans, and journals with domain separation

The versioned authorization envelope contains only a safe authority identifier, scope version, algorithm identifier, and MAC. HMAC-SHA-256 uses separate canonical domains for executable plans, durable plans, and journal states. Every seal binds the normalized store root, operation, base revision, plan id, exact canonical payload, and authority epoch. A plan copied to another store, changed and re-digested, or presented after authority rotation fails the same constant authorization result before canonical replanning or product observation.

Planning seals only the final canonical plan. Execution verifies the plan seal before comparing caller-owned options or reconstructing the canonical plan. `createMutationPlan` is no longer a public way to mint executable authority: trusted planners receive the injected capability, while tests use a deterministic fake authority. Callers can serialize a sealed plan, but cannot mint or alter one without the protected key.

The durable plan carries its own domain-separated seal derived from an already-authorized executable plan. Every journal publication increments a sequence, binds the previous journal seal, and seals the complete exact-key journal state excluding the seal itself. Recovery first verifies the journal envelope, store binding, durable-plan seal, chain fields, revision relationship, and operation schema. A valid seal is necessary but not sufficient: receipt, current revision, ownership, target preconditions, and operation-specific compensation must still prove the proposed recovery. Any ambiguity remains manual-only.

### Keep authority lifecycle outside OpenSpec and product state

Authority provisioning is a composition responsibility, not a second cellarer ledger. `cellarer init` creates the keychain entry only when absent and verifies that it can be read back before Core initializes the Store. Other mutating commands load but never rotate it implicitly. Rotation is an explicit local maintenance action, is refused while an active journal exists, invalidates all outstanding plans, and makes records from a prior epoch manual-only. Store cloning or moving changes the normalized scope and therefore cannot reuse sealed plans or journals accidentally.

The existing `@napi-rs/keyring` CLI dependency provides the protected persistent backend, so no production dependency is added. Platforms without a usable credential manager must provide the protected environment authority before mutation; read-only commands remain available. The Web server receives the already loaded authority from its CLI/server composition instead of loading credentials in route handlers.

### Isolate authority credentials and coordinate lifecycle changes

The mutation authority uses a dedicated credential-manager service and an internal account grammar that ordinary secret names cannot address. Secret-provider APIs reject the reserved authority service and account namespace, so a valid `secret set` or `secret rm` operation cannot overwrite or delete authority material.

Authority scope is the physical Store identity, not the caller's lexical spelling. Composition creates the Store root when initialization requires it, resolves the root through injected `Env.fs.realpath`, and uses that canonical physical path consistently for authority accounts, headless kernel ownership, Core mutation options, Web composition, seals, journals, and locks. Relative paths, symlink aliases, and case aliases that resolve to the same Store therefore cannot acquire a second authority owner or mint a differently scoped record.

Provisioning, rotation, and mutation execution share an authority-coordination boundary. First initialization is serialized and returns only the credential that wins protected publication. Rotation acquires authority coordination plus the existing mutation/recovery exclusion before checking journals and replacing the credential. Executable operations verify authority in memory, check that its epoch is still current before canonical replanning, acquire the authority lease, recheck currentness, and recheck again while holding the Store mutation lock before any external effect. A long-running process with a stale capability therefore cannot continue minting or executing plans after rotation.

Every mutating Core entry point performs the currentness check and acquires the authority lease before reading config or any other product Store state. Recovery diagnosis applies the same gate before reading journals, protected tips, locks, receipts, or other product evidence. Read-only operations remain authority-optional, but a mutating or recovery path with a stale capability returns the same closed result with zero product observation.

The injected authority exposes only synchronous seal/verify plus an asynchronous currentness check and lease; it never exposes raw credential bytes or a general `SecretStore` capability to Core or Web.

### Anchor the latest journal seal outside the journal file

Sequence and previous-seal chaining detect local tampering but cannot alone detect replacement of the whole active journal by an older valid publication. Credential-manager composition therefore keeps a protected journal tip containing only `{ operationId, sequence, seal }`. Automatic recovery requires the active journal to match that protected tip exactly. Missing, unreadable, mismatched, or stale protected-tip evidence makes recovery manual-only before claims, providers, product observation, or compensation.

For explicit headless environment authority, the tip is process-local and non-persistent. Recovery can continue automatically only within the process that observed every publication; after restart, any active journal is manual-only. This restriction is intentional because the configured headless channel supplies authority but no independent protected monotonic storage.

The same absence of protected monotonic storage means a headless process cannot discover that another process received a newer environment epoch. Headless composition therefore acquires one Store-scoped kernel lifetime lease, not merely a Store-file lock and not merely a per-mutation lease. The real injected `Env` capability exclusively listens on loopback at a deterministic Store-scoped local port, never connects to an incumbent, and unreferences the server so it does not keep a command alive. Kernel ownership disappears when the process exits; only then can a new process bind before planning. Store files are untrusted diagnostics at most: deleting, replacing, or replaying old owner bytes cannot change currentness. A live owner, unrelated local listener, or deterministic port collision all produce the same fail-closed refusal. This deliberately serializes headless mutation-capable processes and prevents a stale long-running process from resuming after a newer epoch has won.

### Give Web only the minimum credential capability

The Web server receives the preloaded mutation authority but not the general keychain/vault `SecretStore`. Web scan/import composition forces environment-reference mode, so read-only routes cannot query credential providers even when the Store configuration defaults to keychain. Pure read-only dry-run planning accepts an absent authority; only an executable plan or mutation endpoint requires one.

### Block incompatible adapters

Adapter validation declares how its target resolves references. Reference discovery recursively covers every legal MCP value, including stdio/remote extension fields and custom server configuration. If an adapter requires cellarer to materialize a secret in a generated file, planning fails with an incompatibility diagnostic. This avoids agent-specific exceptions in Core.

`supportedSecretReferences` describes the exact bytes and structure emitted by the current adapter, not a target's abstract ability to use environment variables. The generic renderer currently preserves `${ENV_VAR}` literally, so only built-ins whose documented native configuration consumes that exact syntax may declare `environment`. Targets that require a different token (`{env:NAME}` or `${env:NAME}`) or a structural field such as an environment-variable allowlist declare no support until a later adapter-specific renderer exists. Planning fails closed rather than writing an inert literal.

Skill trees are scanned file by file at both import and final staged-tree boundaries. JSON, JSONC, YAML, and TOML use one shared strict structured detector, so low-entropy values under fields such as `password`, `token`, or `secret` cannot bypass the final guard. Only the supported typed reference grammar is exempt: shell-like defaults or other unsupported whole-string placeholders remain plaintext findings. Malformed structured files fail closed instead of falling back to permissive lexical scanning.

Sensitive-field context propagates to every descendant container value, and duplicate JSON/JSONC keys are rejected as ambiguous before semantic parsing can discard source bytes. MCP scan/import performs this structured inspection on the captured source before a durable plan or active journal is published.

The closure matrix crosses field spellings (lower, separated, camelCase, PascalCase), scalar kinds (string, number, boolean, null), nested arrays/objects, supported and unsupported references, and the import, final-byte, CLI/Web/error observable boundaries. A single shared classifier prevents one surface from accepting a field another surface would redact.

YAML coverage includes both indented and valid indentless sequences beneath sensitive mapping keys. Command-argument inspection propagates a sensitive flag to the complete following value regardless of whether the raw scalar is a string, number, boolean, null, array, or object, so parser coercion cannot postpone a predictable failure until final-byte execution.

Recursive snapshots use only injected `Env` and dependency-free runtime primitives. Regular single-file capture uses `lstat`, no-follow `open`, and `fstat` identity checks before reading, then revalidates identity after the read; this portable path keeps Rule and MCP single-file flows available on Windows. Recursive directories additionally require a platform capability that can prove anchored, no-follow, stable-identity traversal and fail closed before reading or copying when that capability is unavailable.

## Risks / Trade-offs

- [Pattern scanning can report false positives] → Return precise non-secret evidence and allow narrow, versioned rule suppressions attached to source files.
- [Reference-only output cannot support every third-party agent] → Mark incompatible adapters clearly and require native environment/reference support rather than weakening the invariant.
- [Known-value scanning touches sensitive values in memory] → Keep them in scoped non-serializable wrappers, avoid derived persistence, and clear buffers where the runtime permits.
- [stdin can conflict with JSON command input] → Require a separate inherited descriptor when both structured input and a secret are supplied.
- [Credential-manager availability can block mutation on headless systems] → Keep read-only behavior available and support one explicit protected environment channel; never fall back to a Store file or silent process-only key.
- [A valid old journal state can be replayed] → Bind store root, authority epoch, revision, operation id, monotonic sequence, and previous seal; require current revision/receipt/ownership evidence, and fail ambiguous or truncated recovery manual-only.
- [Authority rotation can strand an interrupted operation] → Refuse rotation while an active journal exists and treat unknown epochs as manual recovery rather than attempting compensation.
- [Authority verification becomes a universal mutation dependency] → Keep the interface small, synchronous, injected, and deterministic in tests; verify before all existing semantic and effectful paths.
- [Ordinary secret APIs can collide with authority credentials] → Reserve a dedicated credential service and unreachable internal account grammar, and reject the namespace at every ordinary provider entry point.
- [Provisioning or rotation can race with mutation] → Serialize lifecycle changes through authority coordination, reuse mutation/recovery exclusion, and recheck the current epoch before replanning and under the mutation lock.
- [A whole older authorized journal can be replayed] → Compare it with a protected external tip; when no persistent tip exists, require manual recovery after process restart.
- [Web composition can accidentally inherit credential access] → Inject only the authority capability and force environment-reference scanning in Web routes.
- [A newer headless environment epoch is invisible to an old process] → Hold one non-replayable Store-scoped kernel listener for the process lifetime; a different epoch cannot become current until the prior listener is released by process exit, and local resource contention fails closed.
- [Lexical aliases can split one physical Store into multiple authority scopes] → Canonicalize the Store root with injected `realpath` before deriving any authority, owner, seal, journal, lock, Core, or Web scope.
- [Malformed or loosely parsed structured content can bypass a boundary guard] → Reuse one strict detector at import and final staging, accept only typed references, and fail malformed structured files closed.
- [Parser normalization can hide duplicate keys or sensitive container descendants] → Detect duplicate keys from the source representation, propagate sensitive parent context recursively, and reject findings before protocol publication.
- [A stale authority can observe Store state through an outer mutating preflight or recovery diagnosis] → Gate every mutating and recovery entry point on currentness plus lease before config, journal, lock, receipt, or other product observation.
- [A predictable guard failure after journal publication can strand manual-only recovery state] → Run Skill, Rules, and MCP structured guards on captured source bytes before protocol execution; retain final-byte checking only as defense in depth.
- [Field spelling or scalar type differences can split guard and redaction behavior] → Normalize common identifier styles through one sensitive-field classifier, propagate context through every container, treat every non-reference descendant scalar as a finding, and reuse the same semantics at observable boundaries.
- [Reference metadata exemptions can become plaintext bypasses] → Classify reference-shaped fields as sensitive and exempt only values that parse as exact supported typed references; keep only narrow non-secret enum metadata exceptions.
- [Parser-specific containers or command coercion can lose sensitive context] → Cover YAML indentless sequences and propagate sensitive command flags to every following raw value type before normalization or protocol publication.
- [A built-in target may support environment variables through a different syntax or structure] → Declare support only for the exact current renderer/target contract and mark all unimplemented dialect translations incompatible.
- [Recursive Skill safety can tempt a native FFI dependency or disable safe single-file flows] → Keep portable no-follow identity-checked single-file capture separate from platform-gated recursive traversal and fail only unsupported recursive directories closed.

## Migration Plan

1. Introduce typed references, non-serializable secret values, and shared safe serializers.
2. Add recursive staged-tree scanning and boundary regression tests in report-only mode.
3. Remove `allowResolvedPlaintext`, block findings, and validate adapter reference compatibility.
4. Move vault/keychain mutation behind the transactional protocol and harden file permissions.
5. Replace positional CLI secret input and update synchronized security/CLI docs.
6. Add the injected authority contract and versioned plan/durable-plan/journal envelopes, then reject all unsigned records.
7. Preload the store-scoped authority in CLI/Web composition, provision it during init, and document the protected headless channel and rotation behavior.
8. Add same-options forged-plan, forged-vault-journal, cross-store, rotation, tamper, replay, interruption, and zero-interaction regression tests before closing the change.
9. Separate the authority credential namespace, serialize provisioning and rotation, and require current-epoch checks before replanning and while holding mutation exclusion.
10. Add a protected journal tip for credential-manager composition, restrict headless restart recovery, and remove general secret-store access from Web and authorityless read-only dry runs.
11. Add process-lifetime headless authority ownership, recursively inspect all MCP/Skill secret-bearing fields, and remove the accidental native FFI production dependency before the final close gate.
12. Canonicalize physical Store scope, unify strict structured detection at import and final staging, and separate portable single-file capture from platform-gated recursive traversal.
13. Reject duplicate keys and sensitive container descendants, gate all mutating/recovery observation on current authority, and move MCP structured validation before protocol publication.
14. Close the field-shape matrix across camel/Pascal/separated names, all descendant scalar kinds, import/final guards, and observable redaction.
15. Close reference-field, plural/fused vocabulary, YAML indentless-sequence, raw command-argument, and built-in adapter dialect compatibility gaps.

Existing generated plaintext is reported as drift/security exposure and is not automatically copied into the vault. Users must rotate exposed values, replace targets with references, and then apply a clean plan.

## Open Questions

None. The authority backend is fixed to the existing system credential-manager dependency plus the explicit protected headless channel; additional backends require a later OpenSpec change.
