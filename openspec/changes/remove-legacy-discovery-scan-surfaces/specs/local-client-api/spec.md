## ADDED Requirements

### Requirement: Superseded discovery and scan routes are removed
After bundled-client migration, `/api/v1` capability discovery, route registration, OpenAPI, closed schemas, and browser-safe client types MUST expose unified Inventory refresh/import and MUST NOT retain discovery-summary, scan plan/apply, scan-backed overlapping import, or compatibility route shapes.

#### Scenario: Removed route is requested
- **WHEN** a caller requests a superseded discovery-summary, scan, or scan-backed import route
- **THEN** the server returns not found without invoking Core, consuming mutation authority, or advertising an alias

#### Scenario: Contract still advertises a removed route
- **WHEN** route implementation, OpenAPI, closed schemas, or browser-safe client types differ after removal
- **THEN** contract parity fails before the change can be closed

#### Scenario: Captured legacy plan is submitted
- **WHEN** a caller submits a previously captured scan plan to a remaining Inventory route
- **THEN** the request is rejected without translation, replanning, source observation, or external effects

## MODIFIED Requirements

### Requirement: HTTP mutations preserve the Core plan and transaction protocol
Planning endpoints MUST return the exact immutable, authority-sealed plan receipt required by the corresponding apply endpoint. Mutation handlers MUST consume that receipt without independently reconstructing intent and MUST preserve store revision, target precondition, ownership, secret-safety, journal, recovery, and mutation-authority checks from Core.

#### Scenario: Previewed plan is applied
- **WHEN** a client submits the unchanged current plan receipt returned by the matching planning endpoint
- **THEN** the server invokes the Core application service once and returns its typed operation receipt

#### Scenario: Concurrent clients submit mutations
- **WHEN** two local clients submit plans against the same store revision
- **THEN** Core store locking and revision checks permit at most one current commit and the other request receives a typed busy or stale result

#### Scenario: Client alters a plan
- **WHEN** a client changes any executable plan field before applying it
- **THEN** authorization fails before canonical replanning, product-state observation, or external effects
