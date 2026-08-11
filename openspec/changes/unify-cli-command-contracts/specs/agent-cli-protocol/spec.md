## ADDED Requirements

### Requirement: One command contract defines every CLI leaf
Every executable CLI leaf SHALL be defined by one authoritative typed command contract that binds its command path, mutability, streaming trait, options and positionals, structured-input bindings, closed input/output/event schemas, execution handler, presentation projection, and typed error mapping. Commander registration, capability discovery, schema retrieval, input normalization, and machine envelope rendering MUST derive from that contract catalog.

#### Scenario: A new executable leaf lacks a contract
- **WHEN** a command is registered in the executable Commander tree without a matching authoritative contract
- **THEN** catalog conformance fails before the change can be closed

#### Scenario: A contract lacks an executable leaf
- **WHEN** capability discovery advertises a command contract that is not registered for execution
- **THEN** catalog conformance fails and the schema is not published as supported behavior

#### Scenario: Human and structured inputs overlap
- **WHEN** the same domain field is supplied through argv and a structured request
- **THEN** normalization uses the contract's single binding definition to return the existing typed ambiguity failure before Core invocation

#### Scenario: Existing command migrates to the catalog
- **WHEN** an existing leaf is migrated without an intentional product change
- **THEN** its help, argv behavior, protocol schemas, envelopes, exit class, prompt classification, and Core request remain semantically identical
