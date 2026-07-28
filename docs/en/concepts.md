# Concepts

[Documentation index](../README.md) | [简体中文](../zh-CN/concepts.md)

## Store

The store is the single local source of truth. By default it lives at
`~/.cellarer`; `CELLARER_HOME` can point to another store.

Typical layout:

```text
~/.cellarer/
├── store/
│   ├── rules/
│   ├── mcp/
│   └── skills/
├── config.json
├── state.json
└── secrets/
```

## Resource

A resource is one reusable unit in the cellarer library:

- a rule file or rule fragment
- one canonical MCP server definition
- one skill directory

## Collection

Collections group resources in the cellarer library. The default collection is
`default`. Users can create collections such as `work`, `personal`, or
`internal` and sync a collection to selected target agents.

## Agent Adapter

An adapter knows where an agent stores rules, MCP servers, and skills. The base
adapter list ships with the package. `config.json` stores keyed overrides for
built-ins and custom adapters for new agents.

## Scope

Scope decides where resources land:

- `global`: the agent's home-directory configuration
- `project`: a specific project directory passed with `--dir`

## Plan and Apply

Distribution is split into two phases:

- plan: compute actions and previews
- apply: execute the plan and write the ledger

`--dry-run` returns the plan only.

## Ledger

`state.json` records applied targets, methods, checksums, backups, and secret
references. `status` and `revert` use this ledger.

## Target Ownership and Replacement

cellarer records one current owner for each normalized physical target. The
owner identity is the agent, scope, capability, and target path; contributing
artifact ids are provenance, not separate owners. For example, changing the MCP
selection for one agent configuration updates that target's owner instead of
creating independently revertible MCP entries.

Before a write, planning classifies the target as `absent`, `owned-current`,
`owned-drifted`, `unowned-existing`, or `invalid-owner`. The last three states
are blocked by default. This prevents an unmanaged same-named Skill or a file
edited after apply from being silently replaced.

Core and local Web API callers can explicitly replace a blocked target in two
steps:

1. Run a plan and read the exact token from the conflict's `acknowledgement`.
2. Submit the same selection to apply with that token in `replaceUnowned` for
   an unowned target, or `overrideDrift` for a drifted owner, together with a
   `snapshotPassphrase`.

The token is bound to the target and its inspected receipt, and the two token
kinds are not interchangeable. Before replacement, cellarer must durably write
a permission-restricted encrypted snapshot under `snapshots/`. The passphrase,
plaintext target payload, and plaintext credentials are not written to the
store or ledger. If snapshot capture, encryption, or storage fails, apply leaves
the target and ownership state unchanged.

Revert is also plan-first. A drifted target remains blocked until the caller
submits the exact acknowledgement returned by that revert plan. A target with a
before-state snapshot is restored from it; a target created by cellarer is
removed only while its current receipt is still valid.

## Pre-release Ownership State Reset

Ledger version 1 is not silently treated as current ownership. `doctor` reports
an ownership-state error and asks for a pre-release reset. Use this recovery
procedure:

1. Stop apply and revert operations. Back up `state.json` and every target it
   describes. If practical, use the older compatible cellarer build to revert
   those targets first.
2. Move the old ledger aside rather than deleting it:

   ```bash
   STORE_ROOT="${CELLARER_HOME:-$HOME/.cellarer}"
   BACKUP_PATH="$STORE_ROOT/state.pre-v2.$(date +%Y%m%d%H%M%S).json"
   mv "$STORE_ROOT/state.json" "$BACKUP_PATH"
   node packages/cli/dist/bin.js doctor --json
   ```

3. Run `apply --dry-run` for the intended agents and capabilities. Any remaining
   physical target is now unowned and is blocked; do not delete it blindly.
   Either remove only a target you have verified and backed up, or use the exact
   replacement flow above so cellarer records an encrypted before-state.
4. Apply again only after the preview has no unexpected ownership conflicts.

Keep the old ledger backup until all targets have been verified or recovered.
Do not use ledger version 1 with the current build or ledger version 2 with an
older build.

## Secrets

Stored resources and generated files should not contain plaintext secrets.
Resources should use environment references such as `${OPENAI_API_KEY}` or
cellarer secret references such as `${CELLARER_SECRET:OPENAI_API_KEY}`.

## Non-goals

cellarer does not run an MCP proxy, host a cloud registry, manage agent
installation, or provide a multi-user service.
