## Context

Ordinary Inventory classifies any probable plaintext secret as `needs-attention` and ordinary import is provider-free. Standard MCP formats, however, contain well-known env, header, argument, or URL fields that can be converted to a reference without rewriting the original source. This crosses source read, protected provider write, and Store publication, so it is isolated from the base path.

## Goals / Non-Goals

**Goals:**

- Support explicit adoption for narrowly recognized MCP fields with zero plaintext observability.
- Preserve exact authority and source preconditions across provider and Store effects.
- Make partial cross-provider failure recoverable and operator-visible.

**Non-Goals:**

- Do not adopt from Rules, Skills, arbitrary custom structures, or ambiguous findings.
- Do not expose provider browsing, plaintext resolution, overwrite, source rewrite, or target writes.

## Decisions

### Use a separate adoption operation

Ordinary refresh/import remains strictly provider-free. Adoption planning is requested for one exact candidate and closed field set. The plan binds candidate/source fingerprint, redacted selector, provider kind, derived reference name, absent-entry precondition, normalized reference-bearing Store publication, and authority. Adding a flag to ordinary import was rejected because it would silently increase its privileges.

### Read plaintext only inside the apply capability

The executable plan contains no value or reversible derivative. After authority and source checks, a narrow provider port reads the exact unchanged local field, creates only the bound absent entry, and returns metadata. The handler, renderer, receipt, journal, and public DTO never receive plaintext.

### Fail closed on existing references

The first version requires the derived provider entry to be absent. It never compares or returns an existing value and never overwrites. Allowing an “equal existing value” optimization was rejected because equality checking expands provider reads and observable timing without being necessary.

### Report, do not silently compensate, an orphan

Provider creation cannot be atomically committed with filesystem Store publication. If the latter fails, the operation records a typed orphaned reference name, provider metadata, and exact cleanup command. Automatic deletion was rejected because compensation could delete a credential whose ownership changed concurrently.

### Inject a capability-shaped port into Web

The local API composition receives only `planInventorySecretAdoption` and `applyInventorySecretAdoption`. It never receives general provider get/list/delete or a raw `SecretStore`.

### Freeze exact effect ordering and provider call budgets

Planning captures one exact MCP candidate from the ordinary read-only Inventory path and produces a closed serializable plan. It performs zero provider calls. Apply verifies the external plan's authority seal and closed semantics before source, Store, provider, lock, journal, activity, or presentation interaction. It then revalidates the Store/source/provider-absence preconditions, publishes the journal, performs exactly one provider create, publishes the reference-bearing Store actions, and records either completion or typed orphan evidence. Provider absence is checked once through the narrow create-if-absent operation; implementations MUST NOT emulate it through a general get plus set pair.

The injected adoption capability exposes only `createExactAbsentReference(binding, readBoundSourceValue)`. The callback may read one plan-bound field after authorization and precondition checks and returns an opaque secret value directly to the provider adapter. Core orchestration, CLI, Web handlers, renderers, plan bytes, and recovery evidence cannot inspect it. Vault, keychain, and protected headless test adapters implement the same call contract with fakes; production tests never access a real credential provider.

### Keep orphan recovery typed and manual

The active journal records the non-secret provider identity, reference name, Store action set, phase, and authority chain before provider creation. A failure after the create call records `provider-created-store-unpublished` plus the exact provider-specific cleanup command. Recovery diagnosis may confirm non-secret reference presence through the narrow port but performs no delete. A crash or exception before provider success produces no orphan claim; a failure after Store publication retains the normal completed receipt. The orphan result is stable across CLI/API serialization and contains no source value, value hash, provider error text containing the value, or general provider operation.

## Risks / Trade-offs

- **[Risk] Plaintext escapes through an exception or spy.** → Run known-value canaries through final observable guards and assert no value reaches handler arguments or receipts.
- **[Risk] Source field parsing selects the wrong value.** → Bind a closed dialect-aware field selector and revalidate the complete source fingerprint before provider access.
- **[Trade-off] Orphan cleanup is manual.** → Prefer explicit evidence over unsafe cross-system compensation.

## Proof Obligations

1. **Reference-only observation:** A unique known-value canary and reversible encodings of it are absent from Inventory DTOs, selectors, plans, seals, digests, journals, receipts, errors, activity/log output, CLI stdout/stderr, API bytes, browser state, Store publication, packed runtime output, and recovery evidence.
2. **Exact authorization:** An invalid seal, changed candidate/source/selector/provider/reference/Store action, injected target action, stale authority, or stale Store/source state fails before provider, lock, journal, Store, activity, or presentation calls.
3. **Least provider privilege:** Refresh, ordinary import, and adoption planning make zero provider calls. A successful apply makes exactly one narrow create-if-absent call, zero list/get/delete/overwrite calls, and publishes one exact reference-bearing Store mutation.
4. **Stable partial-failure evidence:** Provider-success/Store-failure produces one typed orphan result bound to the authorized provider/reference and exact cleanup command, performs zero provider delete calls, and survives journal/recovery diagnosis without plaintext.
5. **Boundary non-disclosure:** Closed CLI/API schemas reject plaintext fields before Core; Web composition receives the two adoption functions and no general provider; browser and packed Core/Web graphs contain no adoption path that returns or serializes a plaintext value.
6. **Source and target safety:** Apply reads only the bound no-follow stable MCP source after authorization, performs no source rewrite, and produces zero agent-target actions or writes.
7. **Acyclic adoption port:** The `Env` adoption capability SHALL depend only on a port contract and domain DTOs. The port contract SHALL NOT import `Env`, observable runtime helpers, mutation transactions, or concrete providers; the bound secret capsule is structural and non-serializable so the boundary remains least-privilege without creating a port/runtime dependency cycle.

## Attack Matrix

| Attack | Expected phase | Required evidence |
| --- | --- | --- |
| Add plaintext through argv, structured input, HTTP, or unknown plan keys | boundary validation | Typed closed-schema rejection; zero Core/provider calls; canary absent from terminal bytes |
| Re-digest or re-sign changed selector, source, candidate, provider, reference, or Store action | authority/semantic validation | Stable invalid-plan result before source, Store, provider, lock, journal, activity, or presentation |
| Reuse a plan after authority, Store revision, source fingerprint, or selected field changes | apply precondition | Typed stale/conflict result; zero provider create and Store writes |
| Target an existing provider entry or unsupported provider | provider precondition | Stable non-disclosing conflict; zero overwrite/read/list/delete calls |
| Inject Rule, Skill, custom MCP, ambiguous selector, or target action | planning/semantic validation | No executable plan; no provider or target interaction |
| Throw provider errors containing the canary | provider boundary/final observable guard | Error is mapped to typed metadata and client-observable bytes contain no canary |
| Fail Store publication after provider success | journaled apply | Typed orphan evidence and exact cleanup command; zero silent delete; recovery replay remains non-disclosing |
| Bundle or pack a consumer that imports adoption DTOs | build artifact | Browser/runtime/declaration negative checks show no Node/provider implementation in client graph and no plaintext-bearing public field |

## State Matrix

| State/transition | Provider call budget | Store/source/target effects | Required result |
| --- | --- | --- | --- |
| refresh or ordinary import | zero adoption-provider calls | Existing read/import semantics only; no target effects | Existing redacted Inventory/import DTO |
| plan supported candidate | zero provider calls | Read-only bounded source capture; no writes | Sealed non-plaintext exact plan |
| apply rejected before provider | zero provider calls | No lock/journal/Store/source/target effect | Typed invalid/stale/precondition result |
| provider create rejected as present | one create-if-absent attempt; zero other operations | No Store/source/target write | Typed provider-precondition conflict |
| provider create succeeds; Store commits | one create-if-absent; zero get/list/delete/overwrite | Reference-bearing Store publication only | Completed operation receipt without value |
| provider create succeeds; Store fails | one create-if-absent; zero delete | Journal/recovery metadata only; no source/target write | Typed orphan plus exact manual cleanup |
| recovery diagnoses orphan | at most one narrow presence probe when authorized | No provider mutation and no Store/source/target write | Stable manual-recovery-required evidence |

## Migration Plan

1. Add supported-field and unsupported-shape matrices plus canary tests.
2. Implement plan construction and the least-privilege provider port.
3. Implement apply ordering and orphan evidence.
4. Expose CLI/API actions only after Core observable and recovery tests pass.
5. Rollback removes adoption surfaces; blocked Inventory candidates and any explicitly created provider entry remain visible for manual cleanup.

## Open Questions

None.
