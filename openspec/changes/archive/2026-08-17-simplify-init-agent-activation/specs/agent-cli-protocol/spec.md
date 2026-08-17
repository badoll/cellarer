## MODIFIED Requirements

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
