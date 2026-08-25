## ADDED Requirements

### Requirement: CLI exposes unified read-only Inventory refresh
The CLI SHALL expose `inventory refresh` for complete and exact per-adapter live refresh using the shared Core Inventory DTO. Human and machine output MUST include candidate identity, state, default selection, provenance, related adapters, findings, managed match, counts, and completeness without importing or writing target state.

#### Scenario: Human refreshes all registered sources
- **WHEN** `inventory refresh` runs without an adapter filter
- **THEN** it renders the deduplicated complete-or-partial result across every bounded registered source

#### Scenario: Caller refreshes one adapter
- **WHEN** `inventory refresh --agent <id>` receives a registered adapter ID
- **THEN** it returns the same DTO shape narrowed to that adapter
