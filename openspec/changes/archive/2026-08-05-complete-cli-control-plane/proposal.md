## Why

Core and Web already expose inventory, discovery summaries, settings, activity, diff, and richer resource selection, while the CLI only covers a narrow happy path and still relies on name-only selection in places. After standardizing the machine protocol, cellarer needs a CLI-complete local control plane so both humans and developer agents can perform every ordinary management task without opening the Web console or editing store files.

## What Changes

- Add complete read surfaces for resource inventory/detail/provenance, agent detection/configuration, collections, settings, desired/applied diff, activity, and verification summary.
- Add agent enable/disable/configure/reset and custom adapter add/update/remove commands backed by Core services.
- Add collection create/update/delete and exact membership/default management commands.
- Replace name-only CLI selection with exact resource identities or explicit `(kind, name, source)` selectors shared with Core.
- Make first-run initialization report detected/configured agents and require an explicit target set in non-interactive mode.
- Expose plan/apply/revert/recovery and verification inputs/results consistently through the Agent CLI protocol.
- **BREAKING**: remove ambiguous name-only `--select` behavior and implicit “all detected agents” mutation defaults.

## Capabilities

### New Capabilities
- `cli-control-plane`: Complete machine- and human-usable CLI coverage for inventory, agents/adapters, collections, settings, selection, planning, activity, and verification.

### Modified Capabilities

None. This repository does not yet contain accepted capability specs to modify.

## Impact

This change follows `standardize-agent-cli-protocol` and affects CLI command registration/presentation plus Core application services for any currently Web-only behavior. Web and CLI must consume the same Core DTOs and transaction protocol. Resource source update/removal/export and reusable sync profiles remain in `add-resource-lifecycle-and-sync-profiles`.
