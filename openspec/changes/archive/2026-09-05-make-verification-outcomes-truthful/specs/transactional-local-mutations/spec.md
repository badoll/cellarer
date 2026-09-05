## MODIFIED Requirements

### Requirement: Verification separates desired state and disk drift
The system SHALL report desired-versus-applied differences separately from applied-versus-disk receipt drift and MUST include incomplete operations and requested-target coverage in configuration health. Configuration health MUST NOT imply native Agent loading or MCP connectivity.

#### Scenario: Selection changed but targets are intact
- **WHEN** desired resource selection differs from the last applied state and all applied targets match their receipts
- **THEN** verification reports desired-state divergence without reporting target drift

#### Scenario: Applied file was edited
- **WHEN** desired state still matches the last apply but an applied target differs from its receipt
- **THEN** verification reports target drift without reporting desired-state divergence

#### Scenario: Unknown Agent is requested
- **WHEN** verification receives an unregistered Agent identity
- **THEN** it returns a typed invalid-input outcome instead of an empty healthy report

#### Scenario: Requested capability is unsupported or disabled
- **WHEN** a requested Agent and capability cannot be evaluated because the capability is unsupported or the Agent is disabled
- **THEN** coverage identifies that request as incomplete and healthy is false

#### Scenario: Planning fails for a requested target
- **WHEN** a requested target cannot be planned or observed
- **THEN** verification preserves successful comparisons and the typed failure, and MUST NOT classify the complete request as healthy

#### Scenario: A legitimate selection has no resources
- **WHEN** a valid registered and supported request resolves to no resources and has no outstanding deployment or recovery issue
- **THEN** verification reports an explicit no-op outcome with healthy false, distinct from failure and from loaded configuration

#### Scenario: Configuration is consistent but runtime was not inspected
- **WHEN** requested targets are covered, desired and applied evidence agree, disk receipts match, and recovery is clean without a native probe
- **THEN** configuration health is true and native runtime evidence remains explicitly unknown

#### Scenario: Verification runs without mutation authority
- **WHEN** a client verifies configuration without mutation authority or secret providers
- **THEN** verification only observes journal and lock presence for its recovery axis; absent state is clean, while outstanding or unreadable state conservatively requires recovery inspection without authorizing recovery

## ADDED Requirements

### Requirement: Verification outcomes retain coverage across clients
CLI, local API, and bundled Web clients MUST preserve the Core verification coverage, configuration outcome, comparison axes, and independent runtime evidence without inferring success from empty arrays, warning text, or transport success.

#### Scenario: The same request crosses client boundaries
- **WHEN** equivalent verification inputs reach Core through CLI and HTTP
- **THEN** both expose the same typed coverage and configuration result; CLI maps invalid input to its input-error class, incomplete or unhealthy configuration to its domain-error class, and a legitimate no-op to its success class

#### Scenario: A partial result reaches the Web client
- **WHEN** the API returns successful transport with incomplete Core coverage
- **THEN** the client displays incomplete configuration rather than verification passed
