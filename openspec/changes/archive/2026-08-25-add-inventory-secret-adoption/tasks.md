## 1. Supported-Field and Observability Matrix

- [x] 1.1 Add failing Inventory tests for supported MCP env/header/argument/URL fields, dialect-aware selectors, derived reference names, and blocked Rule/Skill/malformed/custom/ambiguous shapes.
- [x] 1.2 Add known-value canary tests across Inventory DTOs, redacted selectors, derived references, and the Core observable guard.
- [x] 1.3 Add capability-spy tests proving ordinary refresh/import performs zero provider access and adoption-offer classification returns no plaintext.

**Verification:** `CI=true pnpm exec vitest run packages/core/tests/inventory-secret-adoption-matrix.test.ts packages/core/tests/inventory-secret-adoption-observability.test.ts`

## 2. Narrow Adoption Planning

- [x] 2.1 Define closed typed adoption findings, selectors, provider metadata, absent-entry preconditions, orphan evidence, and non-disclosing public DTOs.
- [x] 2.2 Implement exact adoption planning for one supported MCP candidate, binding candidate/source/Store state and reference-bearing publication in an authority-sealed plan without plaintext.
- [x] 2.3 Add plan/digest canary and semantic-validation tests for altered selectors, cross-candidate actions, unsupported providers, existing references, source drift, and target-action injection.

**Verification:** `CI=true pnpm exec vitest run packages/core/tests/inventory-secret-adoption-planning.test.ts packages/core/tests/inventory-secret-adoption-observability.test.ts` and `CI=true pnpm --filter @cellarer/core typecheck`

## 3. Protected Apply and Recovery

- [x] 3.1 Implement the least-privilege provider port that can only read the plan-bound unchanged source field and create the exact absent reference.
- [x] 3.2 Apply authorization and source checks before provider interaction, publish only reference-bearing Store content, and refuse overwrite or arbitrary provider operations.
- [x] 3.3 Implement typed orphaned-reference recovery evidence for provider-success/Store-failure without silent deletion or value disclosure.
- [x] 3.4 Add fake vault/keychain/headless-provider tests for authority, lock, journal/recovery, receipts, errors, logs, final-byte, source-safety, provider-call budgets, and observable-secret canaries.

**Verification:** `CI=true pnpm exec vitest run packages/core/tests/inventory-secret-adoption-apply.test.ts packages/core/tests/inventory-secret-adoption-recovery.test.ts packages/core/tests/inventory-secret-adoption-observability.test.ts` and `CI=true pnpm --filter @cellarer/core typecheck`

## 4. CLI and Local API Surface

- [x] 4.1 Add adoption plan/apply command contracts with closed non-plaintext schemas, typed failures, human confirmation, protected machine behavior, and CLI-byte canaries.
- [x] 4.2 Add authenticated `/api/v1` exact adoption routes that receive only the narrow Core service, reject arbitrary provider paths before interaction, and preserve API-byte canaries.
- [x] 4.3 Add Web candidate detail/adoption UI plus built-Hono browser and bundle tests without exposing a secret value to client code.

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/inventory-secret-adoption-command.test.ts packages/cli/tests/inventory-secret-adoption-protocol.test.ts packages/web/tests/inventory-secret-adoption-api.test.ts packages/web/tests/inventory-secret-adoption-page.test.ts packages/web/tests/client-bundle.test.ts` and `CI=true pnpm --filter @cellarer/cli typecheck && CI=true pnpm --filter @cellarer/web typecheck`

## 5. Documentation and Completion Gates

- [x] 5.1 Update English and Simplified Chinese public guidance for supported fields, blocked cases, provider preconditions, orphan cleanup, and reference-only guarantees.
- [x] 5.2 Run the closure build/test/lint/typecheck gates, inspect canary output and owned diff, run `git diff --check`, and strictly validate the selected change plus the repository OpenSpec set.

**Verification:** `CI=true pnpm build`, `CI=true pnpm test`, `CI=true pnpm lint`, `CI=true pnpm typecheck`, `git diff --check`, `openspec validate add-inventory-secret-adoption --strict --no-interactive`, and `openspec validate --all --strict --no-interactive`
