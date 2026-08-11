## ADDED Requirements

### Requirement: Inventory adoption machine contracts are non-disclosing
The CLI SHALL publish closed adoption plan/apply schemas containing exact candidate and reference metadata but no plaintext field. Machine adoption MUST require an unchanged explicit plan and MUST map stale source, existing reference, invalid plan, and orphan recovery to stable typed results.

#### Scenario: Structured request supplies a plaintext value
- **WHEN** an adoption request includes an undeclared value field or attempts to use argv/stdin as secret input
- **THEN** schema validation rejects it before Core or provider invocation

#### Scenario: Orphan recovery is reported
- **WHEN** provider creation succeeds but Store publication fails
- **THEN** the terminal machine result reports recovery-required reference metadata without the secret value
