## Context

Custom Agent add/update already commits through the revisioned control-plane mutation protocol. Unified Inventory refresh is a separate read-only Core use case that can target one adapter. Composing them in each shell would duplicate success/failure semantics and risks treating a failed observation as a failed mutation.

## Goals / Non-Goals

**Goals:**

- Return one shared typed result containing the committed adapter mutation and its post-commit targeted refresh outcome.
- Make newly declared resources visible immediately without importing or distributing them.
- Preserve exact retry guidance and secret-safe partial/failure evidence across CLI and local API clients.

**Non-Goals:**

- Do not change adapter mutation plans, receipts, authority, locking, journaling, recovery, or rollback.
- Do not refresh after built-in adapter mutations, Custom Agent removal, or unrelated configuration changes.
- Do not import candidates, write agent targets, resolve secrets, retry automatically, or add background work.

## Decisions

### Core owns post-commit result composition

A Core control-plane application service applies the existing authorized Custom Agent add/update plan and, only after a committed success, invokes targeted Inventory refresh using the committed adapter ID. It returns the unchanged mutation receipt plus a separate typed refresh outcome. CLI and `/api/v1` project that result without inferring whether the mutation succeeded.

Duplicating refresh composition in CLI and Web was rejected because one client could roll back, retry, or present partial state differently. Folding refresh into the mutation transaction was rejected because observation failure must not invalidate a durable commit.

### Refresh input comes from the committed mutation

The targeted adapter ID is taken from the committed mutation result rather than a second client-supplied field. This prevents a caller from committing one adapter and refreshing another under a misleading combined result. The refresh uses the live post-commit Store revision and the normal read-only Inventory contract.

### Post-commit outcomes are explicit and non-throwing

The refresh projection distinguishes complete, partial, and failed outcomes. Partial preserves safe candidates, findings, and completeness. Failed preserves a typed redacted reason and the exact retry command. Expected refresh outcomes do not replace the committed mutation result with an exception or mutation failure.

Unexpected defects still cross the normal redacted internal-error boundary; clients MUST NOT convert them into a fabricated successful refresh.

### No automatic retry or import

The composition performs one targeted refresh attempt. Recovery is an explicit `cellarer inventory refresh --agent <id>` action. Refreshed candidates remain observational data and no import or target mutation follows automatically.

## State Matrix

| Mutation result | Refresh result | Required combined result | Forbidden outcome |
| --- | --- | --- | --- |
| planning/apply fails before commit | not started | Preserve the existing typed mutation failure | Refresh or retry guidance implying a commit |
| committed add/update | complete | Return receipt plus targeted Inventory result | Refreshing a different adapter or importing candidates |
| committed add/update | partial | Return receipt plus candidates, findings, completeness, and retry | Downgrading mutation success or hiding partial state |
| committed add/update | failed | Return receipt plus typed failure and exact retry command | Rollback, mutation failure, or automatic retry |
| committed removal/built-in mutation | not started | Return the existing mutation result | Post-commit refresh from this capability |

## Risks / Trade-offs

- **[Risk] Refresh observes a different adapter than the committed mutation.** → Derive the target exclusively from the committed result and assert it in Core tests.
- **[Risk] A refresh failure is presented as mutation failure.** → Use a product union with separate mutation and refresh fields and parity-test each client projection.
- **[Risk] Partial Inventory leaks source content or secret values.** → Reuse the redacted reference-only Inventory DTO and final response guards.
- **[Trade-off] One attempt can leave Inventory stale.** → Prefer explicit retry evidence over hidden background work or unbounded retries.

## Migration Plan

1. Wait for the command catalog, unified Inventory, and Inventory-first onboarding dependencies to close; refresh this contract against their accepted types and paths.
2. Add Core RED tests for committed add/update with complete, partial, and failed targeted refresh outcomes.
3. Implement the shared Core composition and public result type without changing the mutation plan or receipt.
4. Project the result through CLI and `/api/v1`, then update the bundled Agents UI and public guidance.
5. Rollback removes only the post-commit refresh composition; committed adapter mutations and Store data remain valid.

## Open Questions

None.
