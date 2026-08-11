## ADDED Requirements

### Requirement: Local clients share one live Inventory contract
The `/api/v1` boundary SHALL expose the browser-safe Core Inventory DTO, including exact candidate IDs, states, default selection, redacted sources, related adapters, findings, managed matches, counts, and completeness. Full and targeted Inventory reads MUST invoke the same live read-only Core operation used by CLI.

#### Scenario: Web loads Inventory
- **WHEN** the authenticated bundled client requests Inventory for user sources and a current project
- **THEN** the API returns one deduplicated redacted result from Core

#### Scenario: One source fails
- **WHEN** Core returns partial Inventory with source findings
- **THEN** the API preserves successful candidates, completeness, typed findings, and remediation without converting the result into a raw exception
