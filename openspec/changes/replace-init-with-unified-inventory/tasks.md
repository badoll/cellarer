## 1. Prerequisite and Supersession Gate

- [ ] 1.1 Verify unified CLI command contracts, browser-safe exports, live Inventory refresh, coherent Store snapshots, and exact Inventory import are implemented, synced, and passing their independent gates before changing init.
- [ ] 1.2 Add regression tests showing the active `simplify-init-agent-activation` prompt/flag behavior is superseded and must not be synchronized as final initialization behavior.

## 2. CLI Initialization Composition

- [ ] 2.1 Add failing CLI tests for interactive Store initialization plus Inventory refresh, aggregate rendering, one confirmation, decline, repeated init, partial/failed refresh, stale apply, and zero target effects.
- [ ] 2.2 Add failing JSON/JSONL/structured/non-TTY/explicit-non-interactive tests proving init never prompts or imports and returns a closed redacted Inventory result.
- [ ] 2.3 Replace init-time agent selection with composition of Store initialize, Inventory refresh, exact import plan, and unchanged apply; keep Store initialization success distinct from later refresh/import outcomes.
- [ ] 2.4 Remove `--agent`, `--no-agent`, structured agent-selection fields, selector injection, repeated-selection validation, and obsolete init schemas/help without weakening exact target inputs for later mutations.

## 3. Legacy Surface Removal and Adapter Refresh

- [ ] 3.1 Add targeted post-commit Inventory refresh to Custom Agent add/update composition with warning-only failure and exact retry guidance.
- [ ] 3.2 Remove discovery-summary and mutating-scan CLI command contracts, registrations, schemas, renderers, compatibility options, and capability entries with not-found/unsupported tests.
- [ ] 3.3 Remove superseded Core discovery/scan orchestration only after Inventory/import parity tests cover every retained safe primitive and public journey.

## 4. API and Web First-run Migration

- [ ] 4.1 Add failing API contract tests for removed discovery/scan routes and schemas, first-run Inventory data, exact import receipts, partial refresh, and typed stale results.
- [ ] 4.2 Implement Inventory-first Web onboarding with kind/source/adapter/state filters, merged provenance detail, ready-only default selection, one import confirmation, and separate Library/Sync next actions.
- [ ] 4.3 Remove old Web discovery/scan calls and `/api/v1` route shapes, then verify registry, OpenAPI, closed schemas, client types, and implemented routes remain exact.
- [ ] 4.4 Run the complete first-run and Custom Agent flows against the built Hono UI at `http://127.0.0.1:4317/dashboard`, including reload, retry, decline, partial, and stale-plan cases.

## 5. Documentation and Completion Gates

- [ ] 5.1 Update English and Simplified Chinese public docs with init, Inventory refresh/import, removed-command migration, Custom Agent retry, and separate-sync guidance verified against source and package metadata.
- [ ] 5.2 Reconcile the superseded active OpenSpec change so only the final Inventory-first deltas can be synchronized; run strict validation for this and every active change.
- [ ] 5.3 Run focused init, command-catalog, protocol, Inventory/import, adapter-mutation, API contract, Web bundle, and browser tests.
- [ ] 5.4 Run `CI=true pnpm build`, `CI=true pnpm test`, `CI=true pnpm lint`, and `CI=true pnpm typecheck`; review the owned diff and run `git diff --check`.
- [ ] 5.5 Run a read-only real-machine first-run acceptance showing shared registered sources appear independently of enabled state, all observable outputs remain secret-free, and no agent target changes before separate sync.
