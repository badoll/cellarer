## ADDED Requirements

### Requirement: Committed Custom Agent changes trigger targeted Inventory refresh
After a Custom Agent add or update commits, the system SHALL perform one read-only Inventory refresh for the exact committed adapter and SHALL return the mutation receipt and refresh outcome as separate fields of one typed result.

#### Scenario: Custom Agent add exposes resources
- **WHEN** a Custom Agent add commits and its declared sources are readable
- **THEN** the result contains the committed receipt and a complete targeted Inventory observation for that adapter

#### Scenario: Custom Agent update changes source paths
- **WHEN** a Custom Agent update commits with different declared source paths
- **THEN** the targeted refresh observes the post-commit adapter definition rather than the prior definition or a client-supplied adapter ID

### Requirement: Post-commit refresh failure never rewrites mutation truth
An expected partial or failed targeted refresh MUST preserve the committed mutation as successful, MUST return a typed redacted refresh outcome, and MUST include the exact retry command `cellarer inventory refresh --agent <id>` without rolling back or retrying automatically.

#### Scenario: One declared source is unreadable
- **WHEN** the committed adapter refresh returns safe candidates plus a source-local finding
- **THEN** the result preserves the candidates, finding, completeness, mutation receipt, and exact retry command

#### Scenario: Targeted refresh fails
- **WHEN** the adapter mutation commits but targeted Inventory refresh cannot produce a result
- **THEN** the mutation remains successful and the refresh outcome reports typed failure plus exact retry guidance

### Requirement: Post-commit refresh has read-only reference-only authority
The post-commit refresh MUST NOT import candidates, write agent targets, resolve provider values, request a new mutation authorization, or expose secret values in results, warnings, logs, or retry guidance.

#### Scenario: New adapter sources contain secret references
- **WHEN** targeted refresh observes a candidate containing a supported secret reference
- **THEN** the combined result contains only redacted/reference metadata and performs no protected-provider interaction

#### Scenario: Mutation commits without later mutation authority
- **WHEN** the mutation authority used for the committed plan is no longer available during refresh
- **THEN** the read-only targeted observation can still complete without requesting replacement authority

### Requirement: Non-target mutations do not trigger this refresh
Built-in adapter mutations, Custom Agent removal, and unrelated configuration mutations MUST retain their existing results without invoking post-commit Inventory refresh from this capability.

#### Scenario: Custom Agent is removed
- **WHEN** an authorized Custom Agent removal commits
- **THEN** the result contains the existing removal receipt and no post-commit Inventory refresh outcome

### Requirement: Clients preserve one Core post-commit result
CLI and local API clients MUST project the Core mutation-plus-refresh result without independently refreshing, retrying, rolling back, replacing typed outcomes, or reconstructing the retry command.

#### Scenario: Machine client receives refresh failure
- **WHEN** a committed Custom Agent update is followed by a failed refresh
- **THEN** CLI JSON and `/api/v1` return schema-valid equivalent mutation and refresh fields with no raw exception or secret value
