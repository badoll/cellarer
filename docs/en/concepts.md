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
├── revision.json
├── operations/
│   ├── active.json
│   └── receipts/
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

- plan: compute actions and previews and bind them to an immutable mutation plan
- apply: validate and execute that exact mutation plan, then publish the ledger

The versioned mutation plan contains a `planId`, operation, base store revision,
normalized inputs, ordered actions, target preconditions, expiry policy, and a
canonical digest. Apply checks the digest, revision, expiry, and target
preconditions while holding the store mutation lock. An invalid or stale plan,
or a target changed since planning, is rejected before target mutation.

Core callers that need a reusable authorization can call `planApplyMutation`
and later submit its exact `mutationPlan` to `applyMutationPlan`. Convenience
callers, including the CLI, plan and immediately apply through the same receipt
boundary. CLI `--dry-run` prints a preview and its mutation identity; a later
non-dry-run CLI invocation creates and executes a fresh plan, so inspect that
call's result as well.

A successful mutation returns an operation receipt containing the operation and
plan ids, plan digest, base and resulting revisions, outcome, timestamps, and
one before/after receipt per action. Completed receipts are retained under
`operations/receipts/`. CLI and Web responses expose the safe receipt fields,
not the journal's recovery payloads. The active journal stores plan and state
publication references plus digests; raw plan previews, rendered content, and
state publication data remain in memory and are not written to the journal.

Settings and adapter config, encrypted vault updates, add/scan collection tags,
and project `.gitignore` updates are signed file actions. Their plan payloads
bind the exact path, content digest, mode, and observed before-state; the
journal keeps only the durable action payload digest and receipts. Raw
publication bytes remain in memory. Ledger `state.json` publication keeps its
separate recovery semantics. A project `.gitignore` action receives its action
receipt before ledger publication and revision advancement.

Each action rechecks its signed target precondition immediately before its
executor runs. Signed file publications are then verified from the actual file
bytes and required mode before their action receipt can succeed. Drift at either
boundary leaves typed failed evidence, does not publish a committed receipt,
and does not advance the revision.

Non-publication store actions also carry a signed after-condition in the plan:
file content, directory, and node fingerprints are read back from the actual
target before success is receipted. Protocol publications (`state.json`,
configuration, vault, journal, revision, and operation receipts) additionally
bind and verify POSIX mode. Ordinary managed file receipts keep the established
content-fingerprint model and do not separately sign the file's top-level POSIX
mode; directory fingerprints retain their existing node-manifest semantics.

## Ledger

`state.json` records applied targets, methods, checksums, backups, and secret
references. Every project owner also records its canonical project root; this
is separate from physical target identity and lets cross-project revert rebuild
only each real `<project>/.gitignore`. `revision.json` advances monotonically
for state-changing operations. `status`, verification, and `revert` use this
evidence.

## Concurrency and Interrupted Operation Recovery

Only one state-changing operation may hold a store's mutation lock. A competing
operation makes no product changes and returns `LOCK_CONFLICT` with owner
evidence: operation id, process id, hostname, and acquisition time. A lock is
never deleted merely because it is old.

Before its first product write, including initialization, an operation
publishes a write-ahead journal and then records every action outcome before
atomically publishing the next state and revision. An incomplete journal
blocks later mutations with `INTERRUPTED_OPERATION`. Recover an interrupted
operation as follows:

1. Stop apply and revert calls for that store. Run
   `node packages/cli/dist/bin.js doctor --json` and record
   `mutationRecovery.operationId`, status, and guidance.
2. Do not delete `mutation.lock`, `recovery.lock`, or
   `operations/active.json` by age, and do not edit affected targets while
   recovery evidence is being evaluated.
3. An authorized caller may use the CLI recovery command or
   `POST /api/v1/recovery/apply` with the exact diagnosed operation id. Both
   delegate to Core `recoverInterruptedOperation`; neither deletes evidence or
   invents recovery state.
4. Core finalizes when all planned after-states are proven and every required
   state publication is already present with its durable digest. If a
   digest-only publication is missing or mismatched, Core does not reconstruct
   raw state by guessing and returns `MANUAL_RECOVERY_REQUIRED`. Otherwise, it
   compensates only targets with a proven restorable before-state; when that is
   not possible it returns `MANUAL_RECOVERY_REQUIRED` with exact targets and
   guidance. In the manual case it leaves unverifiable targets unchanged.
5. Run `doctor --json` again, then run `status --agent <id> --json` for every
   affected agent. Resume mutations only when recovery is `clean` and both
   verification axes converge.

Recovery-artifact retention holds the same store mutation lock and refuses to
run during mutation or recovery. Automatic receipt and snapshot deletion is
currently unsupported: the Node/`Env` filesystem surface cannot bind directory
identity to a no-follow delete, so retention reports `unsupported` and keeps
every receipt and snapshot instead of relying on a check-then-remove sequence.
Post-commit work is limited to non-throwing, best-effort activity notification.
Apply and revert do not delete encrypted snapshots by a stored path; even
`keepBackups: false` conservatively retains them and reports a warning until a
directory-identity no-follow deletion primitive is available.

## Verification Axes

Verification reports three independent signals:

- `desiredVsApplied`: current resource selection, generated content, and method
  compared with the last applied ledger state.
- `appliedVsDisk`: the last applied receipts compared with current targets.
- `recovery`: any incomplete or manually recoverable mutation.

Changing a collection can therefore diverge `desiredVsApplied` while disk is
intact; editing an applied file can diverge `appliedVsDisk` while the selection
still matches. `healthy` is true only when both axes are `converged` and
recovery is `clean`. CLI `status --agent <id> --json` includes the complete
`verification` report. Without `--agent`, `status` reports only ledger-versus-
disk items. The local Web API exposes the same full report through
`POST /api/v1/verify`.

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

Ledger version 1, and a pre-release project owner without a canonical
`projectRoot`, are not silently treated as current ownership. `doctor` reports
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
