## Why

cellarer can currently replace an unmanaged same-named Skill directory, identify one physical MCP target as multiple ledger entries, and revert targets without checking post-apply drift. These behaviors can destroy user-managed configuration, so ownership and recovery semantics must be trustworthy before the CLI gains broader update, remove, or automation capabilities.

## What Changes

- Define one canonical ownership identity per physical target and record the concrete artifacts represented by that target separately.
- Classify existing targets as unowned, owned-current, owned-drifted, or conflicting during planning.
- Block replacement of unowned or drifted targets by default and return structured conflict evidence.
- Make revert a plan-first operation that verifies current target state before deleting or restoring anything.
- Support an explicit destructive override only when the caller acknowledges the affected targets; preserve recoverable snapshots where replacement is allowed.
- **BREAKING**: same-named unmanaged Skill targets and drifted managed targets will no longer be silently replaced or reverted.
- **BREAKING**: ledger identity will change from artifact-based identity to physical target ownership identity.

## Capabilities

### New Capabilities

- `managed-target-ownership`: Defines target ownership identity, collision classification, safe replacement, and drift-aware revert behavior for Rules, MCP, and Skills.

### Modified Capabilities

None. This repository does not yet contain accepted OpenSpec capability specs.

## Impact

- Core planning, Skill placement, MCP aggregation, ledger schema, status, and revert behavior.
- CLI and Web preview/revert request and result shapes.
- Existing development fixtures that currently expect unconditional replacement or artifact-keyed ledger entries.
- A ledger migration or pre-release reset strategy is required; no backward-compatibility layer is required for the unreleased format.
