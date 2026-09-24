## Context

The bundled client currently starts in Inventory and exposes Dashboard, Inventory, Skills, MCP, Rules, Profiles, Agents, and Settings as peers. Its resource pages already use typed `/api/v1` results and Core plan/apply operations, but the navigation follows data types more than recurring user tasks. The local visual reference is `docs/dev/ux/cellarer-agent-config-library-concept-v2.png`: it establishes a compact library list with a detail pane, while its names, counts, badges, and pixels are illustrative. The accepted workflow must also cover the areas outside that one image: discovery, sync, Profiles, status verification, history, recovery, and small screens.

`stabilize-first-use-inventory-flow` owns the active progressive Inventory work. This change starts implementation only after that change is archived and its final contract is reconciled here. Existing dirty work in that change is outside this proposal.

## Goals / Non-Goals

**Goals:**

- Make the first screen useful for daily management with a visible route from each observed problem to the next supported action.
- Give Skills, MCP server definitions, and Rules one library surface without erasing their type differences or changing Core's resource model.
- Keep discovery/import, Store update, target sync, verification, and recovery separate and accurately labeled.
- Preserve exact plan authority across a unified list, filter changes, async previews, and Profile actions.
- Support Chinese and English labels plus keyboard and narrow-screen layouts.

**Non-Goals:**

- A new Store or deployment schema, API version, agent adapter, source scanner, automatic sync, or MCP runtime control.
- A pixel-exact implementation of the generated image or its example counts and entries.
- Replacing Core status, ownership, recovery, or secret decisions with browser rules.

## Decisions

### 1. Organize navigation by user job

The six primary destinations are Overview, Agent Config Library, Sync, Agents, Operation History, and Settings. The library is the initial destination and has a conditional empty state. Inventory is entered from “Find existing configuration”; Profiles are entered from Sync and Agents; resource lifecycle actions remain in the library detail; verification is entered from Sync or an operation; recovery and revert are entered from Operation History. This is a navigation change within the bundled client, not a storage or API migration.

The alternative of keeping Skills/MCP/Rules as three top-level pages preserves implementation structure but forces users to decide the resource kind before seeing what they can do. A permanent discovery stepper would remain visually dominant after the first import. Both were rejected for the recurring manager.

### 2. Treat “configuration” as a UI umbrella, not a new domain type

The primary page is “Agent 配置库” / “Agent Config Library”; rows retain their concrete Skill, MCP, or Rule type. “分组” / “Group” maps to existing Collection membership. “查找已有配置” maps to Inventory discovery and exact Store import; “同步” maps to reviewed target reconciliation. UI terminology does not rename serialized IDs, API fields, CLI commands, or Core entities. A small typed bilingual label catalog, selected by browser language with English fallback, supplies the primary journey terms; no third-party localization runtime is needed.

The alternative “内容库” implies editorial content and is weak for MCP server configuration. “受管资源” mirrors the model but requires the user to learn internal terminology. These remain model concepts where exact, rather than primary UI labels.

### 3. Derive list, detail, and counters from typed evidence

The library reads the existing all-kind resource list. Search and type/group filters are client-side projections of that result; row selection is a set of immutable Store IDs independent of visible rows. The toolbar shows the total selected and the number hidden by filters. A detail view can be side by side or stacked, but it uses the same resource DTO and lifecycle endpoints. Target usage is shown by Agent, destination/scope, target state, and reason only when reported by Core. Secret reference names are allowed; values are never requested or rendered.

The resource list may include discovered entries. Inventory-only candidates must be visually separate from stored rows and cannot enter a sync selection. Source update availability comes from the existing update-check operation, not from comparing arbitrary timestamps. Overview counters appear only when a typed current result can support them; an unavailable count is shown as unknown or omitted, never as zero. The image's “可更新 2” and “同步问题 1” are examples, not fixed counters or an instruction to perform unbounded background update checks.

The alternative of adding a merged browser-side “health” enum would collapse independent states and duplicate Core policy. The UI instead composes labeled evidence without inventing success.

### 4. Make sync intent a tagged choice, then keep Core's receipt authoritative

The client models one active sync intent at a time: exact Store IDs, an explicit Collection/group, an explicit Profile, or Store defaults. A filter does not create or alter that intent. The exact-ID and group/default branches use the existing sync plan/apply contract; the Profile branch uses its separate Core contract. Target Agent(s), destination/scope, project root, and intent are summarized before preview. Kinds may be displayed or constrained by the selected intent, but cannot silently widen exact IDs.

The preview key is a canonical value representation of normalized target and intent, paired with a dialog/session generation. Changing a material field clears the current plan; late responses cannot restore it. A presentation filter change that preserves exact IDs does not change the key. Apply submits the opaque, unchanged `mutationPlan` associated with the current displayed Core plan. The UI renders Core-reported actions, skips, conflicts, and ownership/consumer evidence, and surfaces typed stale, busy, and recovery outcomes. Verification is a separate read after apply, and native loading remains unknown unless probed.

The alternative of binding the current group filter to sync is easy to implement but allows a display control to change write scope unexpectedly. The alternative of reconstructing actions from the table would break mutation authority.

### 5. Reuse the live Inventory and operation boundaries

“Find existing configuration” opens the same Inventory implementation as CLI/Web, including bounded progress and provisional/final distinction after the dependency closes. It only imports exact final ready candidates into Store and returns to the library; sync requires a second explicit journey. “Add configuration” uses the existing bundle validate/plan/apply endpoints; no new direct resource editor is implied. Operation History composes existing activity, operation details, recovery, verification, and revert entry points. It distinguishes a historical receipt from a current target observation.

No new endpoint is planned. If implementation proves that a required state cannot be represented by the existing browser-safe DTOs, revise this change's proposal, specs, design, risk, and allowed paths before widening the API/Core boundary. Do not infer missing state in the browser.

## Proof Obligations

| State or attempted action | Required visible result | Authority check |
| --- | --- | --- |
| Empty Store, Inventory not yet final | Library empty state, discovery entry, provisional progress only | No import or sync apply from provisional candidates |
| Filter hides checked rows | Exact selected count and hidden count remain visible | Sync request still carries only checked Store IDs |
| Group filter cleared | No implicit switch to Store defaults | Intent and preview key stay unchanged unless user explicitly changes intent |
| Agent, scope, root, ID, group, or Profile changes during preview | Prior plan and Apply eligibility clear; late response ignored | Only current request's opaque plan can apply |
| Source newer than Store, target matches Store | “Update available” with source update action | No target sync issue inferred |
| Store revision pending on target | Affected Agent/scope and preview entry | No write before Core plan confirmation |
| Files configured, native probe absent | Configured plus native loading unverified | No “running” or loaded claim |
| Shared target has another consumer | Core ownership/retention result visible in preview or receipt | No browser-side deletion assumption |
| Stale, busy, conflict, or recovery-required result | Typed explanation and supported next action | No automatic replan/retry or receipt loss |
| Secret-bearing resource | Reference name only, masked/redacted error | No plaintext in DOM, request logs, or fixture snapshots |

Focused UI and API-boundary tests must cover the state transitions above, including keyboard confirmation and a narrow viewport. One adversarial review at integration checks selection authority, shared targets, recovery, and secret display before closure.

## Risks / Trade-offs

- **Broad navigation refactor** → Keep one route/page owner in the client, move existing flows behind it, and run full user journeys rather than preserving duplicate pages indefinitely.
- **A unified list could blur type-specific capabilities** → Keep type badges and type-aware actions; compatibility comes from Agent/Core metadata and plan results.
- **A selected item can disappear under a filter** → Show selected and hidden counts and a clear-selection control; bind writes to IDs, never visible rows.
- **Source and target status can become stale between reads** → Label observation time where available, refresh after receipts, and let Core reject stale plans.
- **Two languages increase copy maintenance** → Keep a small centralized catalog of primary terms and test representative journeys in both locales.
- **Progressive Inventory dependency may change** → Refresh the Execution Contract after its archive before touching the client.

## Migration Plan

No persisted data or API migration is required. Replace the bundled navigation and surfaces while preserving current Core requests and plan receipts. Remove obsolete UI entry points only after the corresponding discovery, resource, Profile, and operation journeys are reachable. A rollback to the prior client build leaves Store and target data unchanged; operations already applied remain governed by Core receipts and recovery, not by the UI build.

## Open Questions

No product decision is required before implementation. The dependent Inventory change's final DTO and UI entry point must be checked after archive; any missing Core evidence must be raised in OpenSpec before implementation scope expands.
