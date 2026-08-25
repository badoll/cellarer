## ADDED Requirements

### Requirement: Inventory refresh has a discoverable read-only machine contract
The command catalog SHALL advertise full and targeted Inventory refresh as read-only operations with closed input and output schemas for exact candidate IDs, simple states, default selection, sources, adapters, findings, aggregate counts, and completeness. Machine refresh MUST never prompt or infer a mutation.

#### Scenario: Agent discovers Inventory refresh
- **WHEN** a caller requests CLI capabilities and the Inventory schemas
- **THEN** it receives the implemented refresh command traits and matching closed schemas without network access

#### Scenario: Machine refresh is partial
- **WHEN** a JSON or JSONL refresh observes candidate-local failures
- **THEN** the terminal result preserves successful candidates and typed completeness in a schema-valid protocol envelope
