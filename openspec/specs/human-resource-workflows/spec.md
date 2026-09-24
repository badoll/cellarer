# human-resource-workflows Specification

## Purpose

Provide exact, reviewable human workflows for Library resources, Collections, Profiles and deployments through authoritative Core contracts, with explicit recovery and honest runtime evidence.

## Requirements

### Requirement: Library actions use exact resource selection
The bundled client SHALL support resource detail, explicit resource multiselection, Collection membership editing, single-resource update preview and dependency-aware removal through Core use cases. Filters, explicit IDs and Collection-based selections MUST remain distinguishable.

#### Scenario: A user selects specific Library resources
- **WHEN** the user selects three managed resource rows and starts a supported action
- **THEN** the request and preview bind their exact immutable IDs rather than the entire visible kind or Collection

#### Scenario: A resource is still referenced
- **WHEN** the user requests removal of a resource referenced by a Profile or Deployment
- **THEN** the UI displays the typed dependencies without automatically uninstalling targets or cascading Store edits

#### Scenario: A Store update is accepted
- **WHEN** the user confirms a resource revision update
- **THEN** the UI reports Store completion and pending deployment differences without silently syncing targets

### Requirement: Agent and Profile workflows preserve domain authority
The bundled client SHALL offer Agent selection from Core's inventory and compatibility metadata and SHALL expose Profile create/edit/reconcile and consumer uninstall through the same versioned Core contracts used by CLI.

#### Scenario: A user selects deployment targets
- **WHEN** the Agent picker displays detected, unsupported and unknown candidates
- **THEN** the user explicitly selects targets and sees compatibility limitations before a plan can be confirmed

#### Scenario: A deployed Profile is edited
- **WHEN** the user changes desired resources or Agents
- **THEN** the UI commits only the reviewed Profile edit, then offers a separate deployment difference preview

#### Scenario: A shared consumer is uninstalled
- **WHEN** the user confirms detachment of one consumer from a shared target
- **THEN** the result explains remaining consumers and does not imply the physical target was deleted

### Requirement: Mutation journeys maintain exact preview state
Each Web mutation SHALL retain and submit the unchanged current plan after explicit confirmation. The UI MUST keep Inventory import, Store update or removal, target reconciliation, uninstall and historical revert as distinct actions.

#### Scenario: Import succeeds
- **WHEN** the user imports selected Inventory candidates
- **THEN** the result offers a separate Library or Sync action and performs no target mutation

#### Scenario: A plan becomes stale
- **WHEN** selection, source, Store or target evidence changes before apply
- **THEN** the UI renders typed remediation and requires a new preview without an automatic mutation retry

#### Scenario: A Collection Profile requests historical revert
- **WHEN** a user opens historical revert from a Profile defined by Collections
- **THEN** the client requires explicit resource selection and binds those artifact IDs, never an omitted scope-wide resource filter

#### Scenario: Recovery is required
- **WHEN** Core reports an interrupted or manual-recovery-required operation
- **THEN** the UI explains the blocker and exact supported next action without discarding journal evidence

### Requirement: User-facing status distinguishes configuration and observation
The client MUST independently present source update availability, current Store revision, deployment pending or conflicting state, configuration verification, discovery coverage, conversion limitations, and native loading evidence. It MUST NOT equate an available source update with target drift, a successful file write with native loading, or unknown/unperformed checks with success. Aggregated status MUST provide the underlying item or operation that explains it.

#### Scenario: Files converge without a native probe
- **WHEN** Core reports healthy configuration with unknown runtime evidence
- **THEN** the UI shows configured state and clearly unverified native loading

#### Scenario: A source is outside coverage
- **WHEN** Inventory excludes a plugin or parent source dimension
- **THEN** the discovery and resource views preserve that limitation instead of claiming a complete native configuration

#### Scenario: Source is newer than Store
- **WHEN** a stored item has an available source update but no target difference from the stored revision
- **THEN** the library shows “可更新” / “Update available” and does not count it as “同步问题” / “Sync issue”

#### Scenario: Store differs from a target
- **WHEN** Core reports a target pending or conflicting with the current Store revision
- **THEN** the library and Sync views identify the affected Agent and scope and provide a plan preview entry point without implying automatic sync

### Requirement: Interactive init reports bounded import plans without crashing
Interactive `init` SHALL preserve successful Store initialization and a complete Inventory when the default all-ready Store import plan exceeds the API body limit. It MUST NOT offer confirmation or import resources for that failed plan, and SHALL expose a typed size failure with guidance to select a smaller exact batch.

#### Scenario: Ready library exceeds the plan body limit
- **WHEN** default selection produces a `PLAN_BODY_BUDGET_EXCEEDED` planning result
- **THEN** `init` reports the typed limit and a smaller-batch next step without changing resource content

### Requirement: The Web opens as a recurring management workbench
The bundled Web client SHALL present Overview, Agent Config Library, Sync, Agents, Operation History, and Settings as primary destinations. It SHALL keep Inventory discovery, Collection management, Profile management, resource lifecycle actions, verification, recovery, and historical revert reachable from the destination matching the user's task. The Agent Config Library SHALL be the default destination whether it contains entries or an empty state; the client MUST NOT require a first-use stepper before recurring actions.

#### Scenario: Returning user opens the Web client
- **WHEN** the Store already contains configuration
- **THEN** the client opens the searchable Agent Config Library with its current entries and management actions, without a first-run prompt taking over the page

#### Scenario: User needs an existing secondary workflow
- **WHEN** the user navigates to Agents or Operation History
- **THEN** Profile edit/reconcile or operation recovery and revert remain discoverable without changing Core ownership or authority

#### Scenario: Overview is opened
- **WHEN** the user opens Overview
- **THEN** its counts and next actions derive from current typed evidence and distinguish unavailable or unverified observations from zero or success

### Requirement: Agent Config Library supports daily maintenance
The Agent Config Library SHALL list stored Skills, MCP server definitions, and Rules together with type tabs, name/source/ID search, group filtering, exact selection, and a detail view. It SHALL expose each item's source and Store revision, group membership, actual Agent/scope usage, and applicable update, removal, group, and sync actions from existing Core contracts. Filters MUST be presentation controls; checked resource IDs MUST remain explicit, visible as a count even when filtered out, and removable before an action.

#### Scenario: User inspects a configuration
- **WHEN** the user selects an MCP entry in the library
- **THEN** detail identifies its source, Store revision, group membership, secret reference names without values, and actual target usage or a clear absence of target usage

#### Scenario: User filters after selecting entries
- **WHEN** the user checks two exact IDs and changes type, text, or group filters
- **THEN** the selection still names those two IDs, indicates any hidden selected entries, and never expands to all filtered results

#### Scenario: Source revision changes
- **WHEN** a source update is available but deployed targets still match the current Store revision
- **THEN** the library labels the source update separately and does not call it a target sync problem

### Requirement: Discovery and manual additions have explicit boundaries
The library SHALL provide “查找已有配置” / “Find existing configuration” to open live Inventory review and exact Store import, and “添加配置” / “Add configuration” to open the existing validated resource-bundle import plan/apply path. It MUST NOT advertise an unsupported direct editor. Inventory provisional results MUST remain non-authoritative until the final scan result. A successful Store import SHALL return the user to the library or offer a separate sync journey and MUST NOT write an Agent target.

#### Scenario: Library is empty
- **WHEN** there are no stored configurations
- **THEN** the library shows a concise empty state with a discovery action and supported add action, without example counts or an onboarding wizard

#### Scenario: Inventory scan is still running
- **WHEN** progressive Inventory has provisional candidates but no final authoritative selection
- **THEN** the discovery view displays progress and findings but disables import preview and apply for those provisional candidates

#### Scenario: Import completes
- **WHEN** the user imports exact ready candidates using the unchanged Core plan
- **THEN** the items appear in the library and no target is described as synced until a separate sync succeeds

#### Scenario: User adds a resource bundle
- **WHEN** the user chooses “Add configuration” and supplies a bundle
- **THEN** the client validates and previews the exact Store import through the existing versioned contract, applies only the unchanged confirmed plan, and performs no target sync

### Requirement: Sync is a target-first reviewable workflow
The Sync destination SHALL make Agent, destination/scope, project root when relevant, and resource intent explicit before requesting a plan. It SHALL offer exact selected resources, an explicit group, an explicit Profile, or Store defaults as distinct intents, subject to the corresponding Core operation. The preview SHALL show Core-reported writes, skips, conflicts, unsupported capabilities, and shared-consumer effects before confirmation. The client MUST apply only the unchanged current plan and SHALL offer verification after an operation receipt.

#### Scenario: User starts sync without an explicit resource intent
- **WHEN** the user selects an Agent and scope but has not chosen exact resources, a group, a Profile, or Store defaults
- **THEN** preview remains unavailable and the client asks for a resource intent

#### Scenario: User reviews a shared target change
- **WHEN** the Core plan reports that a physical target has another consumer or cannot be removed
- **THEN** the preview exposes that result and does not promise deletion of the physical file

#### Scenario: Sync succeeds
- **WHEN** the unchanged reviewed plan applies and returns an operation receipt
- **THEN** the client reports the receipt, refreshes target evidence, and offers a separate verification action without claiming native loading was observed

### Requirement: Operation History exposes follow-up actions
Operation History SHALL present Core activity and operation receipts with type, time, outcome, affected targets, and typed next action where available. It SHALL make supported verification, recovery, and historical revert entry points discoverable and MUST preserve Core's exact selection and plan/apply rules.

#### Scenario: An operation requires recovery
- **WHEN** Core reports manual recovery required
- **THEN** the operation detail shows the typed blocker and supported recovery action without hiding the journal or retrying automatically

#### Scenario: A user reviews an old sync
- **WHEN** the user opens its operation record
- **THEN** the UI distinguishes historical receipt from current target status and requires a fresh plan for any revert

### Requirement: Workbench labels and layout remain understandable
The bundled Web client SHALL use coherent Simplified Chinese labels for Chinese browser language and English labels otherwise for the primary destinations, status terms, action labels, and preview summaries. It SHALL call the user-facing Store workspace “Agent 配置库” / “Agent Config Library” and Collection membership “分组” / “Group”, while retaining Skills, MCP, Rules, Agent, and Core identifiers where they convey exact meaning. Primary journeys SHALL be keyboard operable and remain usable on narrow screens without hiding selected scope or confirmation details.

#### Scenario: Chinese browser opens the workbench
- **WHEN** the browser prefers Simplified Chinese
- **THEN** navigation, library actions, sync intent, and status labels use the defined Chinese vocabulary rather than “受管资源” or “内容库”

#### Scenario: Narrow screen previews a sync
- **WHEN** the viewport cannot display the list and detail side by side
- **THEN** the client presents a usable stacked or separate detail view with the exact selected resources, Agent, scope, and plan still accessible before confirmation
