## 1. Supported-Field and Observability Matrix

- [ ] 1.1 Add failing Inventory tests for supported MCP env/header/argument/URL fields, dialect-aware selectors, derived reference names, and blocked Rule/Skill/malformed/custom/ambiguous shapes.
- [ ] 1.2 Add known-value canary tests across Inventory DTOs, plans, digests, journals, receipts, errors, logs, CLI/API bytes, and final observable guards.
- [ ] 1.3 Add capability-spy tests proving ordinary refresh/import performs zero provider access and adoption planning performs no plaintext read.

## 2. Narrow Adoption Planning

- [ ] 2.1 Define closed typed adoption findings, selectors, provider metadata, absent-entry preconditions, orphan evidence, and non-disclosing public DTOs.
- [ ] 2.2 Implement exact adoption planning for one supported MCP candidate, binding candidate/source/Store state and reference-bearing publication in an authority-sealed plan without plaintext.
- [ ] 2.3 Add semantic-validation tests for altered selectors, cross-candidate actions, unsupported providers, existing references, source drift, and target-action injection.

## 3. Protected Apply and Recovery

- [ ] 3.1 Implement the least-privilege provider port that can only read the plan-bound unchanged source field and create the exact absent reference.
- [ ] 3.2 Apply authorization and source checks before provider interaction, publish only reference-bearing Store content, and refuse every overwrite or arbitrary provider operation.
- [ ] 3.3 Implement typed orphaned-reference recovery evidence for provider-success/Store-failure without silent deletion or value disclosure.
- [ ] 3.4 Run vault/keychain/headless provider, authority, lock, journal/recovery, final-byte, source-safety, and observable-secret tests.

## 4. CLI and Local API Surface

- [ ] 4.1 Add adoption plan/apply command contracts with closed non-plaintext schemas, typed failures, human confirmation, and protected machine behavior.
- [ ] 4.2 Add authenticated `/api/v1` exact adoption routes that receive only the narrow Core service and reject arbitrary provider paths before interaction.
- [ ] 4.3 Add Web candidate detail/adoption UI and built-Hono browser tests without exposing a secret value to client code.

## 5. Documentation and Completion Gates

- [ ] 5.1 Update English and Simplified Chinese public guidance for supported fields, blocked cases, provider preconditions, orphan cleanup, and reference-only guarantees.
- [ ] 5.2 Run full build/test/lint/typecheck gates, inspect canary output and owned diff, run `git diff --check`, and strictly validate this and all OpenSpec changes.
