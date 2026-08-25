## ADDED Requirements

### Requirement: Inventory import planning requires exact eligible candidates
Store import planning MUST accept an explicit non-empty set of exact candidate IDs, resolve them through a current Inventory refresh, and reject any unknown, conflicted, blocked, stale, or duplicate selection without creating an executable plan.

#### Scenario: Caller selects ready candidates
- **WHEN** every requested candidate ID resolves to a current `ready` candidate
- **THEN** planning creates actions only for those exact identities

#### Scenario: Caller omits candidate IDs
- **WHEN** a machine or API planning request supplies no exact candidate selection
- **THEN** planning returns a typed input-required failure and does not default to all ready candidates

#### Scenario: One selected candidate is blocked
- **WHEN** a request contains a conflicted, unsafe, secret-bearing, or unknown candidate ID
- **THEN** planning rejects the complete selection and creates no executable plan

### Requirement: Inventory import plans are exact and serializable
A valid import plan MUST be authority-sealed and bind its Store identity and revision, normalized request, candidate identities, source snapshot preconditions, provenance, normalized reference-only publications, and exact action set. The plan MUST be executable after a process restart without a process-local candidate registry or closure.

#### Scenario: Plan crosses a process restart
- **WHEN** a replacement process receives an unchanged plan under the same current authority epoch
- **THEN** it can validate and apply the serializable plan without rediscovering selection or content

#### Scenario: Plan bytes are altered
- **WHEN** any selected identity, source precondition, publication, or action is changed
- **THEN** authorization fails before Store, source, provider, or target observation

### Requirement: Inventory import applies atomically without target effects
Apply MUST consume the unchanged plan, revalidate every bound source and Store precondition, and atomically publish the safe batch through the existing mutation journal. It MUST perform zero agent-target action and MUST NOT repeat refresh, selection, grouping, conflict resolution, or secret classification.

#### Scenario: Source drifts after planning
- **WHEN** a selected source fingerprint changes before apply
- **THEN** apply imports none of the changed batch and returns a typed stale-candidate result requiring a fresh refresh

#### Scenario: Safe batch applies
- **WHEN** authority, Store revision, every source precondition, and final publication remain current
- **THEN** all selected resource revisions and provenance commit in one Store operation receipt

#### Scenario: Target effect appears in an import plan
- **WHEN** an otherwise valid plan contains a Rule, MCP, or Skill action against an agent target
- **THEN** semantic validation rejects the complete plan before any product observation or effect
