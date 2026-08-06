## ADDED Requirements

### Requirement: Profiles record exact reusable desired state
The system SHALL store named profiles containing exact agent identities, scope, resource and collection identities, capability filters, placement method, and non-destructive merge policy.

#### Scenario: Multi-agent profile is created
- **WHEN** a valid profile selects multiple registered agents and exact resources
- **THEN** it is stored as a revisioned desired-state document without applying targets

#### Scenario: Profile contains a destructive acknowledgement
- **WHEN** a profile request includes a persistent force, drift override, or unowned-target replacement acknowledgement
- **THEN** validation rejects that field

### Requirement: Profile CRUD is dependency aware
The system SHALL support profile list/show/create/update/delete through the transaction protocol and MUST validate referenced agents, resources, and collections at mutation time.

#### Scenario: Referenced custom adapter was removed
- **WHEN** a profile update or plan resolves an agent ID that no longer exists
- **THEN** it returns the exact missing dependency and performs no target mutation

### Requirement: Profile planning resolves exact revisions
`sync plan` MUST resolve all profile resources and collections to exact immutable resource IDs and current revisions and SHALL bind the resolved agent target paths and store revision into the plan.

#### Scenario: Collection membership changed
- **WHEN** a profile references a collection whose membership changed since the last sync
- **THEN** the new plan shows the resolved membership and desired-versus-applied actions before apply

#### Scenario: Project profile lacks workspace root
- **WHEN** a project-scoped profile is planned without an explicit workspace root
- **THEN** planning returns input-required and does not substitute the process current directory silently

### Requirement: Profile apply uses the common safety protocol
`sync apply` MUST consume the immutable plan and SHALL enforce store revision, target ownership, drift, secret readiness, transaction, and recovery requirements.

#### Scenario: Profile plan remains valid
- **WHEN** all plan preconditions hold and required references are available
- **THEN** apply distributes the exact resolved resources and returns one operation receipt

#### Scenario: Unowned target conflicts with profile output
- **WHEN** a profile plan encounters an existing unowned target
- **THEN** apply remains blocked until the caller supplies the exact replacement acknowledgement outside the profile

### Requirement: Profile verification and uninstall are explicit
The system SHALL verify a profile's desired/applied and applied/disk state and SHALL uninstall only the exact owned targets in an approved uninstall plan.

#### Scenario: Profile is fully converged
- **WHEN** resolved desired revisions match applied state, targets match receipts, and references are ready
- **THEN** profile verification reports converged with no pending recovery

#### Scenario: Profile uninstall is dry-run
- **WHEN** uninstall is requested with dry-run
- **THEN** the result lists exact target removals and blocked drift without modifying profile, store resources, or targets
