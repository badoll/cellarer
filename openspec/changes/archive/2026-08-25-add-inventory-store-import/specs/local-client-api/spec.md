## ADDED Requirements

### Requirement: Local clients preserve exact Inventory import plan and apply
The `/api/v1` boundary SHALL expose Inventory import planning from exact candidate IDs and application of the unchanged authority-sealed receipt. Handlers MUST delegate to the corresponding Core use cases and MUST NOT independently refresh, select, normalize, reconstruct, or execute target actions.

#### Scenario: Web plans and applies selected candidates
- **WHEN** the bundled client submits exact ready IDs, receives a plan, and returns it unchanged
- **THEN** the API returns the typed atomic Store operation receipt and no target is modified

#### Scenario: Import plan is stale
- **WHEN** the Store or a selected source drifts before apply
- **THEN** the API preserves Core's typed conflict and fresh-refresh remediation without rebuilding the plan
