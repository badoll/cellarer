## ADDED Requirements

### Requirement: Legacy discovery and scan command contracts are absent
After Inventory migration, capability discovery, schema retrieval, command registration, and help MUST expose unified Inventory refresh/import and MUST NOT advertise discovery-summary or mutating scan command contracts, schema identifiers, options, or compatibility aliases.

#### Scenario: Agent inspects command capabilities
- **WHEN** a caller requests machine-readable CLI capabilities after migration
- **THEN** Inventory refresh/import contracts are present and discovery-summary/scan contracts are absent

#### Scenario: Removed schema is requested
- **WHEN** a caller requests a discovery-summary or scan schema identifier
- **THEN** schema retrieval returns the stable unsupported-schema failure without translating it to an Inventory schema

#### Scenario: Removed command is invoked
- **WHEN** a caller invokes the prior discovery-summary or scan command path
- **THEN** CLI usage resolution fails before Core invocation, mutation authority use, or Store effects
