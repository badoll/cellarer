## Context

The operation registry currently has one generic adapter per `MutationOperation`. It verifies strict runtime shape, authorization, digest, action/precondition alignment, and whether every action kind appears in a broad operation-level allowlist. It does not select a closed domain contract or prove the exact action count and order associated with normalized intent. Domain apply functions perform deeper checks later, sometimes after the shared kernel has acquired authority or begun product observation.

The signed plan format and its canonical bytes are already public compatibility boundaries. Existing domain decoders also contain currentness checks that legitimately need `Env`, Store state, provider state, or a mutation lock. The repair must therefore add an earlier pure semantic boundary without changing the plan or moving stateful validation ahead of authorization.

## Goals / Non-Goals

**Goals:**

- Reject an authorized and digest-valid plan before product observation when its operation, mutation contract, normalized intent, provenance shape, or ordered action set is not closed and coherent.
- Give each executable mutation kind one statically composed contract while preserving the single transaction kernel.
- Share pure contract validation between the adapter resolver and domain apply decoders.
- Keep historical scan actions representable for recovery without making them executable.

**Non-Goals:**

- Re-signing plans, changing canonical JSON, or adding a contract discriminator to persisted plans.
- Replacing stateful domain validation, currentness checks, or effect preparation.
- Supporting runtime mutation-contract plugins.

## Decisions

### Use a closed two-level catalog

The existing operation adapter remains the public internal seam, but delegates semantic validation to a frozen `MutationPlanContract` selected from a statically exhaustive catalog. Store-backed and resource-lifecycle operations select by the exact `normalizedInputs.mutationKind`; operations whose existing plan format has no mutation kind use one fixed contract for that operation.

This keeps `MutationOperation` and signed plan bytes stable. A single broader allowlist was rejected because it cannot distinguish two contracts under the same operation. Runtime registration was rejected because executable mutation authority must not be extensible through configuration or agent adapters.

### Put pure contract decoders below domain apply modules

Contract modules depend only on canonical protocol models and pure validation helpers. They validate exact normalized-input keys, typed provenance, action/precondition cardinality, and the ordered action grammar and payload relationships encoded by the plan. The operation registry and domain decoders both call these modules; domain decoders then add stateful/currentness validation.

This dependency direction avoids importing effectful domain modules into the protocol registry and prevents circular imports. Duplicating abbreviated checks in the registry was rejected because the two validation layers would drift again.

### Preserve authority-first evaluation

Resolver order is strict runtime shape, authorization, digest/integrity, operation and contract selection, then pure semantic validation. Only a successful resolution may acquire or inspect mutation state, read Store/targets/providers, create operation identities, lock, journal, or execute effects. Characterization helpers use the same contract resolver rather than calling the coarse action allowlist directly.

### Make zero-action validity contract-specific

The catalog does not impose a global non-empty action rule. A contract accepts zero actions only when its existing domain semantics define a valid converged/no-op plan. Contracts that require material actions reject an empty or truncated action list.

### Separate execution from recovery recognition

Executable contracts expose only action kinds that can be produced and executed by current planners. Recovery descriptors retain the historical action kinds required to understand durable journal evidence. In particular, `scan-mcp`, `scan-rules`, and `scan-skills` remain recovery-only and cannot satisfy any executable `store-import` contract.

## Proof Obligations

| Attack or state | Required result | Forbidden interaction before rejection |
| --- | --- | --- |
| Invalid signature or authority epoch | Constant invalid-plan result at authority verification | Contract selection, Store/target/provider observation, lock, journal, effects |
| Digest mismatch | Constant invalid-plan result at integrity verification | Contract selection and product interaction |
| Unknown operation or mutation kind | Constant invalid-plan result at catalog selection | Store/target/provider observation, lock, journal, effects |
| Missing, extra, duplicated, or reordered action | Constant invalid-plan result in the selected contract | Store/target/provider observation, lock, journal, effects |
| Action valid for the operation but owned by another mutation kind | Constant invalid-plan result in the selected contract | Store/target/provider observation, lock, journal, effects |
| Recovery-only `scan-*` action in an executable plan | Constant invalid-plan result in the selected contract | Store observation, lock, journal, effects |
| Valid contract-defined no-op | Resolve successfully and preserve existing receipt/currentness behavior | No new synthetic action or plan rewrite |
| Human reason/message wording changes | Contract result remains unchanged | Policy inference from presentation text |

For every negative case, effect-spy tests must observe zero filesystem writes, target reads, provider calls, locks, journals, clock/random identity allocation, and presentation interaction after the supplied plan bytes enter the resolver.

## Risks / Trade-offs

- **[Risk] Contract extraction changes a decoder while trying to share it.** → Freeze representative canonical plan and conflict/effect characterization before extraction, then retain stateful checks in their existing domain layer.
- **[Risk] A declarative action grammar becomes too weak for dynamic plans.** → Contracts validate relationships to normalized intent and action payloads, not only action-kind membership or counts.
- **[Risk] Legitimate converged plans are rejected as empty.** → Record zero-action policy per contract and add positive no-op characterization before enabling rejection.
- **[Risk] Protocol modules gain domain knowledge.** → Keep the contract surface small and pure; effect preparation and product policy remain in the domain modules and transaction kernel.

## Migration Plan

Land contracts by independently reviewed operation families behind the existing resolver. No persisted migration or dual-read path is needed because canonical plan bytes and discriminants remain unchanged. If a family cannot preserve characterization, revert that family to its previous decoder composition and update this design before continuing; do not weaken the closed-contract requirement.

## Open Questions

None. Existing plan discriminants and accepted mutation semantics determine the catalog keys and zero-action policy.
