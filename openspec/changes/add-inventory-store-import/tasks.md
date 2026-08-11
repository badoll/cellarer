## 1. Exact Planning Contract

- [ ] 1.1 Add failing tests for explicit non-empty candidate IDs, unknown/duplicate/conflicted/blocked rejection, current refresh resolution, Store snapshot binding, and zero inferred selection.
- [ ] 1.2 Refactor reusable safe captured publications and provenance descriptors out of the old scan path without weakening recursive, symlink, secret, or final-byte guards.
- [ ] 1.3 Implement Inventory import planning with normalized intent, exact candidate/source bindings, Store revision, self-contained reference-only publications, authority seal, and plan/body budgets.

## 2. Exact Atomic Apply

- [ ] 2.1 Add failing tests for cross-process apply, altered plans, stale candidates, stale Store revision, action-set injection, atomic batch failure, and zero target/provider interactions.
- [ ] 2.2 Implement operation-specific semantic validation before product observation and apply the unchanged plan through the existing Store mutation kernel.
- [ ] 2.3 Record resource revisions, full provenance, optional collection membership, activity, journal, receipt, and recovery evidence in one atomic Store revision.

## 3. CLI and Local API Mutation Surface

- [ ] 3.1 Add exact `inventory import plan` and `inventory import apply` command contracts, human previews, machine schemas, typed conflicts, and prompt-free non-interactive behavior.
- [ ] 3.2 Add `/api/v1` exact import plan/apply routes and prove handlers neither reconstruct intent nor receive target or provider capabilities.
- [ ] 3.3 Add Web client contract support and a plan/apply integration test without migrating first-run UX yet.

## 4. Transaction Verification

- [ ] 4.1 Run focused Inventory, Store revision, mutation-authority, lock, journal/recovery, final-byte, resource provenance, activity, CLI protocol, and API contract tests.
- [ ] 4.2 Prove same-process and replacement-process plan application plus no partial Store batch and no agent-target calls under every handled conflict.

## 5. Completion Gates

- [ ] 5.1 Run full build/test/lint/typecheck gates, review the owned diff, run `git diff --check`, and validate this and all OpenSpec changes strictly.
