## Why

`init` currently conflates Store creation with persistent agent activation: every invocation requires `--agent`, including an interactive human session, while a repeated initialization silently preserves an existing configuration even when the requested target set differs. Cellarer should keep agent activation as an explicit fail-closed preference without making first-run human setup unnecessarily opaque or presenting ignored input as effective.

## What Changes

- Preserve the persistent enabled-agent set as the default scope for discovery and presentation, not as a substitute for exact per-operation mutation targets.
- Let an interactive text-mode `init` with no target flags present the supported/detected inventory and accept an exact selection, including an explicit empty selection.
- Keep machine, structured, non-TTY, and explicitly non-interactive initialization fail-closed: callers must provide either exact `--agent` targets or an explicit no-agent choice.
- Add an explicit no-agent CLI choice that is mutually exclusive with `--agent`.
- On repeated initialization, accept an idempotent selection that matches the persisted enabled-agent set, but reject a different selection with typed guidance to use the planned `agent enable` and `agent disable` commands.
- Keep `init` limited to Store/configuration initialization; it does not distribute Rules, MCP definitions, or Skills to agent targets.
- Update English and Simplified Chinese documentation to describe activation separately from per-operation target authorization.
- **BREAKING**: repeated `init --agent ...` no longer silently ignores a selection that conflicts with an existing configuration.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `cli-control-plane`: Refine first-run target selection, explicit empty activation, interactive selection, and repeated-init conflict behavior.
- `agent-cli-protocol`: Define which initialization transports may prompt and require exact explicit input for every non-interactive path.

## Impact

- CLI initialization command, prompt/input boundary, renderer output, and protocol schemas.
- Core Store initialization validation for existing configurations and exact enabled-agent sets.
- CLI/Core tests for interactive, machine, non-TTY, empty-selection, and repeated-init behavior.
- English and Simplified Chinese CLI documentation.
- No new production dependency, no agent target write during `init`, and no change to per-operation plan/apply, ownership, recovery, or secret boundaries.
