# cellarer Web UI Product Model Redesign

Status: Design approved for planning
Date: 2026-07-07

## Summary

Redesign the cellarer Web UI around the product model users naturally expect:
a local library of reusable agent resources.

The current implementation has useful core capabilities, but the Web UI exposes
them as CLI-shaped operations: Artifacts, Distribute, Scan, Diagnostics, Revert,
and Secrets. That structure makes the first screen feel like an internal
control panel. Users can see detected agents, but they cannot immediately see
their Skills, MCP servers, Rules, where those resources came from, where they
are synced, and what needs attention.

The new model is:

> Manage resources in the library, then sync selected resources to selected
> agents at a selected destination.

The core product nouns are:

- **Library**: the cellarer store, the local source of truth.
- **Resources**: Skills, MCP servers, and Rules.
- **Collections**: named resource groups, replacing the old `channel` concept.
- **Target Agents**: Codex, Claude Code, Cursor, Gemini CLI, opencode,
  Windsurf, custom agents, and other adapter-backed tools.
- **Destination**: `User-level` or `Project-level`.
- **Sync**: the preview-first action that writes resources to target agents.

## Compatibility Stance

cellarer is still a new project. This redesign does not need to preserve the old
Web UI structure, old interaction paths, or old terminology.

Old code should be reused only when it expresses the new model cleanly. If an
old page, API shape, component, test, or term keeps the product anchored to the
wrong user model, it should be replaced or refactored directly.

In particular:

- Do not preserve `Artifacts / Distribute / Scan / Diagnostics / Revert /
  Secrets` as primary navigation.
- Do not keep `global` and `project` as user-facing top-level concepts.
- Do not keep `channel` as the product or API/CLI term.
- Do not add legacy aliases or migration shims unless explicitly requested.
- Prefer the correct product model over compatibility with abandoned shapes.

## Goals

- Make Skills, MCP, and Rules first-class Web surfaces.
- Make the Dashboard useful as a status and task entry point, not a dense dump
  of internal tables.
- Replace the old `channel` model with `collection` across core, CLI, Web API,
  Web UI, and docs.
- Present `User-level` and `Project-level` as destinations, separate from
  target agent selection.
- Provide a merged resource view that distinguishes managed resources from
  resources discovered in agent-native locations.
- Let users import discovered resources into the library and sync managed
  resources to selected agents through preview-first flows.
- Let users edit agent configuration in the Web UI: enable/disable agents,
  override built-in adapter paths, and add/remove custom agents.
- Keep core first: product meaning belongs in `@cellarer/core`; Web routes
  parse requests and React renders state.

## Non-Goals

- No cloud service, account system, telemetry, database, or remote sync.
- No compatibility layer for old `channel` fields or old Web page names.
- No agent setup wizard in the first implementation.
- No saved sync schemes in the first implementation.
- No automatic writes during discovery.
- No plaintext secret values in Web responses.
- No product claim that is not backed by core data.

## Information Architecture

Primary navigation becomes:

- `Dashboard`
- `Skills`
- `MCP`
- `Rules`
- `Agents`
- `Settings`

Old primary pages become actions, panels, or subviews:

- `Scan` becomes `Import existing setup`.
- `Distribute` / `Apply` becomes `Sync to Agents`.
- `Diagnostics` moves into `Agents` as inspect/doctor checks.
- `Revert` becomes a drift or ledger action.
- `Secrets` moves into Settings and resource/ledger details as secret
  references.
- `Artifacts` is replaced by resource-specific pages.

## Core Interaction Model

Every sync action is expressed as:

> Sync selected resources to selected target agents at a selected destination.

The three user-facing dimensions are independent:

- **Resources**: Skills, MCP servers, Rules, or a Collection.
- **Target Agents**: the selected agent adapters.
- **Destination**: `User-level` or `Project-level`.

`User-level` maps to the existing global scope. `Project-level` maps to the
existing project scope and requires a project directory. The UI should not ask a
user to choose `global` or `project` directly.

## Collections

Collections replace channels as a real domain model.

Data model direction:

- `defaults.collections: ["default"]`
- `collections`
- `artifacts[id].collections`
- `inCollections()`
- CLI option `--collection <name>`
- Web API fields named `collections`

The initial collection is `default`. Users may add collections such as `work`,
`personal`, or `internal`, but the product should not pre-build a complex
taxonomy.

First implementation semantics:

- A Collection is a resource group.
- It can filter resource lists.
- It can be selected as sync input.
- It does not yet save default agents or destinations.

## Resource States

Resource pages use a merged view with these states:

- `Managed`: the resource exists in the cellarer library and the library is the
  source of truth.
- `Discovered`: the resource was found in an agent-native location but has not
  been imported into the library.
- `Synced`: the resource has been synced to a target and the target matches the
  ledger/checksum expectation.
- `Drifted`: the resource was synced before, but the target differs from the
  expected state.
- `Missing`: the resource was synced before, but the target file, directory, or
  symlink is missing or broken.
- `Blocked`: sync is prevented by an unsupported capability, missing project
  directory, path problem, permission issue, secret guard, or adapter failure.

`Managed` does not imply `Synced`. Sync health is per resource, per target
agent, and per destination.

`Discovered` never writes to the library automatically. Users must preview and
import discovered resources before they become managed.

## Dashboard

The Dashboard answers four questions:

- What is in my library?
- What existing agent setup has cellarer discovered?
- What is the current sync health?
- What should I do next?

First-screen panels:

- Library counts for Skills, MCP, Rules, and Collections.
- Discovered counts from lightweight agent discovery.
- Sync health counts for Synced, Drifted, Missing, and Blocked resources.
- Agent readiness summary.
- Recent activity.
- Next actions.

Primary Dashboard actions:

- `Import existing setup`
- `Sync library`
- `Fix drift`
- `Review agents`

Empty-library state should not be a dead end. If the library is empty but
agents are detected, the Dashboard should explain that existing agent resources
can be imported.

## Resource Pages

`Skills`, `MCP`, and `Rules` share the same page model.

Top area:

- Resource type title.
- Counts by state.
- Collection filter.
- Search/filter controls.
- Primary action: `Sync to Agents`.
- Secondary action: `Import existing setup`.

Main list:

- Resource name.
- State.
- Collections.
- Source or provenance.
- Discovered location when applicable.
- Synced targets.
- Last activity.
- Available actions.

Detail view:

- Content summary.
- Provenance.
- Collections.
- Secret references.
- Sync targets.
- Drift and diff details.
- Activity history.

Primary actions:

- `Import to Library`
- `Sync to Agents`
- `Assign Collection`
- `Remove from Library`
- `View Diff`
- `Re-sync`
- `Rollback managed changes`

## Discovery

Discovery uses a hybrid model:

- Dashboard and resource pages may run lightweight discovery to show counts.
- Detailed scan is user-initiated.
- Detailed scan previews candidates, conflicts, source paths, secret
  references, and import actions.
- Import writes only after user confirmation.

Lightweight discovery should avoid expensive content parsing. It should answer
how many candidate Skills, MCP servers, and Rules appear in detected
agent-native locations.

Detailed scan can reuse existing scan semantics, but it should be presented as
`Import existing setup`, not as a primary `Scan` page.

## Sync To Agents

`Sync to Agents` is a unified action available from Dashboard, resource pages,
and resource details.

The flow:

1. **Resources**: choose selected resources or a Collection.
2. **Target Agents**: choose agents; show capability support inline.
3. **Destination**: choose `User-level` or `Project-level`; require a project
   directory for Project-level.
4. **Preview & Apply**: show dry-run plan, target paths, blocked reasons,
   warnings, secret references, and expected writes before Apply is enabled.

If launched from a resource page, the resource type is already known and the UI
should not ask the user to choose capabilities. If launched from Dashboard for
the whole library, resource type filters may appear.

Apply is always gated by a current preview.

## Agents

Agents becomes a management page, not only a diagnostic page.

First implementation capabilities:

- List all built-in and custom agents.
- Show detected, missing, disabled, and warning states.
- Show supported resource types for `User-level` and `Project-level`.
- Show current rules, MCP, and skills paths.
- Enable or disable an agent.
- Edit built-in adapter overrides.
- Add a custom agent.
- Delete a custom agent.
- Run inspect and doctor checks.

Agent config writes go through core-owned config helpers. Web routes should not
perform ad hoc JSON mutation.

The user config model remains key-based: built-in adapter keys represent
overrides, and unknown keys define custom agents.

## Settings

Settings contains defaults and advanced local configuration.

First implementation sections:

- Library location: show store root and whether `CELLARER_HOME` is active.
- Collections: manage `default` and user-created collections.
- Sync defaults: method, MCP merge strategy, secret mode.
- Secret references: show reference names only.
- Advanced: read-only config preview or config file path.

Settings should not become a dumping ground for primary workflows. Import,
sync, and drift repair belong in Dashboard and resource pages.

## API And Core Model

Core owns:

- Collection parsing, validation, and filtering.
- Resource catalog aggregation.
- Lightweight discovery summary.
- Detailed import planning and applying.
- Sync planning and applying.
- Sync health aggregation.
- Drift/diff semantics.
- Agent config read/write validation.

Web API routes should expose core-owned results:

- resource catalog by kind;
- discovery summary by agent, resource kind, and destination;
- import preview/apply;
- sync preview/apply;
- drift diff;
- agent config read/write;
- settings read/write for collections and defaults.

React should not reconstruct product truth from many unrelated endpoints when a
core-owned aggregate is needed.

## Error Handling And Safety

- All write operations are preview-first.
- Project-level operations require a project directory.
- Unsupported agent/resource/destination combinations become `Blocked`, not
  silent skips.
- Blocked items should not prevent valid items from being previewed.
- Secret values are never returned to the Web UI.
- Secret references can be shown by name.
- Adapter path escapes, invalid path templates, unsupported formats, and write
  failures produce readable blocked reasons.
- Diff controls appear only when diff content is safely available.

## Testing And Verification

Core tests:

- collection config parsing and defaults;
- artifact collection membership;
- `inCollections()` filtering;
- resource catalog aggregation;
- lightweight discovery summary;
- import planning/apply from discovered resources;
- sync health aggregation;
- agent config read/write validation.

Web API tests:

- collection field names;
- resource catalog endpoints;
- discovery summary endpoint;
- sync preview-first behavior;
- project directory required for Project-level;
- agent config write validation;
- no plaintext secret values in responses.

React tests:

- new navigation;
- Dashboard empty and populated states;
- resource merged views;
- Sync to Agents dialog;
- Agents edit flow;
- Settings collection flow.

CLI and docs checks:

- replace `--channel` with `--collection`;
- replace channel documentation with collection documentation;
- keep CLI, Web API, Web UI, and public docs consistent.

Visual QA:

- desktop first viewport;
- mobile first viewport;
- empty library with discovered resources;
- populated library;
- drift state;
- long paths and long resource names;
- sync dialog overflow and disabled states.

## First Implementation Scope

The first implementation should include:

- collection rename across core, CLI, Web API, Web UI, and docs;
- new primary navigation;
- Dashboard task model;
- resource catalog merged view for Skills, MCP, and Rules;
- lightweight discovery summary;
- Import existing setup as an action flow;
- Sync to Agents as an action flow;
- Agents editable config page;
- Settings collections and defaults.

It should not include saved sync schemes, workspace history, agent setup wizard,
or remote update management.

## Future Optimization Backlog

- Save a sync scheme from a Collection, including default target agents and
  destination.
- Maintain a recent Project-level destination list.
- Add an agent setup wizard that detects installed tools, tests paths, and
  generates adapter templates.
- Add scenario-oriented Collections such as personal, work, and open source
  when the user creates them.
- Add remote skill update checks from provenance metadata.
- Add richer resource detail metadata: version, source, dependencies, and last
  sync topology.
- Improve diff, re-sync, and rollback as a guided repair workflow.
- Add friendlier secret value entry that avoids command-line argument leakage.
- Add batch review for discovered resources across multiple agents.
- Add saved filters for resource views.

## Acceptance Criteria

- A new user opening the Web UI can immediately tell whether the library is
  empty, which agents are detected, and whether there are existing resources
  available to import.
- Skills, MCP, and Rules are visible as first-class pages.
- A managed resource can be synced through a preview-first `Sync to Agents`
  flow.
- A discovered resource can be imported through a preview-first import flow.
- `collection` is the only product/API/CLI term for resource grouping.
- `channel` does not remain in user-facing docs, CLI flags, Web UI text, or new
  public API fields.
- `User-level` and `Project-level` are the Web UI destination labels.
- Agents can be enabled/disabled and configured from the Web UI.
- The first implementation does not depend on fake data or unsupported product
  claims.
