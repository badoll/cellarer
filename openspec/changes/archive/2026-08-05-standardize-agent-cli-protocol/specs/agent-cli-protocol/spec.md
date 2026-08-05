## ADDED Requirements

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
The CLI MUST support explicit non-interactive execution and SHALL fail with a typed input-required error when mandatory input or acknowledgement is absent.

#### Scenario: Mutation lacks required acknowledgement
- **WHEN** a non-interactive apply requires a destructive acknowledgement not present in the request
- **THEN** the CLI emits `INPUT_REQUIRED`, performs no mutation, and does not open a prompt

#### Scenario: Machine mode is selected
- **WHEN** JSON/JSONL output or structured stdin input is selected
- **THEN** prompt-capable command behavior is non-interactive

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
