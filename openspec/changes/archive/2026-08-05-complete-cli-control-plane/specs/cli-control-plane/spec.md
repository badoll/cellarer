## ADDED Requirements

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

### Requirement: First-run target selection is explicit
Initialization MUST report detected and configured agents and MUST require an explicit target set for non-interactive mutation.

#### Scenario: Non-interactive init omits targets
- **WHEN** `init` is invoked non-interactively without exact agent targets
- **THEN** it returns `INPUT_REQUIRED` with the inventory and does not enable every detected agent

#### Scenario: Human confirms selected targets
- **WHEN** an interactive user chooses exact agents from the detected inventory
- **THEN** initialization persists only those agents and reports unsupported capabilities before distribution

### Requirement: CLI exposes operational state and evidence
The CLI SHALL provide desired/applied diff, target status, combined verification, discovery summary, and redacted operation list/show commands using shared Core DTOs.

#### Scenario: Desired configuration changed after apply
- **WHEN** a resource or collection selection changes without applying
- **THEN** `diff` reports the exact proposed target actions while `status` continues to report current owned target health

#### Scenario: Operation receipt is queried
- **WHEN** `operation show` receives a completed operation ID
- **THEN** it returns plan identity, revisions, redacted action outcomes, and recovery status

### Requirement: All control-plane mutations support dry-run
Every agent, adapter, collection, settings, plan/apply, revert, and recovery mutation SHALL support a read-only plan result and MUST execute through the transactional mutation protocol.

#### Scenario: Caller dry-runs an agent disable
- **WHEN** an enabled agent is disabled with `--dry-run`
- **THEN** the CLI returns the revisioned plan and dependency effects without changing store or targets
