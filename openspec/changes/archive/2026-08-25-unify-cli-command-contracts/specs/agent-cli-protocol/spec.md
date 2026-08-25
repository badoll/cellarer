## ADDED Requirements

### Requirement: One command contract defines every CLI leaf
Every executable CLI leaf SHALL be defined by one authoritative typed command contract that binds its command path, mutability, streaming trait, options and positionals, structured-input bindings, closed input/output/event schemas, execution handler, presentation projection, and typed error mapping. Each supported CLI composition SHALL establish exactly one complete aggregate catalog containing every known executable leaf. Commander registration, executable matching, structured-input normalization, contract execution, machine-error projection, machine envelope rendering, capability discovery, and schema retrieval MUST derive from that catalog.

The supported composition boundary MUST NOT accept a caller-selected replacement catalog, known/unknown classification, or fallback policy after initialization. Catalog metadata used for protocol behavior MUST remain immutable after composition, and rendering plus schema publication MUST continue to observe the same canonical command definitions.

Executable matching MUST distinguish a known leaf from a genuine no-executable match. A known leaf whose canonical definition is missing or inconsistent MUST fail as an invariant and MUST NOT enter the generic unregistered-command projection. Only a genuine no-executable match MAY use that projection, and it MUST NOT acquire known-leaf schema, binding, or required-feature metadata.

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

#### Scenario: Known leaf fails before action execution
- **WHEN** structured-input validation or a parse-time, build-time, or Commander machine failure occurs for a known executable leaf
- **THEN** its input binding and machine-error schema derive from that leaf's definition in the complete aggregate catalog
- **THEN** the command action and Core handler are not executed

#### Scenario: Known leaf renderer lacks an aggregate definition
- **WHEN** the renderer is asked to project a machine result for a known executable leaf whose definition is absent from the complete aggregate catalog
- **THEN** catalog lookup reports an invariant/conformance failure
- **THEN** rendering fails closed without an optional-definition path or implicit generic unregistered-command fallback

#### Scenario: A caller attempts to replace composition or downgrade a known leaf
- **WHEN** a supported composition has identified a known executable leaf and a caller supplies an alternate catalog, unknown marker, or fallback policy
- **THEN** the supported composition rejects the override and retains its initialized catalog classification
- **THEN** the unregistered-command projection is not used

#### Scenario: Nested protocol metadata is mutated after initialization
- **WHEN** a caller attempts to mutate nested schema, structured-binding, or required-feature metadata after the catalog is established
- **THEN** the canonical graph remains deeply immutable and observed protocol behavior does not change
- **THEN** renderer validation and the published protocol schema bundle still reference the identical canonical schema nodes

#### Scenario: A genuinely unknown command reaches machine error rendering
- **WHEN** a command key is absent from both the known executable set and the active aggregate catalog
- **THEN** only the stable unregistered-command projection may be used
- **THEN** no known-leaf schema, binding, or required-feature metadata is attached

#### Scenario: Supported compositions publish the complete protocol view
- **WHEN** the installed CLI, a standalone composition, or a test composition exposes capability or schema discovery
- **THEN** discovery uses that composition's complete aggregate catalog and does not publish a domain-subset protocol catalog
