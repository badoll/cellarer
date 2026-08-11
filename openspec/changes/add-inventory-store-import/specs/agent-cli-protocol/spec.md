## ADDED Requirements

### Requirement: Inventory import machine contracts are exact and fail closed
The command catalog SHALL publish closed schemas for Inventory import plan/apply, including exact candidate selections, refresh scope, serializable plan receipts, typed drift and authority failures, and operation receipts. Non-interactive planning MUST NOT infer a candidate selection or prompt.

#### Scenario: Structured planning omits candidates
- **WHEN** a structured import planning request omits exact candidate IDs
- **THEN** the CLI returns `INPUT_REQUIRED`, emits one schema-valid terminal result, and performs no mutation

#### Scenario: Structured apply alters a plan
- **WHEN** an apply request changes any executable plan field
- **THEN** the CLI returns the stable invalid-plan error class without Core replanning
