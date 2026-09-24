## ADDED Requirements

### Requirement: Explicit intent binds the sync request
Agent Config Library type, text, and group filters MUST NOT silently determine a sync request. A library action on checked rows SHALL send only their exact Store resource IDs. A separate, explicit group action SHALL send the selected Collection identifier, and a separate Store-default action SHALL use Core's existing default-selection semantics. A Profile action SHALL use the Profile sync contract. The UI MUST identify which intent is active and MUST distinguish Inventory-only candidates from stored resources that can be synced.

#### Scenario: A filtered page starts exact sync
- **WHEN** the user filters Rules to group work, checks two rows, and opens sync
- **THEN** the summary and preview request name only those two immutable Store IDs and do not select every Rule in work

#### Scenario: User selects a group explicitly
- **WHEN** the user chooses “Sync group work” rather than checking rows
- **THEN** the summary and request name group work as the explicit Collection selection, including the scope of stored matching resources

#### Scenario: A filter is cleared
- **WHEN** the user clears a group filter without changing the chosen sync intent
- **THEN** the request retains the existing exact IDs or explicit group; it does not switch to Store defaults

#### Scenario: Store defaults are chosen
- **WHEN** the user explicitly chooses Store defaults in the Sync destination
- **THEN** the summary identifies Store defaults and the request uses the corresponding existing default semantics

#### Scenario: Discovered resources are visible
- **WHEN** Inventory-only candidates appear in discovery alongside stored resources
- **THEN** the sync summary excludes those candidates and explains that they must be imported first

## MODIFIED Requirements

### Requirement: Selection changes invalidate preview authority
The bundled client MUST bind preview state to the exact Agent set, destination/scope, normalized project root, resource intent and its exact IDs, kinds, group or Profile identifier, and current dialog/session. Any material selection change or dialog close/reopen MUST invalidate the prior plan; presentation-only filter changes that preserve the same intent MUST NOT authorize a different plan. An obsolete request MUST NOT overwrite current preview, error, busy state, or apply eligibility.

#### Scenario: Selection changes after preview
- **WHEN** the user changes exact IDs, group, Profile, Agent, scope, or project root after a preview
- **THEN** Apply remains disabled until a new preview for that selection completes

#### Scenario: An obsolete request finishes
- **WHEN** a prior preview returns success or error after the selection changed
- **THEN** it cannot overwrite the current preview, error, busy state, or apply eligibility

#### Scenario: Equivalent selection is rendered again
- **WHEN** a parent rerenders equivalent ID, group, Agent, and kind arrays or an input changes only normalized whitespace
- **THEN** the current selection retains its valid preview or pending preview lifecycle

#### Scenario: A filter hides a selected row
- **WHEN** a presentation filter hides a checked resource without changing its exact ID selection
- **THEN** the client keeps that ID visible in the selected count or summary and does not silently add or drop it from the current plan

#### Scenario: Dialog is reopened
- **WHEN** the user closes a previewed dialog and opens it again
- **THEN** the previous plan is not eligible for submission

### Requirement: Web applies only the reviewed plan
The Web client MUST submit the unchanged mutationPlan returned for the current reviewed selection and SHALL display typed stale-plan remediation without automatic mutation retries. The displayed preview MUST come from the same current Core response as the submitted plan, including target and shared-consumer effects when reported.

#### Scenario: User confirms the current preview
- **WHEN** the current selection still matches the reviewed plan
- **THEN** the client submits that exact plan without reconstructing actions or substituting resource filters

#### Scenario: Store changes after preview
- **WHEN** the server rejects the plan as stale
- **THEN** the UI requires a fresh preview and does not silently rebuild or submit another plan

#### Scenario: Shared target preview is displayed
- **WHEN** Core reports a retained physical target with another consumer
- **THEN** the preview describes the retained target and the submitted plan remains Core's original receipt

## REMOVED Requirements

### Requirement: Resource filters bind the sync request
**Reason**: A presentation filter is not a reliable expression of sync intent in a unified, searchable library.
**Migration**: Users explicitly choose checked resource IDs, a group, a Profile, or Store defaults before preview. Clearing a filter does not change that choice.
