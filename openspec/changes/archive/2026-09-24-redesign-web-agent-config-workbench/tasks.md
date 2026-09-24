## 1. Management navigation and terminology

- [x] 1.1 Replace the eight peer navigation entries with Overview, Agent Config Library, Sync, Agents, Operation History, and Settings; open the library by default and route existing Inventory, Profile, resource, and recovery journeys from their task destinations.
- [x] 1.2 Add one typed Chinese/English catalog for primary navigation, actions, sync intent, and status labels, using browser language with English fallback; remove “受管资源” and “内容库” from primary UI copy.
- [x] 1.3 Add focused navigation and locale tests for returning and empty Store states, including reachability of secondary workflows.

**Verification:** `pnpm exec vitest run packages/web/tests/web-client-journeys.test.ts` plus focused new navigation/locale tests; inspect keyboard focus on the primary navigation.

## 2. Unified Agent Config Library

- [x] 2.1 Build the Skill, MCP, and Rule stored-configuration list and detail view from typed `/api/v1/resources` data with type tabs, name/source/ID search, group filter, source/Store revision, target usage, and reference-only secret display.
- [x] 2.2 Keep checkbox selection as exact immutable Store IDs across presentation filters; show total and hidden selected counts and provide clear selection, group editing, update preview, removal preview, and exact sync entry points.
- [x] 2.3 Add focused tests for mixed kinds, filtering, hidden selections, type-aware actions, secret redaction, and resource lifecycle previews.

**Verification:** `pnpm exec vitest run packages/web/tests/human-resource-workflows.test.ts packages/web/tests/web-sync-selection.test.ts` plus focused new library tests; compare UI actions with exact request bodies.

## 3. Discovery and add entry points

- [x] 3.1 Connect “Find existing configuration” and the empty state to the finalized progressive Inventory view from the archived dependency, preserving provisional/final and exact-import boundaries.
- [x] 3.2 Connect “Add configuration” to existing bundle validation and exact import plan/apply; after import, offer the library and a separate sync action without target mutation.
- [x] 3.3 Add first-use tests for empty Store, partial/provisional scan, final ready selection, import receipt, and return to daily management.

**Verification:** `pnpm exec vitest run packages/web/tests/inventory-page.test.ts packages/web/tests/inventory-import-api.test.ts` plus focused new empty-state tests; inspect that provisional candidates cannot be applied.

## 4. Explicit sync intent and plan authority

- [x] 4.1 Implement a tagged sync intent for exact IDs, explicit group, Profile, and Store defaults; make Agent, destination/scope, project root, and intent visible before preview.
- [x] 4.2 Bind previews and Apply to normalized current intent and dialog session; ignore late results, retain exact IDs across display-filter changes, submit only Core's unchanged plan, and present typed conflict, shared-target, and stale-plan evidence.
- [x] 4.3 Add adversarial tests for filter clearing, hidden checked rows, intent switching, changed target/root, late responses, shared consumers, stale apply, and no automatic retry.

**Verification:** `pnpm exec vitest run packages/web/tests/web-sync-selection.test.ts packages/web/tests/sync-dialog.test.ts packages/web/tests/api-mutation-journeys.test.ts` plus focused new intent tests; review exact plan receipt equality in apply requests.

## 5. Agent and Profile follow-up

- [x] 5.1 Make Agent compatibility and Profile create/edit/reconcile/consumer-uninstall reachable from Agents and Sync without changing their Core mutation contracts.
- [x] 5.2 Add focused journey tests for unsupported Agent selection, Profile edits, and shared-consumer uninstall.

**Verification:** `pnpm exec vitest run packages/web/tests/agents-page.test.ts packages/web/tests/human-resource-dialogs.test.ts packages/web/tests/human-resource-workflows.test.ts` plus focused new Profile navigation tests.

## 6. Operation follow-up

- [x] 6.1 Build Operation History from existing activity and operation results, with current-status verification, typed recovery, and historical revert entry points that require fresh previews.
- [x] 6.2 Add focused tests for recovery-required operations, historical receipt versus current status, and no automatic retry.

**Verification:** `pnpm exec vitest run packages/web/tests/web-client-journeys.test.ts packages/web/tests/human-resource-workflows.test.ts` plus focused new history tests.

## 7. Honest overview

- [x] 7.1 Replace the dense dashboard with a compact Overview driven only by typed, current evidence; distinguish source update, Store revision, target pending/conflict, configured files, unknown native loading, and unavailable counts.
- [x] 7.2 Add focused tests for mixed and unknown status evidence, unavailable counters, and actionable links to exact affected items.

**Verification:** `pnpm exec vitest run packages/web/tests/dashboard-model.test.ts packages/web/tests/web-client-journeys.test.ts` plus focused new status tests.

## 8. Responsive journey and public guidance

- [x] 8.1 Make list/detail, selection summary, sync preview, and operation follow-up keyboard operable and usable at desktop and narrow viewport sizes without hiding plan scope or confirmation details.
- [x] 8.2 Update `README.md`, `README.zh-CN.md`, `docs/README.md`, and `docs/README.zh-CN.md` as applicable so both languages describe the new navigation and the separate discover → import → sync → verify workflow.
- [x] 8.3 Add focused layout interaction tests; inspect built/static `cellarer ui` at desktop and narrow viewport through the first-use and returning-user paths.

**Verification:** Focused keyboard/layout tests and documented browser interaction evidence at desktop and narrow viewports.

Browser evidence: built `@cellarer/web` client served by `cellarer ui` on a temporary Store; at 1280px and 390px the empty library, Inventory, Sync, and Operation History were reachable, and keyboard Enter activated the focused discovery and mobile Sync controls. A returning-user resource fixture exposed list/detail, exact selection, and the Sync dialog at both widths; selected IDs and Agent/scope remained visible, with no page-level horizontal overflow. At 1280px the final list table fit its panel. The uninitialized temporary Store returned an API error in Operation History; the page preserved the typed error and independent activity/receipt areas. Fixture-backed returning-user checks verify the built client interaction, not persistence in Core.

## 9. Integration closure

- [x] 9.1 Review the integrated client against the design's proof/state matrix, including exact selection, plan authority, shared targets, recovery, and reference-only secrets; repair findings within this change's allowed paths.
- [x] 9.2 Run `openspec validate redesign-web-agent-config-workbench --strict` and the full closure gate once: `pnpm build`, `pnpm test`, `pnpm lint`, and `pnpm typecheck`; report actual results and any limitations at closure.

**Verification:** Strict OpenSpec validation, one combined review plus one adversarial review for mutation/recovery/secret paths, and the single full gate listed in 9.2.

Integration review: exact ID selection remains independent of filters, and plan authority is tied to the current normalized request and dialog generation. The adversarial pass checked unsupported Agent targets, shared consumers, blocked plan actions, stale apply, recovery without automatic retry, and reference-only secret rendering. Repair: source checks now show a typed update status without dumping arbitrary response fields; historical revert preview closes when target or exact resource input changes. Focused regression tests and Web typecheck passed before the full gate.

Closure gate: strict validation, `pnpm build`, `pnpm lint`, and `pnpm typecheck` passed. First default `pnpm test` found 3 browser import violations from new `globalThis` use (2241 pass, 3 fail, 1 skip); repaired with the browser locale helper and all 137 focused import tests passed. Second default `pnpm test` had one unrelated Core deployment-reconciliation timeout under parallel load (2243 pass, 1 fail, 1 skip); its 7-test file passed alone. Final full `vitest run --maxWorkers=4` passed all 154 files (2244 pass, 1 skip). The default test command did not finish green, but the complete suite passed with bounded concurrency.
