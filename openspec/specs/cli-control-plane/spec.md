# cli-control-plane Specification

## Purpose
Define the complete Core-backed CLI control plane for inventory, agent and adapter configuration, collections, exact resource selection, settings, initialization, operational evidence, and transactional dry-run/apply behavior.

## Requirements

### Requirement: CLI exposes a complete resource inventory
The CLI SHALL list and show managed and discovered Skills, MCP definitions, and Rules with stable resource identity, kind, source, provenance, validation state, collection membership, selection state, and secret reference names.

#### Scenario: Agent requests resource inventory
- **WHEN** `resource list` is invoked in machine mode with kind, source, or state filters
- **THEN** the result contains every matching resource as a schema-valid inventory item with no secret values

#### Scenario: Resource ID is inspected
- **WHEN** `resource show` receives an existing immutable resource ID
- **THEN** it returns the resource detail, provenance, current validation findings, and desired/applied usage

### Requirement: CLI manages the agent inventory and configuration
The CLI SHALL distinguish supported, detected, configured, and enabled agents and SHALL expose planned commands to enable, disable, configure, reset, add, update, and remove allowed adapter configuration.

#### Scenario: Agent inventory is listed
- **WHEN** `agent list` runs
- **THEN** each registered adapter row includes detection evidence, enabled/configured state, supported capabilities, scope targets, and validation issues

#### Scenario: Built-in agent is customized
- **WHEN** a caller configures a built-in agent and applies the plan
- **THEN** the settings are persisted as an `adapterOverrides` entry and the operation receipt identifies the changed adapter

#### Scenario: Custom agent is added
- **WHEN** a valid declarative adapter definition is planned and applied
- **THEN** it is persisted under `customAdapters` without adding agent-specific branches to Core engines

#### Scenario: Custom adapter is removed while targets remain
- **WHEN** removal would orphan owned targets or desired selections
- **THEN** the plan is blocked and reports the exact dependencies instead of deleting the adapter

### Requirement: CLI manages collections exactly
The CLI SHALL support collection list/show/create/update/delete and exact resource membership/default management using immutable resource IDs.

#### Scenario: Collection is created from exact members
- **WHEN** a caller creates a collection with valid resource IDs and applies the plan
- **THEN** the stored collection contains those exact identities and returns its revisioned receipt

#### Scenario: Collection deletion affects desired state
- **WHEN** a collection is selected by current desired configuration
- **THEN** ordinary collection deletion is blocked with the dependent selection evidence

### Requirement: Mutating selections are unambiguous
Every mutating resource selection MUST use an immutable resource ID or a complete kind, name, and source tuple; name-only values MUST NOT authorize a mutation.

#### Scenario: Duplicate names exist across sources
- **WHEN** an apply request provides only a name matching more than one resource
- **THEN** the CLI returns an ambiguous-selector error and creates no mutating plan

#### Scenario: Full selector identifies one resource
- **WHEN** kind, name, and source identify exactly one valid resource
- **THEN** planning selects that resource and records its immutable identity in the plan

### Requirement: CLI exposes settings without manual file editing
The CLI SHALL show, validate, and mutate supported non-secret settings through typed schemas and the transactional plan/apply protocol.

#### Scenario: Settings validation finds an unknown field
- **WHEN** `config validate` receives a structured settings request with an unsupported field
- **THEN** the CLI reports its schema location and performs no mutation

#### Scenario: Settings update is applied
- **WHEN** a valid configuration plan is applied at the matching revision
- **THEN** the store advances one revision and returns a receipt describing redacted changed fields

### Requirement: First-run Inventory review is automatic and explicit
Initialization SHALL create or validate Store state and automatically refresh complete bounded Inventory without asking the user to select agents. Interactive text mode SHALL offer one confirmation for the exact Core-default-selected ready candidates through the normal import plan/apply flow. Initialization and import MUST NOT distribute resources.

#### Scenario: Interactive first initialization finds ready candidates
- **WHEN** a text-mode TTY user invokes `init` without domain options
- **THEN** the CLI shows completeness, state, and selected counts and asks once before applying the unchanged exact import plan

#### Scenario: Interactive user declines import
- **WHEN** the user declines the unified confirmation
- **THEN** Store initialization remains successful, no resource is imported, and every agent target remains unchanged

#### Scenario: Initialization is repeated
- **WHEN** init runs against an existing Store
- **THEN** it refreshes current sources, leaves equal in-store revisions unselected, and offers only current new or changed ready candidates

#### Scenario: Refresh fails after Store creation
- **WHEN** Store initialization succeeds but Inventory refresh is partial or failed
- **THEN** the CLI reports the states separately and provides an exact refresh retry without undoing Store initialization

### Requirement: CLI exposes operational state and evidence
The CLI SHALL provide desired/applied diff, target status, combined verification, Inventory refresh summaries, and redacted operation list/show commands using shared Core DTOs.

#### Scenario: Desired configuration changed after apply
- **WHEN** a resource or collection selection changes without applying
- **THEN** `diff` reports the exact proposed target actions while `status` continues to report current owned target health

#### Scenario: Inventory summary is requested
- **WHEN** a user runs `inventory refresh`
- **THEN** it reports candidate counts and completeness without importing or writing target state

#### Scenario: Operation receipt is queried
- **WHEN** `operation show` receives a completed operation ID
- **THEN** it returns plan identity, revisions, redacted action outcomes, and recovery status

### Requirement: All control-plane mutations support dry-run
Every agent, adapter, collection, settings, plan/apply, revert, and recovery mutation SHALL support a read-only plan result and MUST execute through the transactional mutation protocol.

#### Scenario: Caller dry-runs an agent disable
- **WHEN** an enabled agent is disabled with `--dry-run`
- **THEN** the CLI returns the revisioned plan and dependency effects without changing store or targets

### Requirement: CLI exposes unified read-only Inventory refresh
The CLI SHALL expose `inventory refresh` for complete and exact per-adapter live refresh using the shared Core Inventory DTO. Human and machine output MUST include candidate identity, state, default selection, provenance, related adapters, findings, managed match, counts, and completeness without importing or writing target state.

#### Scenario: Human refreshes all registered sources
- **WHEN** `inventory refresh` runs without an adapter filter
- **THEN** it renders the deduplicated complete-or-partial result across every bounded registered source

#### Scenario: Caller refreshes one adapter
- **WHEN** `inventory refresh --agent <id>` receives a registered adapter ID
- **THEN** it returns the same DTO shape narrowed to that adapter

### Requirement: CLI imports Inventory through explicit plan and apply
The CLI SHALL expose separate `inventory import plan` and `inventory import apply` commands. Planning MUST require exact candidate IDs, and apply MUST consume the unchanged authority-sealed plan receipt. Neither command SHALL distribute resources to agent targets.

#### Scenario: Human plans selected candidates
- **WHEN** a user supplies exact ready candidate IDs to `inventory import plan`
- **THEN** the CLI renders the exact Store publications and zero target actions without applying them

#### Scenario: Caller applies a plan receipt
- **WHEN** `inventory import apply` receives an unchanged current plan
- **THEN** it returns the typed operation receipt from Core without reconstructing selection

### Requirement: Legacy discovery and scan product paths are removed
The CLI MUST use Inventory refresh/import for source observation and Store import and MUST NOT retain discovery-summary or mutating scan as executable, hidden, aliased, or compatibility product paths.

#### Scenario: User follows the replacement journey
- **WHEN** a user needs to observe registered sources and import selected candidates
- **THEN** `inventory refresh`, `inventory import plan`, and `inventory import apply` provide the supported path without writing agent targets

#### Scenario: Legacy scan input is supplied
- **WHEN** a user supplies options from the removed scan command
- **THEN** the CLI rejects the command before selection, planning, mutation authorization, or Store writes
