## Context

Legacy discovery-summary reads and scan-backed mutation flows predate unified Inventory. They are exposed through CLI registration, protocol schemas, Core exports, `/api/v1`, OpenAPI, and bundled client calls. The scan engine also contributes types and recovery decoding, while resource catalog code currently reuses scan planning internally. Removal must therefore follow accepted Inventory parity and preserve recovery of already journaled mutations without leaving a second public product path.

## Goals / Non-Goals

**Goals:**

- Leave Inventory refresh/import as the only supported discovery/import journey.
- Remove legacy command, route, schema, browser, and public Core reachability as one reviewed integration.
- Preserve generic transaction recovery and any minimum recovery-only decoding required for previously journaled scan mutations.
- Prove package exports, declarations, OpenAPI, route registration, command capabilities, and first-party clients agree on the removal.

**Non-Goals:**

- Do not redesign Inventory, import planning, receipts, recovery, ownership, secret handling, or Sync.
- Do not remove generic capability/schema discovery or resource presentation still backed by accepted Inventory behavior.
- Do not add compatibility aliases, translation routes, Store migration markers, or a second import engine.

## Decisions

### Freeze a post-dependency removal and retention manifest

The exact symbol and route manifest is refreshed after each dependency closes, then frozen before implementation. A path may be removed only after the accepted Inventory code provides its retained user job and no first-party runtime, declaration, schema, or test fixture still consumes it.

| Boundary | Remove | Retain or replace with |
| --- | --- | --- |
| CLI | discovery-summary leaf; mutating `scan` leaf; scan argv/options/renderers | `capabilities`, `schema`, `inventory refresh`, `inventory import plan/apply`, resource and Sync commands |
| CLI protocol | discovery-summary and scan command contracts, schema IDs, capability entries | authoritative Inventory refresh/import contracts and generic envelopes/errors |
| Local API | discovery-summary route; scan plan/apply; scan-backed overlapping import shapes | unified Inventory refresh/import routes and generic plan/apply envelope semantics |
| Bundled client | discovery/scan API calls, state, actions, and fixtures | Inventory-first onboarding, Library, exact Store import, and separate Sync |
| Core public API | `discoverySummary`, `discoverySummaryControlPlane`, `scanPlan`, `planScanMutation`, `applyScanMutationPlan`, `applyScan`, and unused scan-only DTO exports | accepted Inventory enumeration/import use cases and resource projections |
| Core internal reads | resource-catalog dependence on scan orchestration | Inventory-backed or retained domain-owned safe observation selected after dependency closure |
| Recovery | public creation/application of new scan plans | generic recovery plus minimum internal decoder/executor for already journaled authorized scan operations |
| Documentation | discovery/scan/import examples and migration guidance | Inventory refresh/import plan/apply commands |

Keeping aliases was rejected because it preserves ambiguous product vocabulary and could reconstruct a legacy mutation outside exact Inventory receipts. Deleting recovery decoding together with public routes was rejected because route removal must not strand material write-ahead evidence.

### Remove reachability outside-in

Implementation first migrates first-party clients and resource projections to accepted Inventory use cases. It then removes CLI/API registrations and schemas, followed by public Core exports and dead orchestration. Recovery-only internals are evaluated last. This ordering makes contract and consumer failures visible before deleting implementation.

Removing the engine first was rejected because callers could be left compiling against contracts that crash or silently fall back.

### Removed inputs fail before Core invocation

Unknown CLI leaves use the normal usage failure. Removed schema IDs use the stable unsupported-schema failure. Removed `/api/v1` routes return not found. None of these boundaries authorize, decode, replan, or invoke legacy Core operations. No handler accepts an old shape and translates it into Inventory selection.

### Recovery compatibility is internal and non-advertised

An already journaled scan operation may remain decodable and recoverable through the generic recovery command if the current Store contains such evidence. That support is not registered as a scan command, route, schema, public planning API, or new-operation capability. Removing the decoder itself requires separate evidence that no supported recovery state depends on it.

## Attack Matrix

| Attempt | Required defense | Proof |
| --- | --- | --- |
| Invoke removed CLI discovery/scan path | Fail usage resolution before Core | Commander/catalog negative tests and zero-invocation spy |
| Request removed command schema ID | Return stable unsupported-schema result | Capability/schema snapshot tests |
| Call removed API route | Return not found before plan decoding, mutation-authority use, or Core invocation | Route-registry/OpenAPI parity and Core spy |
| Submit a captured legacy scan plan to a remaining route | Reject the route/body without replanning or authority use | Negative API and mutation-authority tests |
| Deep-import removed Core public symbol | Package export/type consumer fails at build time | Root/subpath export, declaration, pack/unpack tests |
| Bundle retains a legacy Web call | Production bundle/client contract test fails | Client import graph and browser journey tests |
| Resource catalog still imports scan orchestration | Source/runtime graph guard fails before deletion | Focused resource/Inventory parity and import-graph test |
| Recover an already journaled scan operation | Generic recovery remains typed and authorized | Recovery fixture test without public scan registration |
| Observe secret-bearing legacy evidence | No value reaches errors, logs, schemas, or clients | Redaction canary tests |

## Risks / Trade-offs

- **[Risk] Removing scan exports strands recovery evidence.** → Retain only the minimum internal recovery path until a separately reviewed proof permits deletion.
- **[Risk] Resource catalog silently changes semantics.** → Freeze pre-removal parity against accepted Inventory identity, provenance, findings, and redaction.
- **[Risk] One registry or schema still advertises a dead route.** → Generate and compare command, route, OpenAPI, client-type, declaration, and packed-consumer surfaces.
- **[Risk] A compatibility translation recreates legacy selection.** → Require not-found/unsupported behavior and zero Core invocation for old inputs.
- **[Trade-off] Recovery-only scan code may remain internally.** → Accept bounded non-advertised code to preserve recoverability rather than exposing a second product path.

## Migration Plan

1. Wait for command contracts, unified Inventory, exact Store import, and Inventory-first onboarding to close; refresh the removal manifest against their archived outputs.
2. Add negative contract tests and resource/Inventory parity tests before changing registrations or exports.
3. Migrate retained first-party resource projections and bundled clients to accepted Inventory use cases.
4. Remove CLI/API registrations and schemas, then remove public Core exports and dead orchestration while retaining proven recovery-only internals.
5. Update bilingual migration guidance and run packed-consumer, bundle, browser, recovery, secret, and full repository gates.
6. Rollback restores the removed registrations and public symbols from the same pre-removal implementation; Store format and operation evidence are unchanged.

## Open Questions

None. The recovery-only decoder decision remains bounded: it is retained unless implementation-time evidence proves it unnecessary without a Store-format or recovery-contract change.
