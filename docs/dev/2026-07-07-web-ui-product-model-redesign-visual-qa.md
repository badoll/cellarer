# Web UI Product Model Redesign Visual QA

Date: 2026-07-07

Local target:

- Built UI served by `cellarer ui`
- QA URL: `http://127.0.0.1:4318/dashboard`
- `4317` was already in use during this run, so QA used `4318`
- `CELLARER_HOME=/private/tmp/cellarer-product-model-qa`

## Checked

- Dashboard first screen shows the product model: resources, collections, discovery, sync health, and agent readiness.
- Primary navigation is reduced to Dashboard, Skills, MCP, Rules, Agents, and Settings.
- Skills, MCP, Rules, Agents, and Settings are reachable from the sidebar and mobile navigation.
- Resource pages expose `Import existing setup` and `Sync to Agents`.
- Import dialog supports User-level and Project-level destinations.
- Import dialog requires Project root before previewing Project-level imports.
- Sync dialog separates target Agents from destination scope.
- Sync dialog supports User-level and Project-level destinations and requires Project root for Project-level sync.
- Agents page shows registered adapters, detection status, roots, capability coverage, enabled state, and adapter override form.
- Settings page shows store root, defaults, collections, and secret references.
- Desktop viewport `1440x1000` had no horizontal overflow.
- Mobile viewport `390x844` had no horizontal overflow.
- Mobile modal title/body bounds were inside the dialog and viewport after the modal header CSS fix.
- Visible Web UI text no longer showed old Channel/Artifact terminology in the checked flows.

## Follow-up TODO

- Persist reusable sync schemes: saved agent sets, destination, resource kinds, and collections.
- Add a recent project root picker for Project-level import/sync.
- Add a first-run setup wizard when no store resources are managed yet.
- Make Collections scenario-oriented, with examples such as `default`, `internal`, `review`, or team-specific sets.
- Add remote skill update discovery and stale-resource signals.
- Add richer resource metadata: source agent, imported time, last synced agents, and secret-ref summary.
- Add diff/re-sync/rollback actions from resource and agent detail views.
- Improve secret entry UX so secret references can be resolved without leaving the Web UI.
- Add batch review for discovered resources before import.
- Add saved filters for resource pages as libraries grow.
