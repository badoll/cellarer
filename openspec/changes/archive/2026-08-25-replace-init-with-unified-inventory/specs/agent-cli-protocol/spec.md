## ADDED Requirements

### Requirement: Machine initialization returns Inventory without implicit import
JSON, JSONL, structured-input, non-TTY, and explicitly non-interactive initialization MUST never prompt or infer a candidate selection. After Store creation or validation, it SHALL return the redacted live Inventory and perform no resource import or agent-target mutation.

#### Scenario: Machine init discovers ready candidates
- **WHEN** init runs in any non-interactive transport and Inventory contains ready candidates
- **THEN** it returns those candidates in a schema-valid result and imports none of them

### Requirement: Initialization command contracts contain no activation selection
Capability discovery, schema retrieval, argv help, and structured input MUST describe Inventory-first initialization without init-time agent activation fields or prompt-selection schemas.

#### Scenario: Agent inspects migrated init capabilities
- **WHEN** `cellarer capabilities --output json` or init help is requested after the migration
- **THEN** init exposes no `--agent`, `--no-agent`, structured `agents`, or selector contract while Inventory refresh/import remains separately discoverable

#### Scenario: Removed init-selection schema is requested
- **WHEN** a caller requests a superseded init-selection schema identifier
- **THEN** schema retrieval returns the stable unsupported-schema failure and does not expose a compatibility alias

## MODIFIED Requirements

### Requirement: Non-interactive execution never prompts
The CLI MUST support explicit non-interactive execution, SHALL fail with a typed input-required error when mandatory input or acknowledgement is absent, and MUST invoke prompt-capable behavior only for text-mode TTY interaction. An explicit empty collection MUST remain distinguishable from omitted mandatory input, but initialization MUST NOT use an agent-target collection as first-run input.

#### Scenario: Mutation lacks required acknowledgement
- **WHEN** a non-interactive apply requires a destructive acknowledgement not present in the request
- **THEN** the CLI emits `INPUT_REQUIRED`, performs no mutation, and does not open a prompt

#### Scenario: Machine mode is selected
- **WHEN** JSON/JSONL output or structured stdin input is selected
- **THEN** prompt-capable command behavior is non-interactive

#### Scenario: Machine initialization completes Store setup
- **WHEN** machine-mode `init` creates or validates the Store
- **THEN** it returns the redacted refreshed Inventory, imports no candidate, and does not request agent activation input
