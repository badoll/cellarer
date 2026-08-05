## 1. Secret Types and Observable Boundaries

- [x] 1.1 Add failing tests for reference parsing, non-serializable secret values, and leakage through every plan/state/journal/log/error/CLI/Web serializer
- [x] 1.2 Introduce typed environment and cellarer references plus a scoped non-serializable secret value wrapper
- [x] 1.3 Centralize sensitive-field and known-value redaction at all observable serialization boundaries

## 2. Reference-Only Rendering

- [x] 2.1 Update renderers to preserve typed reference tokens and remove resolved values from target-writer inputs
- [x] 2.2 Remove `allowResolvedPlaintext` from settings, Core APIs, CLI/Web inputs, fixtures, and documentation
- [x] 2.3 Add adapter validation that blocks targets requiring cellarer to materialize plaintext

## 3. Recursive Secret Guard

- [x] 3.1 Add fixtures for known secrets and probable credentials in nested Skill, Rules, and MCP staged files
- [x] 3.2 Implement the final recursive staged-tree guard with non-disclosing findings
- [x] 3.3 Add narrow versioned pattern suppressions and reject any global plaintext bypass

## 4. Provider and Input Hardening

- [x] 4.1 Move vault/keychain mutation under the transactional store protocol and add interruption tests
- [x] 4.2 Enforce atomic vault replacement and platform-appropriate current-user-only permissions through `Env`
- [x] 4.3 Replace positional CLI values with hidden input and explicit stdin or inherited-descriptor modes
- [x] 4.4 Add reference-presence verification that never exposes or persists resolved values

## 5. Security Verification and Documentation

- [x] 5.1 Add end-to-end canary-secret tests covering successful apply, blocked apply, thrown errors, activity, recovery, and Web responses
- [x] 5.2 Document reference-only compatibility, rotation guidance for prior exposure, and safe human/agent secret input in synchronized public docs
- [x] 5.3 Run relevant Core, CLI, and Web tests, then run `pnpm lint`, `pnpm typecheck`, and `pnpm build`

## 6. Closure Hardening

- [x] 6.1 Enforce strict operation-specific authorization of externally supplied apply and revert plans before every provider, prompt, lock, journal, target, store, activity, or presentation interaction, with constant non-disclosing invalid-plan results and zero effects
- [x] 6.2 Authorize versioned exact-key durable journals and recovery semantics independently of self-digests, fail unprovable apply, revert, gitignore, vault, and keychain recovery closed to manual recovery before claims, observation, providers, or effects
- [x] 6.3 Bind exactly one terminal gitignore synchronization action per affected project to the validated canonical execution context, managed root, product action set, and result ledger for apply and revert
- [x] 6.4 Guard final serialized Store, staged, and target bytes with an operation-scoped active-provider inventory and known-value plus high-confidence scanning across Skill, Rules, and MCP nested fields without extra provider reads or plaintext observation
- [x] 6.5 Remove plaintext resolver and vault APIs from the public Core boundary and keep internal secret consumption non-serializable, scoped, and non-observable across Core, CLI, and Web
- [x] 6.6 Run the complete positive and adversarial regression matrix, including legal apply/revert/gitignore and multi-action recovery, vault/keychain interruption, Koffi load and filesystem hardening, Core-Env boundaries, full Core/CLI/Web gates, strict OpenSpec validation, and diff checks

## 7. Scoped Mutation Authority and Plan Sealing

- [x] 7.1 Add failing tests for same-options apply/revert forgeries, cross-store plans, altered authorization envelopes, missing authority, and zero config/registry/ledger/target/provider/lock/journal/activity/presentation interactions
- [x] 7.2 Add a non-serializable, injected `MutationAuthority` with versioned HMAC-SHA-256 domain separation and deterministic fake-authority support; never expose raw key material through Core or observable serializers
- [x] 7.3 Seal executable apply, revert, and other mutating plans over the exact canonical payload and verify the store-scoped seal before trusted-option comparison, canonical replanning, or product-state interaction
- [x] 7.4 Remove or narrow public raw plan-minting APIs so callers cannot treat an unkeyed digest as executable authority, while preserving plan/apply presentation and legal in-process execution

## 8. Durable Journal Authorization and Recovery

- [x] 8.1 Add failing tests for self-consistent forged vault journals, altered durable plans and receipts, mixed/cross-store records, unknown epochs, replayed/truncated sequences, and zero provider/claim/target/effect behavior
- [x] 8.2 Seal durable plans and every exact-key journal publication with separate authority domains, store binding, authority epoch, monotonic sequence, and previous-seal chaining
- [x] 8.3 Verify candidate journal and durable-plan authorization before recovery claims or product-state observation, then retain revision, receipt, ownership, precondition, and operation-specific checks as independent necessary evidence
- [x] 8.4 Make missing, malformed, rotated, unsigned, or ambiguous recovery authority fail closed to manual recovery without legacy compatibility, automatic vault/keychain compensation, or disclosure

## 9. Authority Composition and Final Closure

- [x] 9.1 Preload or provision the store-scoped authority in CLI/Web composition using the existing OS-keychain dependency, support one explicit protected headless environment channel, and refuse silent ephemeral fallback for executable mutations
- [x] 9.2 Add authority lifecycle tests for first init, read-back verification, unavailable providers, Web injection, rotation refusal with an active journal, post-rotation invalidation, and Store move/clone scope mismatch
- [x] 9.3 Update synchronized English and Simplified Chinese CLI/security documentation for authority bootstrap, headless operation, rotation, failure recovery, and the unsigned-record breaking change
- [x] 9.4 Run the complete positive/adversarial Core, CLI, and Web matrix plus full build, test, typecheck, lint, strict OpenSpec validation, and diff checks

## 10. Authority Namespace and Lifecycle Concurrency

- [x] 10.1 Add failing tests for ordinary-secret authority-namespace collisions, concurrent first provisioning, rotation/mutation and rotation/recovery interleavings, and long-running stale processes
- [x] 10.2 Move authority credentials to a dedicated unreachable keychain namespace and reject that reserved service/account grammar from every ordinary secret-provider entry point
- [x] 10.3 Serialize first provisioning and rotation through authority coordination plus mutation/recovery exclusion, and expose only protected current-epoch checks and leases to execution
- [x] 10.4 Require authority currentness before canonical replanning and recheck it while holding the Store mutation lock so stale capabilities perform no product observation or external effects

## 11. Replay Anchor and Least-Privilege Composition

- [x] 11.1 Add failing tests for replay of an older all-receipts vault journal, missing/mismatched/unavailable protected tips, headless restart recovery, Web credential access, and authorityless scan dry run
- [x] 11.2 Persist the latest journal `{ operationId, sequence, seal }` in protected credential-manager state and require an exact match before automatic recovery
- [x] 11.3 Keep headless journal tips process-local and make active-journal recovery after process restart manual-only before claims, providers, observation, or compensation
- [x] 11.4 Remove the general `SecretStore` from Web composition, force environment-reference scanning there, and make authority optional for pure read-only planning while retaining executable-plan requirements

## 12. Closure Documentation and Verification

- [x] 12.1 Update synchronized English and Simplified Chinese security and CLI documentation for reserved authority namespaces, lifecycle serialization, protected replay tips, and headless restart limits
- [x] 12.2 Run the complete authority collision, concurrency, replay, stale-process, Web least-privilege, and dry-run adversarial matrix together with existing secret-safety regressions
- [x] 12.3 Run full test, typecheck, lint, build, strict OpenSpec validation, and diff checks and record only freshly observed results

## 13. Final Reviewer Findings Repair

- [x] 13.1 Add failing tests for headless cross-process epoch takeover with a live stale process, nested MCP extension/custom references, low-entropy sensitive fields in nested Skill JSON/JSONC/YAML/TOML, and absence of undeclared production dependencies
- [x] 13.2 Hold a liveness-checked Store-scoped headless authority owner for the process lifetime so a different epoch cannot become current while the prior process is live and stale processes cannot resume mutation
- [x] 13.3 Recursively discover reference kinds across every legal MCP value and apply per-file structured sensitive-field scanning before any staged or imported Skill snapshot can reach the Store
- [x] 13.4 Remove `koffi` and its lockfile packages, preserve dependency-free fail-closed recursive snapshot safety through injected runtime primitives, and reject unsupported platforms without weakening no-follow and stable-identity guarantees
- [x] 13.5 Update synchronized public documentation for headless process ownership and run the complete authority, MCP compatibility, Skill recursive guard, snapshot safety, Core/CLI/Web, package, strict OpenSpec, and diff verification matrix

## 14. Physical Scope and Cross-Boundary Guard Closure

- [x] 14.1 Add failing tests for physical Store aliases, final staged JSONC/YAML/TOML low-entropy values, unsupported placeholder defaults, malformed multiline structured content, and Windows single-file Rule/MCP safety
- [x] 14.2 Canonicalize the Store root through injected `realpath` before deriving authority, kernel owner, Core mutation, Web, seal, journal, and lock scopes, creating the root first only when initialization requires it
- [x] 14.3 Share one strict structured detector between import and final staged-tree guards, accept only supported typed references, and fail malformed structured files closed
- [x] 14.4 Separate portable no-follow identity-checked single-file snapshot capture from platform-gated recursive traversal so Windows Rule/MCP files remain supported while unsafe recursive directories fail closed
- [x] 14.5 Update synchronized English and Simplified Chinese documentation and run the focused authority, structured guard, snapshot, Core/CLI/Web, full workspace, strict OpenSpec, and diff verification gates

## 15. Final Structured and Authority Preflight Closure

- [x] 15.1 Add failing tests for sensitive-field arrays/objects, duplicate JSON/JSONC keys, low-entropy MCP scan input before journal publication, and stale-authority zero-observation across apply, add, scan-apply, and recovery diagnosis
- [x] 15.2 Preserve sensitive parent context through structured descendants, reject duplicate JSON/JSONC keys from exact source bytes, and apply the shared strict detector to MCP capture before snapshot persistence or protocol publication
- [x] 15.3 Gate every mutating Core entry point and recovery diagnosis on authority currentness plus lease before config, journal, protected-tip, lock, receipt, registry, ledger, target, or other product observation
- [x] 15.4 Ensure predictable structured-guard rejection occurs before durable-plan or journal publication, retains final-byte defense in depth, and leaves no manual-only active journal
- [x] 15.5 Update synchronized English and Simplified Chinese security documentation and run the focused structured, authority, recovery, scan/import, Core/CLI/Web, full workspace, strict OpenSpec, and diff gates

## 16. Sensitive Field Shape Matrix Closure

- [x] 16.1 Add a failing matrix for lower/separated/camelCase/PascalCase sensitive names, string/number/boolean/null scalars, nested arrays/objects, supported references, import/final staged guards, and Core/CLI/Web/error observable serialization
- [x] 16.2 Centralize sensitive-field normalization for common identifier styles and reuse it across structured detection and observable redaction without weakening the existing explicit field vocabulary
- [x] 16.3 Propagate sensitive parent context through every array/object descendant and treat every non-reference scalar type as a finding while preserving only exact supported typed references and the existing explicit empty representation
- [x] 16.4 Verify MCP/Skill import and final-byte guards block the complete mutation before protocol publication and observable boundaries redact nested container values without plaintext or reversible derivatives
- [x] 16.5 Update synchronized English and Simplified Chinese security documentation and run the focused shape matrix, secret-observability, scan/import, final-byte, Core/CLI/Web, full workspace, strict OpenSpec, and diff gates

## 17. Parser and Adapter Compatibility Closure

- [x] 17.1 Add failing matrices for plaintext reference-shaped fields, plural/fused sensitive names, YAML indentless sensitive sequences, non-string values after MCP secret flags, and built-in adapter reference dialect compatibility
- [x] 17.2 Remove broad reference metadata exemptions, extend the explicit sensitive vocabulary across singular/plural/separated/fused forms, and keep only exact typed-reference value and narrow non-secret enum exceptions
- [x] 17.3 Preserve sensitive context through valid YAML indentless sequences and every raw value after a sensitive command flag before normalization or protocol publication
- [x] 17.4 Declare environment-reference support only for built-in adapters whose documented native configuration consumes the exact current `${ENV_VAR}` output; make Codex, Cursor, OpenCode, and Windsurf fail closed until adapter-specific translation exists
- [x] 17.5 Update synchronized English and Simplified Chinese adapter/security documentation and run the focused classifier/YAML/MCP/adapter/observable matrix, full Core/CLI/Web gates, strict OpenSpec, and diff checks
