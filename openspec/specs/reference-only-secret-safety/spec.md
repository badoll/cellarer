# reference-only-secret-safety Specification

## Purpose
Define reference-only secret handling, mutation authorization, recursive guards, and non-disclosing observable behavior across Core, CLI, and Web.

## Requirements

### Requirement: Generated outputs preserve secret references
The system MUST write only supported secret reference tokens to generated targets and MUST NOT write a resolved secret value under any configuration mode.

#### Scenario: MCP field uses a cellarer secret
- **WHEN** an MCP configuration value is `${CELLARER_SECRET:github-token}`
- **THEN** the generated target contains that reference token and does not contain the stored value

#### Scenario: Caller requests plaintext materialization
- **WHEN** a caller or adapter requests that a resolved secret be written to a generated target
- **THEN** planning rejects the request as incompatible and produces no mutating plan

#### Scenario: Reference is nested in an MCP extension or custom configuration
- **WHEN** a stdio or remote extension field or a custom server configuration contains a reference kind unsupported by the selected adapter
- **THEN** recursive reference discovery rejects the adapter before target rendering instead of silently writing an unusable reference or materializing plaintext

#### Scenario: Built-in target uses a different native reference dialect
- **WHEN** a built-in target requires a different token syntax or structural environment-variable facility than the exact bytes emitted by its current adapter
- **THEN** the adapter declares that reference kind unsupported and planning rejects the complete target until an adapter-specific translation is implemented and verified

### Requirement: Every staged artifact passes a recursive secret guard
Before writing any destination, the system MUST scan all staged files for known secret values and configured credential patterns and SHALL block the complete mutation when a finding is present.

#### Scenario: Nested Skill file contains a known value
- **WHEN** a file nested in a staged Skill directory contains a value known to a configured secret provider
- **THEN** the plan is blocked and identifies the source location without returning the value

#### Scenario: Staged content matches a credential pattern
- **WHEN** staged content contains a probable credential unknown to configured providers
- **THEN** the system quarantines the artifact until the source is remediated or a narrow rule-specific suppression is recorded

#### Scenario: Nested Skill structured file contains a low-entropy secret field
- **WHEN** JSON, JSONC, YAML, or TOML inside a staged or imported Skill tree contains a non-reference value under a sensitive field such as `password`, `token`, or `secret`
- **THEN** the complete Skill import is blocked before any snapshot byte is written to the Store, even when the value does not match a high-entropy pattern and is unknown to configured providers

#### Scenario: Existing Store Skill contains structured low-entropy content
- **WHEN** a pre-existing Store Skill reaches the final staged-tree guard with a low-entropy sensitive value in JSON, JSONC, YAML, or TOML
- **THEN** the complete mutation is blocked before any destination write by the same strict structured detector used during import

#### Scenario: Sensitive field contains an unsupported placeholder
- **WHEN** a sensitive field contains a whole-string placeholder outside the supported typed reference grammar, such as `${MISSING:-hunter2}`
- **THEN** the value is treated as plaintext and the import or staged mutation is blocked

#### Scenario: Structured secret-bearing file is malformed
- **WHEN** a JSON, JSONC, YAML, or TOML file cannot be parsed unambiguously by the strict structured detector
- **THEN** the operation fails closed before snapshot, staging, or destination writes instead of falling back to permissive lexical scanning

#### Scenario: Sensitive field contains a container value
- **WHEN** a sensitive field such as `token` or `password` contains an array or object with a non-reference descendant value
- **THEN** sensitive-field context propagates through every descendant and the operation is blocked before any Store, protocol, or destination write

#### Scenario: Sensitive descendant uses a non-string scalar
- **WHEN** a sensitive field or any descendant beneath it is a number, boolean, or null instead of an exact supported typed-reference string
- **THEN** the value is treated as a non-reference finding and is blocked at import and final staged boundaries before protocol or destination writes

#### Scenario: Sensitive field uses a common identifier style
- **WHEN** a structured field uses lower, snake_case, kebab-case, dotted, camelCase, or PascalCase spelling such as `accessToken`, `refresh_token`, or `ClientSecret`
- **THEN** one shared normalized classifier recognizes the field consistently in Skill, Rules, MCP, final-byte, and observable-output guards

#### Scenario: Sensitive field uses a plural or fused spelling
- **WHEN** a field uses a common plural, separated, or fused form such as `passwords`, `passphrases`, `accessKeys`, `privatekeys`, or `clientsecrets`
- **THEN** the shared explicit vocabulary recognizes it without relying on arbitrary substring matching

#### Scenario: Reference-shaped metadata contains plaintext
- **WHEN** `reference`, `references`, or `secretRefs` contains any scalar or descendant that is not an exact supported typed reference
- **THEN** structured and observable guards treat it as sensitive plaintext; the field name alone never exempts its value

#### Scenario: YAML uses an indentless sequence beneath a sensitive key
- **WHEN** valid YAML places an indentless sequence directly beneath a sensitive mapping key
- **THEN** every sequence item and nested descendant inherits the sensitive parent context and non-reference values are blocked

#### Scenario: MCP secret flag is followed by a non-string value
- **WHEN** a sensitive MCP command flag is followed by a number, boolean, null, array, or object in the raw source
- **THEN** the source guard blocks the complete mutation before normalization, durable-plan creation, or journal publication

#### Scenario: Structured input contains duplicate keys
- **WHEN** JSON or JSONC source repeats a key so semantic parsing could hide an earlier plaintext sensitive value behind a later value
- **THEN** the exact source is rejected as ambiguous before snapshot persistence, durable-plan creation, journal publication, or destination writes

#### Scenario: MCP source contains a low-entropy sensitive field
- **WHEN** a scanned or imported MCP source contains a low-entropy non-reference value in a sensitive field that is unknown to configured providers and does not match a high-confidence credential pattern
- **THEN** the captured source is blocked before the mutation protocol publishes a durable plan or active journal; the final-byte guard is not the first rejection boundary

#### Scenario: Windows captures a single Rule or MCP source
- **WHEN** a Rule or MCP source is one regular file on Windows
- **THEN** the system preserves support by checking no-follow file identity before and after reading through injected filesystem effects

#### Scenario: Recursive directory safety is unsupported
- **WHEN** the platform cannot prove anchored no-follow stable-identity traversal for a recursive Skill directory
- **THEN** the operation returns a stable unsupported-platform failure before reading or copying any directory content

### Requirement: Observable data never discloses secret values
Plans, state, journals, receipts, activity, logs, errors, CLI output, and Web API responses MUST reject or redact resolved secret values and MUST NOT persist reversible secret derivatives.

#### Scenario: Renderer throws after receiving sensitive input
- **WHEN** an error occurs while processing a secret-backed field
- **THEN** the returned error and diagnostic output identify the field or reference but not the secret value

#### Scenario: Operation receipt is inspected
- **WHEN** a completed secret metadata operation is serialized
- **THEN** the receipt contains provider and reference metadata only

#### Scenario: Sensitive observable field contains nested containers
- **WHEN** an error, log, CLI payload, or Web response contains arrays or objects beneath a sensitive field in any supported identifier style
- **THEN** sensitive parent context propagates to every descendant scalar and the observable serializer redacts it without returning the original value

### Requirement: Secret input avoids process argument exposure
The CLI MUST accept new secret values only through hidden interactive input or an explicit protected non-interactive input channel and MUST NOT accept the value as a positional argument or option value.

#### Scenario: Human adds a secret interactively
- **WHEN** a terminal user runs the secret add command without a value channel
- **THEN** the CLI reads hidden input and never echoes or returns the value

#### Scenario: Agent adds a secret non-interactively
- **WHEN** an agent supplies the value through the documented stdin or inherited-descriptor mode
- **THEN** the command stores it without including it in process arguments, stdout, or stderr

#### Scenario: Structured request already occupies stdin
- **WHEN** stdin contains a structured command request and the request also adds a secret
- **THEN** the CLI requires a separate protected descriptor and rejects an ambiguous shared stream

### Requirement: Secret stores mutate safely
The system SHALL mutate vault or keychain entries under the store transaction protocol and file-backed vault data MUST use atomic replacement and restrictive permissions.

#### Scenario: Vault process stops during update
- **WHEN** execution is interrupted while replacing the encrypted vault file
- **THEN** recovery observes either the complete previous vault or the complete next vault and never a partially written plaintext artifact

#### Scenario: Vault file permissions are too broad
- **WHEN** the file-backed vault is readable beyond the current user according to the platform policy
- **THEN** verification reports a security failure and secret mutation is blocked until repaired

### Requirement: Reference verification does not expose values
The system SHALL report whether required environment and cellarer secret references are present and usable without resolving them into an observable result.

#### Scenario: Required secret is missing
- **WHEN** a selected resource requires a reference not available from its configured provider
- **THEN** planning reports the missing reference name and blocks apply without returning any other secret metadata

### Requirement: Externally supplied mutations require durable semantic authorization
The system MUST treat a matching plan or journal digest only as integrity evidence and MUST authorize every externally supplied executable plan and durable recovery record with an independently provisioned, versioned, store-scoped mutation authority plus strict exact-key and operation-specific semantic checks. After acquiring the candidate plan bytes, or the candidate active-journal bytes during recovery, the system MUST verify the applicable authority seal before any config, registry, ledger, receipt, other product Store path, target, provider, prompt, lock, recovery claim, activity, presentation, or mutation effect interaction.

#### Scenario: Self-consistent forged revert plan is supplied
- **WHEN** a digest-valid revert plan has an invalid operation, action kind, field set, owner-target identity, capability scope, artifact ownership, snapshot or acknowledgement token, ledger binding, or managed root
- **THEN** the system returns a constant non-disclosing invalid-plan result and performs zero calls or effects

#### Scenario: Self-consistent forged recovery journal is supplied
- **WHEN** a journal with a valid self-digest contains an unknown action, extra field, receipt/status mismatch, unauthorized target or effect, or an operation-specific compensation that cannot be proven
- **THEN** diagnosis and recovery fail closed to manual recovery before claiming the operation, observing the target, invoking a provider, or performing an effect

#### Scenario: Same-options plan is changed and re-digested
- **WHEN** an external caller preserves trusted apply or revert options but changes an action, target, payload, precondition, selection, ownership binding, or helper and recomputes every unkeyed digest
- **THEN** authority verification returns the same non-disclosing invalid-plan result before canonical replanning or any product Store or target observation

#### Scenario: Vault recovery journal is changed and re-digested
- **WHEN** a caller constructs a self-consistent secret-metadata journal whose vault action, receipt, and before/after evidence would otherwise authorize compensation against the canonical vault path
- **THEN** recovery rejects the missing or invalid authority seal before a recovery claim, vault observation, provider access, journal update, or vault removal

### Requirement: Mutation authority is protected and scoped
Every executable mutation plan and recoverable durable journal MUST be sealed by a non-serializable mutation authority that is loaded before untrusted mutation input reaches Core. The raw authority key MUST remain outside the cellarer Store and all observable data. Every seal MUST bind its version, algorithm, authority identifier and epoch, normalized store root, operation, base revision, record domain, and exact canonical payload.

#### Scenario: Persistent local authority is provisioned
- **WHEN** cellarer initializes a Store with an available operating-system credential manager
- **THEN** the composition root creates or loads one store-scoped authority key from that protected provider and injects only a seal/verify capability into Core

#### Scenario: Headless authority is supplied
- **WHEN** a headless or CI process cannot use the operating-system credential manager and supplies the documented protected environment authority
- **THEN** the composition root injects it without accepting the key through arguments, JSON input, config, state, plans, journals, logs, or responses

#### Scenario: Headless epoch changes while an older process is alive
- **WHEN** a process holds a headless authority epoch and another process is configured with a different epoch for the same Store
- **THEN** a non-replayable kernel process-lifetime authority owner prevents the new epoch from becoming current until the prior process exits, after which the new owner is established before planning and the old process cannot resume product observation or effects

#### Scenario: Headless owner evidence in the Store is replayed
- **WHEN** a writer deletes, replaces, or replays any Store file that claims an older headless process owns the authority
- **THEN** currentness remains bound only to the injected local kernel lifetime lease, the stale process remains non-current, and its executable plans perform no product observation or effects

#### Scenario: Physical Store is addressed through an alias
- **WHEN** relative, symlink, or case aliases resolve to the same physical Store root
- **THEN** composition derives one canonical authority account and kernel lifetime owner before planning, and all Core, Web, seal, journal, and lock scopes use that same physical identity

#### Scenario: Stale authority enters a mutating or recovery path
- **WHEN** a mutating apply, add, scan-apply, or recovery diagnosis receives a structurally valid authority whose currentness check fails
- **THEN** the operation rejects before reading config, journal, protected tip, lock, receipt, registry, ledger, target, or any other product state and performs zero external effects

#### Scenario: Authority is unavailable or malformed
- **WHEN** a mutating command, external plan, or recovery attempt has no usable authority, an unknown authority epoch, or malformed authorization metadata
- **THEN** no executable plan is minted and execution or recovery fails closed without product-state observation or effects; there is no silent ephemeral or unsigned compatibility fallback

#### Scenario: Sealed record is moved to another Store
- **WHEN** a valid sealed plan or journal is copied to a different normalized store root
- **THEN** verification rejects its scope before canonical replanning, recovery claim, product Store access, or target observation

### Requirement: Durable journal states remain independently verifiable
Every durable plan and every publication of an active journal MUST carry a domain-separated authority seal. Each journal update MUST increment a sequence and bind the preceding seal, while recovery MUST treat valid cryptographic authorization as necessary but not sufficient and MUST also prove current revision, receipt, ownership, preconditions, and operation-specific recovery semantics.

#### Scenario: Journal state is altered or mixed
- **WHEN** any durable-plan field, journal field, action receipt, sequence, previous seal, operation, store binding, or authorization envelope is changed, reordered, removed, or combined from another operation
- **THEN** recovery fails closed before claims, product-state observation, providers, or effects

#### Scenario: Authorized journal is replayed or truncated
- **WHEN** an older authorized journal state is replayed, the seal chain is truncated, or its revision and receipt evidence no longer match current durable state
- **THEN** recovery performs no automatic compensation and reports manual recovery without disclosing authority or secret material

#### Scenario: Older complete publication is replayed
- **WHEN** an attacker replaces the active journal with an older fully authorized publication whose receipts and current product state would otherwise permit compensation
- **THEN** recovery compares it with the independently protected latest-journal tip and performs no claim, provider access, product observation, or compensation when the tip is missing or does not match exactly

#### Scenario: Headless process restarts with an active journal
- **WHEN** authority came from the protected headless environment channel and a new process discovers an active journal without the process-local protected tip that observed its publications
- **THEN** recovery is manual-only before claims, providers, product observation, or compensation

#### Scenario: Authority rotates with outstanding state
- **WHEN** authority rotation is requested while an active journal exists
- **THEN** rotation is refused; after an authorized rotation, outstanding plans and records from the prior epoch are rejected and require explicit manual handling

#### Scenario: Ordinary secret targets the authority namespace
- **WHEN** a secret create, update, read, or remove request uses the mutation-authority credential service or internal account grammar
- **THEN** the ordinary secret provider rejects it without reading, overwriting, or deleting authority material

#### Scenario: Concurrent first initialization provisions authority
- **WHEN** multiple initialization processes race while no store-scoped authority exists
- **THEN** one protected authority credential wins serialized publication and every successful initializer receives that same current credential

#### Scenario: Rotation races with a mutation or long-running server
- **WHEN** rotation overlaps mutation planning, canonical replanning, lock acquisition, journal publication, recovery, or execution by a process holding the prior epoch
- **THEN** lifecycle coordination and current-epoch checks ensure the rotation or the mutation wins one serial order, and no stale process performs product observation or external effects after the new epoch becomes current

### Requirement: External action sets bind to the canonical execution context
The system MUST first verify the external plan's store-scoped authority seal and then validate every product and auxiliary action as one exact ordered set bound to the canonical operation options, managed store and project roots, normalized targets, ownership and preconditions, and derived action set before any subsequent interaction or effect. For each affected project, apply and revert SHALL contain exactly one terminal gitignore synchronization action derived from the validated product actions and result ledger.

#### Scenario: Gitignore helper is not exactly derived
- **WHEN** an otherwise self-consistent apply or revert plan contains a missing, extra, reordered, re-signed, or cross-root gitignore helper, or any helper field differs from the canonical execution context and validated product actions
- **THEN** the system rejects the complete plan with zero provider, lock, journal, target, store, activity, or presentation calls and leaves both managed and external projects unchanged

### Requirement: Authority composition follows least privilege
Composition roots MUST inject only the credential capability required by each surface. Read-only planning MUST NOT require mutation authority unless it returns an executable plan, and Web handlers MUST NOT receive or consult a general secret store for scan or import behavior.

#### Scenario: CLI performs a read-only dry run without authority
- **WHEN** a user requests a scan dry run that cannot be passed to an execution API and no mutation authority is available
- **THEN** the command returns read-only findings without provisioning, loading, or querying authority or secret credentials

#### Scenario: Web scans with keychain configured as Store default
- **WHEN** a Web scan or import route runs for a Store whose default secret provider is keychain
- **THEN** the route uses environment-reference mode and performs zero keychain, vault, or authority-provider calls

#### Scenario: Web receives mutation authority
- **WHEN** the CLI composition starts the Web server for mutation-capable routes
- **THEN** it injects only the preloaded store-scoped authority capability and no general `SecretStore`, raw key, credential-provider handle, or authority lifecycle operation

### Requirement: Inventory adoption preserves reference-only observability
Inventory secret adoption MUST NOT accept plaintext through argv, structured input, HTTP, or plan bytes and MUST NOT expose, log, hash for observability, persist in Store content, or return the adopted value. Only the protected apply capability MAY read the exact plan-bound local source value after authorization and precondition checks.

#### Scenario: Observable canary crosses adoption
- **WHEN** a known secret canary is adopted and every plan, journal, receipt, error, log, CLI record, and API response is serialized
- **THEN** the canary and reversible derivatives are absent while reference metadata remains usable
