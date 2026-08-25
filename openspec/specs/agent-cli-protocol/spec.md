# agent-cli-protocol Specification

## Purpose
Define the stable, versioned, non-interactive CLI protocol used by agents to discover commands, submit structured requests, and consume machine-readable results.

## Requirements

### Requirement: Machine results use a versioned envelope
Every command supporting JSON output MUST emit a schema-valid result envelope with protocol version, command identity, request identity, terminal status, typed payload, warnings, and optional typed error.

#### Scenario: Read-only command succeeds in JSON mode
- **WHEN** an agent invokes a command with `--output json`
- **THEN** stdout contains exactly one valid success envelope and no presentation text

#### Scenario: Command fails in JSON mode
- **WHEN** a command returns a typed failure
- **THEN** stdout contains exactly one valid error envelope and the process exits with the mapped nonzero exit class

### Requirement: JSONL streams have one terminal result
Commands that support `--output jsonl` SHALL emit individually valid versioned event envelopes and MUST end successful or handled-failure execution with exactly one terminal result envelope.

#### Scenario: Apply emits progress records
- **WHEN** apply runs in JSONL mode
- **THEN** each stdout line is a complete event envelope and the final line is the terminal operation result

#### Scenario: Process ends without a terminal record
- **WHEN** a consumer receives a truncated JSONL stream without a terminal result
- **THEN** the protocol defines the invocation as transport-interrupted rather than successful

### Requirement: Machine stdout is protocol-only
In JSON and JSONL modes the system MUST reserve stdout for protocol records and MUST disable prompts, color, spinners, banners, and incidental logs.

#### Scenario: Debug diagnostics are enabled
- **WHEN** an agent requests diagnostics with JSON output
- **THEN** redacted diagnostics are written only to stderr and stdout remains schema-valid

### Requirement: Non-interactive execution never prompts
The CLI MUST support explicit non-interactive execution, SHALL fail with a typed input-required error when mandatory input or acknowledgement is absent, and MUST invoke prompt-capable behavior only for text-mode TTY interaction. An explicit empty collection MUST remain distinguishable from omitted mandatory input.

#### Scenario: Mutation lacks required acknowledgement
- **WHEN** a non-interactive apply requires a destructive acknowledgement not present in the request
- **THEN** the CLI emits `INPUT_REQUIRED`, performs no mutation, and does not open a prompt

#### Scenario: Machine mode is selected
- **WHEN** JSON/JSONL output or structured stdin input is selected
- **THEN** prompt-capable command behavior is non-interactive

#### Scenario: Non-TTY text mode omits init targets
- **WHEN** text-mode `init` has no explicit target intent and stdin is not a TTY
- **THEN** the CLI emits `INPUT_REQUIRED` with inventory and does not attempt to read a prompt

#### Scenario: Interactive text mode omits init targets
- **WHEN** text-mode `init` has no explicit target intent and stdin is a TTY
- **THEN** the CLI presents the agent inventory and obtains one exact target selection before invoking Core

#### Scenario: Structured init explicitly selects no agents
- **WHEN** a valid structured init request contains `agents: []`
- **THEN** the CLI treats it as an explicit empty target set, does not prompt, and invokes Core with zero targets

#### Scenario: Conflicting init target forms are supplied
- **WHEN** an init invocation supplies both exact agent targets and the explicit no-agent form
- **THEN** the CLI returns `INPUT_AMBIGUITY` and performs no initialization mutation

### Requirement: Structured requests are schema validated
The CLI SHALL accept a versioned command request through `--input <path|->`, MUST validate it before Core invocation, and MUST reject ambiguous duplicate domain inputs.

#### Scenario: Agent pipes a valid request
- **WHEN** a request matching the command input schema is supplied with `--input -`
- **THEN** the CLI invokes the named command with those normalized domain inputs

#### Scenario: Same field appears in argv and request
- **WHEN** a command-domain field is supplied both as an argument and in the structured request
- **THEN** the CLI returns an input-ambiguity error and performs no operation

### Requirement: Exit classes and error codes are stable
The CLI MUST use exit code `0` for success, `2` for usage/input-schema failure, `3` for policy/domain validation, `4` for concurrency or precondition conflict, `5` for execution/partial failure, `6` for recovery required, and `70` for unexpected internal failure, with a stable string error code for handled failures.

#### Scenario: Stale plan is rejected
- **WHEN** apply returns the stale-revision error type
- **THEN** the CLI exits `4` and emits the documented stable error code independent of human message locale

#### Scenario: Unexpected exception crosses the boundary
- **WHEN** an unclassified exception reaches the command boundary
- **THEN** the CLI emits a redacted internal-error envelope and exits `70`

### Requirement: Protocol capabilities and schemas are discoverable
The CLI SHALL expose local commands that report supported protocol versions, command traits, input/output schema identifiers, and retrievable JSON Schemas without network access.

#### Scenario: Agent inspects available commands
- **WHEN** `cellarer capabilities --output json` is invoked
- **THEN** the result lists each registered command with mutability, streaming support, and schema identifiers

#### Scenario: Agent requests a command schema
- **WHEN** `cellarer schema` is invoked for a reported schema identifier
- **THEN** the CLI returns the matching JSON Schema in protocol-only output

### Requirement: Version output reflects the installed package
The CLI MUST derive its user-visible version from build or package metadata for the installed artifact.

#### Scenario: Version command runs from a packed install
- **WHEN** the executable is installed from a package tarball and invoked with `--version`
- **THEN** it prints the version declared by that installed package rather than a hard-coded development value

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

### Requirement: Inventory refresh has a discoverable read-only machine contract
The command catalog SHALL advertise full and targeted Inventory refresh as read-only operations with closed input and output schemas for exact candidate IDs, simple states, default selection, sources, adapters, findings, aggregate counts, and completeness. Machine refresh MUST never prompt or infer a mutation.

#### Scenario: Agent discovers Inventory refresh
- **WHEN** a caller requests CLI capabilities and the Inventory schemas
- **THEN** it receives the implemented refresh command traits and matching closed schemas without network access

#### Scenario: Machine refresh is partial
- **WHEN** a JSON or JSONL refresh observes candidate-local failures
- **THEN** the terminal result preserves successful candidates and typed completeness in a schema-valid protocol envelope
