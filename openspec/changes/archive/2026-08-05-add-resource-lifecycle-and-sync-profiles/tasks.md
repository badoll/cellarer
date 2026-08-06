## 1. Resource Identity, Revision, and Provenance

- [x] 1.1 Add fixtures for local snapshot, Git, URL, and unprovable legacy provenance plus immutable resource IDs across revisions
- [x] 1.2 Version the resource model with current revision, content fingerprint, validation evidence, and typed source descriptor
- [x] 1.3 Backfill provable local evidence and mark other existing resources as local snapshots without false update claims

## 2. Check, Stage, and Update

- [x] 2.1 Implement read-only source update checks through `Env` with immutable source evidence
- [x] 2.2 Stage candidate content privately and run manifest validation, adapter compatibility, recursive secret scanning, and redacted diff
- [x] 2.3 Implement revisioned resource update plans pinned to staged content and ensure store apply never distributes targets
- [x] 2.4 Add interruption, moved-ref, integrity-failure, and desired-divergence tests

## 3. Rename, Remove, Export, and Uninstall

- [x] 3.1 Implement dependency reports for collections, profiles, selections, and owned targets
- [x] 3.2 Add planned rename/local-fork and store-only ordinary/cascade remove operations using exact resource IDs and blocking on owned targets
- [x] 3.3 Implement portable reference-only export bundles and verified bundle import
- [x] 3.4 Implement drift-aware sync target uninstall distinct from store remove and historical revert

## 4. Sync Profiles

- [x] 4.1 Define versioned profile schemas without secrets, absolute project paths, or persistent destructive acknowledgements
- [x] 4.2 Implement profile list/show/create/update/delete with transactional dependency validation
- [x] 4.3 Implement deterministic `sync plan` resolution of collections, resource revisions, agents, workspace root, and target paths
- [x] 4.4 Implement `sync apply`, `sync verify`, and dry-run/apply `sync uninstall` through common safety protocols

## 5. CLI, Web, and Verification

- [x] 5.1 Register lifecycle/profile CLI schemas and commands with text, JSON, and JSONL conformance tests
- [x] 5.2 Expose equivalent Core lifecycle/profile DTOs in Web without duplicating business logic
- [x] 5.3 Document lifecycle verb distinctions, provenance limits, profile workflows, and project-root requirements in synchronized public docs
- [x] 5.4 Run relevant Core, CLI, and Web tests, then run `pnpm lint`, `pnpm typecheck`, and `pnpm build`
