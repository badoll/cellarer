## 1. Dependency and Contract Gate

**Verification:** `pnpm openspec:preflight --change refresh-inventory-after-custom-agent-mutation`

- [x] 1.1 Confirm `unify-cli-command-contracts`, `add-unified-resource-inventory`, and `replace-init-with-unified-inventory` are synced, archived, and independently validated.
- [x] 1.2 Refresh the allowed paths, committed mutation result shape, targeted Inventory DTO, and client contract surfaces against the post-dependency tree.

## 2. Core Post-commit Composition

**Verification:** `CI=true pnpm exec vitest run packages/core/tests/control-plane-mutations.test.ts -t "post-commit Inventory|targeted Inventory"`

- [x] 2.1 Add failing Core tests for committed Custom Agent add/update followed by complete, partial, and failed targeted refresh; cover committed-ID targeting, absent later mutation authority, redacted secret references, and no refresh after removal or built-in mutation.
- [x] 2.2 Implement the Core-owned mutation-plus-refresh result composition using the existing mutation receipt and one targeted read-only Inventory attempt without rollback, automatic retry, import, or target writes.

## 3. CLI Result Projection

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/control-plane-mutation-commands.test.ts packages/cli/tests/protocol-conformance.test.ts -t "Inventory|inventory|agent"`

- [x] 3.1 Add failing text/JSON/JSONL tests for complete, partial, and failed refresh projections, exact retry guidance, schema closure, mutation-success preservation, and secret-free stdout/stderr.
- [x] 3.2 Project the Core result through the authoritative command contract and renderer without client-side refresh, retry, rollback, adapter-ID reconstruction, or success inference.

## 4. Local API and Agents UI Projection

**Verification:** `CI=true pnpm exec vitest run packages/web/tests/api-contract.test.ts packages/web/tests/api-mutation-journeys.test.ts packages/web/tests/agents-page.test.ts -t "Inventory|inventory|agent"`

- [x] 4.1 Add failing API/UI tests for equivalent mutation and refresh fields, partial/failure presentation, exact retry guidance, redacted payloads, and unchanged success state.
- [x] 4.2 Extend `/api/v1`, closed schemas, browser-safe client types, and the bundled Agents UI to project the Core result without a second refresh or automatic retry.

## 5. Public Retry Guidance

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/control-plane-mutation-commands.test.ts packages/web/tests/agents-page.test.ts`

- [x] 5.1 Update English and Simplified Chinese Custom Agent guidance to distinguish committed mutation success from post-commit refresh status and document `cellarer inventory refresh --agent <id>` as the explicit retry.

## 6. Change Closure

**Verification:** full repository and OpenSpec gates

- [x] 6.1 Run `openspec validate --all --strict --no-interactive` and confirm the new capability matches CLI, API, and Core result semantics.
- [x] 6.2 Run `CI=true pnpm build`, `CI=true pnpm test`, `CI=true pnpm lint`, and `CI=true pnpm typecheck`; review the owned diff and run `git diff --check`.
