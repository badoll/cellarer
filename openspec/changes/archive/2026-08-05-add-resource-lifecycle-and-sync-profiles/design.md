## Context

Resources currently enter the managed store through add/import and are selected for distribution, but provenance is not yet a full update/removal contract. Users also repeat agent, scope, and selection flags for each distribution. The preceding changes provide immutable resource identity, exact selectors, owned target receipts, transactions, and a machine CLI protocol that this lifecycle layer can reuse.

## Goals / Non-Goals

**Goals:**

- Track enough source provenance to check and stage trustworthy updates.
- Keep store revision changes separate from target distribution.
- Provide dependency-aware rename/remove, sanitized export, and drift-aware uninstall.
- Save exact reusable desired-state profiles across multiple agents.
- Make profile planning deterministic and safe in home or project scope.
- Keep every lifecycle/profile mutation previewable and recoverable.

**Non-Goals:**

- A remote marketplace, global resource search, rating, or recommendation system.
- Automatically executing a downloaded Skill during discovery or update.
- Background polling, scheduled synchronization, or remote fleet management.
- Persisting destructive force acknowledgements in profiles.
- Backward compatibility for unreleased name-derived resource identities.

## Decisions

### Separate immutable identity, mutable revision, and provenance

A resource keeps an immutable ID while each accepted content state has a revision, checksum/tree fingerprint, validation evidence, and source descriptor. Supported descriptors identify local path snapshots, Git URL plus ref/commit, or URL plus integrity metadata. Update checking compares source evidence without mutating the store.

This permits collections/profiles to retain stable membership while plans pin the exact revision they validated.

### Stage and validate before accepting an update

Update imports the candidate into private staging, validates manifests and adapter compatibility, recursively scans secrets, computes a redacted diff, and creates a revisioned mutation plan. Applying that plan updates the managed store only; a separate sync plan distributes the new desired revision to agents.

This separation prevents a remote source change from immediately overwriting agent targets.

### Make lifecycle verbs semantically distinct

- `resource remove` deletes a managed store resource after dependency checks.
- `sync uninstall` removes intact owned targets selected by a profile but retains resources and profile.
- `revert` restores recorded before-state for a historical target operation.
- `resource export` creates a portable reference-only bundle.
- `resource rename` changes editable managed metadata while preserving ID; a source-defined name change that alters content identity becomes an explicit local fork.

Each verb has its own plan schema and cannot imply another verb.

### Model profiles as exact desired-state documents

A profile records immutable agent IDs, home/project scope, exact resource IDs and optional collection IDs, capability filters, placement method, and non-destructive merge policy. Planning resolves collections to exact resource revisions and records the resolution in the plan.

Profiles never store “force drift,” replacement acknowledgements, secrets, or an absolute project path. Project-scoped invocation supplies an explicit workspace root that is normalized through `Env` and bound into the plan.

### Guard dependencies and cascades explicitly

Rename/remove reports collections, profiles, desired selections, and owned targets that depend on a resource. A cascade is a separate explicit plan listing each dependent store edit, but it remains blocked while owned targets exist; callers must first use a separate `sync uninstall` plan. Drifted targets remain blocked and require plan-bound acknowledgements from the ownership protocol.

### Export a portable, verifiable bundle

Export contains resource content, manifest, immutable source/provenance metadata where portable, revision checksums, and reference tokens. It excludes vault values, local absolute paths, operation journals, snapshots, and ownership records. Import verifies the bundle before accepting it as a new local source.

## Risks / Trade-offs

- [Upstream refs can move between check and update] → Pin fetched candidate content and immutable revision evidence in the update plan.
- [Profiles can become stale as resources disappear] → Validate references on every plan and block mutation with exact missing dependencies.
- [Collections make profile resolution non-obvious] → Include the fully resolved resource/revision set in every plan and diff.
- [Cascade removal can be broad] → Limit it to enumerated store dependencies and require a separate explicit target-uninstall plan before resource removal.
- [Portable export cannot reproduce machine-specific paths] → Exclude absolute paths and require target resolution on import/apply.

## Migration Plan

1. Version resource provenance/revision data and backfill only evidence that can be proved from current managed content.
2. Add check/stage/update and export/import bundle verification.
3. Add dependency-aware rename/remove and target uninstall.
4. Add profile CRUD and deterministic plan/apply/verify/uninstall.
5. Update CLI/Web parity, examples, and synchronized lifecycle documentation.

Resources lacking adequate legacy provenance remain usable as local snapshots but cannot claim remote update availability until the user attaches a validated source descriptor.

## Open Questions

None. Remote catalog discovery and scheduled synchronization require separate future changes.
