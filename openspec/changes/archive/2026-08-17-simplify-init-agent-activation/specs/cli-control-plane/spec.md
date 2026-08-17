## MODIFIED Requirements

### Requirement: First-run target selection is explicit
Initialization MUST report supported, detected, configured, and enabled agents, MUST persist only an exact first-run activation set, and MUST NOT treat activation as authorization to distribute resources. Non-interactive initialization MUST require either exact agent targets or an explicit empty target set.

#### Scenario: Non-interactive init omits target intent
- **WHEN** `init` is invoked non-interactively without exact agent targets or an explicit empty target set
- **THEN** it returns `INPUT_REQUIRED` with the inventory, performs no initialization mutation, and does not enable every detected agent

#### Scenario: Non-interactive init explicitly selects no agents
- **WHEN** `init` is invoked non-interactively with an explicit empty target set
- **THEN** initialization succeeds with every built-in agent disabled and reports the resulting inventory

#### Scenario: Human confirms selected targets
- **WHEN** an interactive text-mode user chooses exact agents from the supported inventory
- **THEN** initialization persists only those agents and reports detection and unsupported capabilities before any separate distribution

#### Scenario: Human confirms an empty target set
- **WHEN** an interactive text-mode user explicitly chooses no agents
- **THEN** initialization persists an empty enabled-agent set without distributing, deleting, or modifying any agent target

#### Scenario: Initialization never distributes resources
- **WHEN** initialization succeeds with one or more enabled agents
- **THEN** it creates or preserves only Cellarer Store/configuration state and does not write Rules, MCP definitions, or Skills to agent targets

#### Scenario: Repeated initialization matches persisted activation
- **WHEN** `init` receives an exact target set equal to the effective enabled-agent set in an existing config
- **THEN** initialization preserves that config and reports an idempotent successful result

#### Scenario: Repeated initialization conflicts with persisted activation
- **WHEN** `init` receives an exact target set different from the effective enabled-agent set in an existing config
- **THEN** it returns a typed validation failure with current and requested sets, leaves the config unchanged, and directs the caller to `agent enable` and `agent disable`
