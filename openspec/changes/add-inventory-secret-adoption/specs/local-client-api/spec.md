## ADDED Requirements

### Requirement: Web secret adoption uses only a narrow exact capability
The local Web composition MUST NOT receive a general `SecretStore`, plaintext resolver, or provider get/list/delete interface. It SHALL expose only exact Inventory adoption plan/apply operations, and ordinary Inventory refresh/import handlers MUST perform zero provider access.

#### Scenario: Web refreshes a secret-bearing candidate
- **WHEN** the bundled client refreshes Inventory with a protected provider configured
- **THEN** the API returns only the redacted finding and performs no provider interaction

#### Scenario: Web applies exact adoption
- **WHEN** an authenticated same-origin client submits an unchanged authorized adoption plan
- **THEN** the narrow service may create only the plan-bound absent reference and returns no secret value to the handler or client

#### Scenario: Web requests arbitrary provider access
- **WHEN** a request names an unbound reference or provider operation
- **THEN** no such capability is registered and the request is rejected before provider interaction
