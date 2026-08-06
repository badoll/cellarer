## Why

Once the CLI can inspect and configure local state, users still cannot safely maintain resources over time or reuse one exact multi-agent desired state. Add/import/apply alone is insufficient for real local management: cellarer needs provenance-aware update/remove/export/uninstall and named sync profiles without weakening ownership, drift, transaction, or secret guarantees.

## What Changes

- Add provenance-backed resource update checking and staged update plans with validation, secret scanning, diff, and immutable revision evidence.
- Add planned resource rename, store removal, sanitized export, and target uninstall with dependency and drift guards.
- Distinguish store removal, target uninstall, and historical revert as separate operations.
- Add named sync profiles containing exact agent targets, scope, resource/collection selection, and distribution options.
- Add profile CRUD plus `sync plan/apply/verify/uninstall` commands using the common transaction and CLI protocols.
- Require project-scoped profiles to receive an explicit workspace root at invocation and forbid stored blanket destructive acknowledgements.
- **BREAKING**: lifecycle operations use exact immutable resource identities and never infer cascade, force, or target scope from a name alone.

## Capabilities

### New Capabilities
- `resource-lifecycle`: Provenance-aware check/update, rename, remove, export, and target uninstall with dependency, ownership, secret, and drift safety.
- `sync-profiles`: Named reusable desired-state profiles and exact plan/apply/verify/uninstall workflows across multiple local agents.

### Modified Capabilities

None. This repository does not yet contain accepted capability specs to modify.

## Impact

This change follows `complete-cli-control-plane` and affects Core resource/provenance models, store revisions, planners, target ownership, CLI command schemas, Web parity, import/export formats, and public docs. It does not introduce a remote marketplace, background daemon, scheduler, or automatic destructive conflict resolution.
