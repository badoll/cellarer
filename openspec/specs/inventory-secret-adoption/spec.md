# inventory-secret-adoption Specification

## Purpose
Define exact, least-privilege adoption of supported plaintext Inventory findings into protected provider references while preserving reference-only observability and explicit partial-failure recovery.

## Requirements

### Requirement: Adoption is limited to supported MCP fields
The system SHALL offer secret adoption only for unambiguous plaintext values in supported standard MCP env, header, argument, or URL fields. Rules, Skills, malformed structures, custom MCP shapes, ambiguous findings, and unsupported fields MUST remain blocked without an adoption plan.

#### Scenario: Supported MCP field is observed
- **WHEN** Inventory detects a plaintext secret in a supported standard MCP field
- **THEN** it reports `secret-adoption-required`, a redacted field selector, and a derived reference name without the value

#### Scenario: Unsupported content contains a probable secret
- **WHEN** a Rule, Skill, or unsupported MCP structure contains secret material
- **THEN** the candidate remains blocked until its source is remediated and no adoption action is available

### Requirement: Adoption plans contain no plaintext
An adoption plan MUST bind the exact candidate, source fingerprint, closed redacted field selector, provider kind, derived reference name, absent-entry precondition, and reference-bearing Store publication. Plans, digests, journals, receipts, logs, errors, CLI output, API data, and target artifacts MUST NOT contain the source value or a reversible derivative.

#### Scenario: Adoption plan is inspected
- **WHEN** a caller serializes every plan and protocol field
- **THEN** only reference metadata and redacted source evidence are present

### Requirement: Adoption apply is exact and least-privileged
Apply MUST verify authority and unchanged source binding before provider access, MUST create only the plan-bound absent provider entry, and MUST publish only the reference-bearing Store candidate. It MUST NOT overwrite, list, return, rewrite the source, or modify an agent target.

#### Scenario: Bound reference is absent
- **WHEN** the exact source and Store remain current and the provider entry is absent
- **THEN** apply creates that entry and imports only the reference-bearing resource

#### Scenario: Bound reference already exists
- **WHEN** the derived provider entry exists before apply
- **THEN** apply refuses before reading or overwriting it and returns a non-disclosing provider-precondition conflict

#### Scenario: Source changes after planning
- **WHEN** the source fingerprint or selected field binding changes
- **THEN** apply performs no provider or Store write and requires a fresh Inventory refresh

### Requirement: Cross-provider partial failure has explicit recovery evidence
If the plan-bound provider entry is created but Store publication later fails, the operation MUST report an orphaned reference with provider metadata and an exact cleanup action and MUST NOT silently delete the credential or disclose its value.

#### Scenario: Store publication fails after provider creation
- **WHEN** the provider write succeeds and the journaled Store publication cannot complete
- **THEN** the receipt and recovery state identify the orphaned reference name and manual cleanup without plaintext
