## ADDED Requirements

### Requirement: Machine initialization returns Inventory without implicit import
JSON, JSONL, structured-input, non-TTY, and explicitly non-interactive initialization MUST never prompt or infer a candidate selection. After Store creation or validation, it SHALL return the redacted live Inventory and perform no resource import or agent-target mutation.

#### Scenario: Machine init discovers ready candidates
- **WHEN** init runs in any non-interactive transport and Inventory contains ready candidates
- **THEN** it returns those candidates in a schema-valid result and imports none of them

### Requirement: Superseded initialization and scan contracts are absent
Capability discovery and schema retrieval MUST advertise Inventory refresh/import and MUST NOT advertise init agent-selection, discovery-summary, or mutating-scan command contracts after migration.

#### Scenario: Agent inspects migrated capabilities
- **WHEN** `cellarer capabilities --output json` is invoked after the migration
- **THEN** it lists Inventory operations and excludes every removed command and schema identifier

#### Scenario: Removed command schema is requested
- **WHEN** a caller requests a superseded init-selection, discovery-summary, or scan schema identifier
- **THEN** schema retrieval returns the stable unsupported-schema failure and does not expose a compatibility alias
