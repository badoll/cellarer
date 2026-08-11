## MODIFIED Requirements

### Requirement: The bundled Web client uses only the versioned contract
The React client MUST access server capabilities through one typed `/api/v1` client boundary, MUST import shared contract values and types only through a browser-safe Core export, and MUST NOT duplicate Core validation, plan, ownership, error, or recovery rules. The browser-safe export MUST NOT transitively include Node built-ins, filesystem effects, credential providers, mutation engines, or unrelated Core modules. Migration MUST complete before legacy route removal.

#### Scenario: Web performs a mutation journey
- **WHEN** a user previews and applies a supported operation in the bundled Web UI
- **THEN** the client sends the exact versioned request and plan receipt and renders the typed Core result without inferring success from HTTP text

#### Scenario: Production client is bundled
- **WHEN** the bundled Web client production artifact is built
- **THEN** its Core module graph contains only the explicitly browser-safe client-contract closure and no Node-only Core runtime module
