## ADDED Requirements

### Requirement: Inventory adoption preserves reference-only observability
Inventory secret adoption MUST NOT accept plaintext through argv, structured input, HTTP, or plan bytes and MUST NOT expose, log, hash for observability, persist in Store content, or return the adopted value. Only the protected apply capability MAY read the exact plan-bound local source value after authorization and precondition checks.

#### Scenario: Observable canary crosses adoption
- **WHEN** a known secret canary is adopted and every plan, journal, receipt, error, log, CLI record, and API response is serialized
- **THEN** the canary and reversible derivatives are absent while reference metadata remains usable
