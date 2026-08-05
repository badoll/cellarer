# CLI Reference

[Documentation index](../README.md) | [简体中文](../zh-CN/cli-reference.md)

Run from source after `pnpm build`:

```bash
node packages/cli/dist/bin.js <command>
```

## `init`

Initializes the store through the signed mutation journal. Product directories
and `config.json` are action-receipted, `config.json` is published atomically,
and success advances the store revision and prints the operation id and
resulting revision. A concurrent mutation or recovery claim may create only the
idempotent protocol scaffold; it creates no product layout or config.

Before Core initialization, `init` loads the Store-scoped mutation authority. If
the keychain entry does not exist, `init` creates a random 256-bit key in the OS
credential manager and verifies an exact read-back. No other command provisions
or rotates a missing authority. On headless systems, the runner must inject the
protected environment channel documented below.

```bash
node packages/cli/dist/bin.js init
```

Options:

| Option | Description |
| --- | --- |
| `--global` | Accepted for clarity; global store initialization is the current default. |

## Mutation authority and headless operation

Executable planning, mutation, and automatic recovery require a persistent,
Store-scoped authority. The normal local backend is the OS credential manager.
The key is not stored in `CELLARER_HOME`, configuration, plans, journals, logs,
or command output. Read-only commands such as `ls`, `agents`, `status`,
`doctor`, `secret ls`, and `add --list` remain available if the provider is
unavailable, but they cannot turn unsigned state into executable authority.

Authority credentials use the reserved credential-manager service
`dev.cellarer.mutation-authority.v1` and internal accounts beginning with
`__cellarer_internal__:mutation-authority:v1:`. Ordinary secret create, read,
update, and remove paths reject either namespace before calling the credential
provider, and the internal account grammar is not a valid
`${CELLARER_SECRET:name}`. Do not inspect, edit, or delete these entries with
`cellarer secret` or a general credential-management script.

Headless/CI runners have exactly one alternative channel:

```text
CELLARER_MUTATION_AUTHORITY=v1:<positive-epoch>:<43-character-unpadded-base64url-key>
```

The decoded key must be exactly 32 bytes. Configure this value in the runner's
protected environment/secret facility; do not write a literal assignment into a
script, command argument, JSON request, config file, Store file, log, stdout, or
stderr. An explicitly present malformed value fails closed and is never replaced
by keychain fallback. The same master value is cryptographically scoped to the
normalized Store root.

Before authority loading, the CLI resolves the requested Store through the
injected `realpath` boundary. Relative, symlink, and filesystem case aliases of
one physical Store therefore share the same credential account, headless owner,
Core/Web scope, seals, journals, and locks. Only `init` creates a missing Store
root before this canonicalization.

A headless mutation-capable process also acquires a kernel-owned lifetime lease
for that Store: it exclusively listens on a deterministic Store-scoped local
port bound only to `127.0.0.1`, never connects to an incumbent, and unreferences
the listener so it does not keep the command alive. A second process, including
one configured with a newer epoch, fails closed while the lease is live. The
kernel releases the lease when its process exits, after which the next process
must acquire it before planning. Deleting, replacing, or replaying any Store
file cannot change this currentness. An unrelated local listener or deterministic
port collision also fails closed. Do not run multiple headless mutation-capable
processes against one Store.

If authority loading fails, restore access to the existing credential manager or
the exact protected headless value before retrying. Do not delete an active
journal and do not provision a replacement authority as a recovery shortcut.
Unsigned records, records from another Store root, and records from an unknown or
old epoch are a breaking change: they require explicit manual handling and are
never accepted through legacy compatibility.

First provisioning and rotation are serialized by a Store-scoped authority
coordination boundary. Rotation also excludes mutation and recovery and refuses
to run while any active journal exists. An executable operation checks the
authority epoch before canonical replanning, while holding its authority lease,
and again under the Store mutation lock. A long-running CLI or Web process with
a stale epoch therefore cannot observe product state or perform an external
effect after rotation wins the serial order.

Each persistent journal publication also stores a protected replay tip containing
only `{ operationId, sequence, seal }` in the credential manager. Automatic
recovery requires the active journal to match that tip exactly; a missing,
unreadable, stale, or mismatched tip makes recovery manual-only before claims,
credential providers, product-state observation, or compensation. A headless
authority keeps this tip only in the process that observed the publication.
After that process exits or restarts, an active journal is manual-only even when
the same `CELLARER_MUTATION_AUTHORITY` value is restored.

## `add <source>`

Imports local rules/MCP files or local/GitHub skill sources into the store.

```bash
node packages/cli/dist/bin.js add ./my-rules.md
node packages/cli/dist/bin.js add ./server.json --force
node packages/cli/dist/bin.js add ./my-skill/
node packages/cli/dist/bin.js add vercel-labs/skills --list
node packages/cli/dist/bin.js add vercel-labs/skills --skill nextjs --collection public
node packages/cli/dist/bin.js add https://github.com/vercel-labs/skills/tree/main/skills/web-design-guidelines --json
```

Regular single-file Rule and MCP imports use a portable no-follow identity
handshake and remain available on Windows. Recursive Skill snapshots use a
separate dependency-free Node boundary with no-follow opens and stable
file/directory identity checks. Recursive traversal is supported on Darwin and
Linux x64/arm64; other platform/architecture pairs fail before reading or
copying directory content and do not fall back to a path-based recursive copy.

Options:

| Option | Description |
| --- | --- |
| `--force` | Overwrite an existing resource with the same name. |
| `--list` | List skill candidates without writing to the store. |
| `--skill <name>` | Import a named skill. May be repeated. |
| `--all` | Import all eligible skills from a multi-skill source. |
| `--collection <name>` | Tag imported resources with a collection. `internal` also includes internal skills. |
| `--yes` | Skip confirmations. `add` is currently non-interactive. |
| `--json` | Print a JSON candidate list or import report. |

Supported sources:

| Source | Resource kind |
| --- | --- |
| `.md` file | rules |
| `.json` file | MCP server |
| local skill directory or parent directory | skills |
| GitHub `owner/repo` | skills |
| GitHub repository URL | skills |
| GitHub `/tree/<ref>/<subpath>` URL | skills under that subpath |

Skill imports require `SKILL.md` frontmatter with `name` and `description`.
Candidates with `metadata.internal: true` are hidden from normal `--list` and
skipped by `--all` unless `--collection internal` is provided. GitLab and arbitrary
git URLs are not part of the M2 import surface.

## `ls`

Lists stored resources and collection tags.

```bash
node packages/cli/dist/bin.js ls
node packages/cli/dist/bin.js ls --collection default
```

Options:

| Option | Description |
| --- | --- |
| `--collection <collection>` | Show resources visible for a collection. |

## `agents`

Shows registered agent adapters, detect results, capabilities for the current
scope, and target paths.

```bash
node packages/cli/dist/bin.js agents
node packages/cli/dist/bin.js agents -a codex,claude-code --dir /path/to/project --json
```

Options:

| Option | Description |
| --- | --- |
| `-a, --agent <ids>` | Show only these comma-separated agent ids. |
| `--dir <path>` | Project scope root. Omit for global scope. |
| `--json` | Print machine-readable output. |

## `doctor`

Checks store initialization, `config.json`, store directories, adapter loading,
agent detection, target path write access, and mutation recovery evidence
without writing files.

```bash
node packages/cli/dist/bin.js doctor
node packages/cli/dist/bin.js doctor -a codex --json
```

Options:

| Option | Description |
| --- | --- |
| `-a, --agent <ids>` | Check only these comma-separated agent ids. |
| `--dir <path>` | Project scope root. Omit for global scope. |
| `--json` | Print machine-readable output. |

The JSON report includes `mutationRecovery`. `clean` means there is no
incomplete operation; `incomplete` and `manual-recovery-required` include a
typed error and operation evidence. `doctor` diagnoses but does not repair an
operation. Do not delete an old lock manually; follow the evidence-based
procedure in [Concepts](concepts.md#concurrency-and-interrupted-operation-recovery).

## `apply`

Plans or writes resources to selected agents.

```bash
node packages/cli/dist/bin.js apply --dry-run --agent claude-code,codex
node packages/cli/dist/bin.js apply --agent claude-code,codex --collection default
node packages/cli/dist/bin.js apply --dry-run --agent claude-code --json
```

Options:

| Option | Description |
| --- | --- |
| `-a, --agent <ids>` | Required. Comma-separated agent ids. |
| `--dir <path>` | Project scope root. Omit for global scope. |
| `--collection <collection>` | Filter resources by collection. |
| `--rules` | Include rules. If no capability flag is set, all capabilities are included. |
| `--mcp` | Include MCP servers. |
| `--skills` | Include skills. |
| `--copy` | Prefer copy instead of symlink for skills. |
| `--mcp-overwrite` | Use overwrite instead of merge for MCP server groups. |
| `--secret-mode <mode>` | `env`, `vault`, or `keychain`. |
| `--vault-passphrase-fd <number>` | Read the vault passphrase from inherited descriptor 3 or greater; otherwise use hidden terminal input. |
| `--replace-unowned <tokens>` | Comma-separated exact replacement tokens from `plan.conflicts`. |
| `--override-drift <tokens>` | Comma-separated exact drift-override tokens from `plan.conflicts`. |
| `--snapshot-passphrase-fd <number>` | Read the replacement snapshot passphrase from an inherited descriptor; otherwise use hidden terminal input. |
| `--dry-run` | Print the plan without writing. |
| `--json` | Print the Core apply plan/result, mutation identity or receipt, conflicts, and acknowledgement tokens. |

An unacknowledged ownership conflict blocks apply and exits nonzero. Inspect the JSON dry-run,
then repeat the same selection with the exact conflict token in `--replace-unowned` or
`--override-drift` and provide the snapshot passphrase through hidden input or
`--snapshot-passphrase-fd`.

Every response includes `mutation.planId`, `planDigest`, `operation`, and
`baseRevision`. A successful non-dry-run also includes
`mutation.result.receipt`, with its operation id, resulting revision, outcome,
and per-action receipts. The CLI plans and applies within one invocation; a
later non-dry-run invocation does not resubmit the serialized dry-run plan.
Typed protocol conflicts such as `LOCK_CONFLICT`, `STALE_REVISION`,
`TARGET_PRECONDITION_CONFLICT`, and `INTERRUPTED_OPERATION` exit nonzero without
performing an unauthorized target write.

## `scan`

Reads native agent configuration and imports normalized resources into the
store.

```bash
node packages/cli/dist/bin.js scan --agent codex --dry-run
node packages/cli/dist/bin.js scan --agent codex --into-collection default
```

Options:

| Option | Description |
| --- | --- |
| `-a, --agent <id>` | Required. Exactly one agent id. |
| `--dir <path>` | Project scope root. Omit for global scope. |
| `--rules` | Scan only rules. |
| `--mcp` | Scan only MCP servers. |
| `--skills` | Scan only skills. |
| `--into-collection <collection>` | Tag imported resources with this collection. |
| `--conflict <strategy>` | `keep-theirs`, `keep-mine`, or `copy`. |
| `--select <names>` | Comma-separated resource names to import. |
| `--secret-mode <mode>` | Secret source for a mutating import: `env`, `vault`, or `keychain`. Ignored by read-only dry-run, which always uses `env`. |
| `--vault-passphrase-fd <number>` | Read the vault passphrase from an inherited descriptor for a mutating vault-backed import. |
| `--keychain-service <name>` | Keychain service for a mutating keychain-backed import; default `cellarer`. |
| `--dry-run` | Show candidates without writing. |
| `--json` | Print JSON output. |

`scan --dry-run` is a pure read-only preview that cannot be submitted to an
execution API. It does not provision, load, or query mutation authority or
secret credentials and always scans in environment-reference mode, even if a
vault or keychain mode was requested. A non-dry-run import remains an executable
mutation and requires authority.

## `status`

Checks applied state. With `--agent`, it verifies desired-versus-applied and
applied-versus-disk separately and includes mutation recovery health.

```bash
node packages/cli/dist/bin.js status
node packages/cli/dist/bin.js status --agent codex --json
```

Options:

| Option | Description |
| --- | --- |
| `-a, --agent <ids>` | Filter by comma-separated agent ids. |
| `--dir <path>` | Filter by project root. |
| `--json` | Print machine-readable output. |

`status --agent <ids> --json` returns `verification.desiredVsApplied`,
`verification.appliedVsDisk`, `verification.recovery`, and
`verification.healthy`. Without `--agent`, the command returns ledger-versus-
disk `items` only and does not claim full verification health.

## `revert`

Rolls back ledger entries.

```bash
node packages/cli/dist/bin.js revert --agent codex --dry-run --json
node packages/cli/dist/bin.js revert --agent codex --acknowledge "$ACK_TOKEN" --snapshot-passphrase-fd 3 3< "$CELLARER_SNAPSHOT_PASSPHRASE_FILE"
```

Always inspect the dry-run plan first. If a target drifted after apply, copy its
exact acknowledgement token into `ACK_TOKEN`. A target with an encrypted
before-state snapshot also requires the original snapshot passphrase.

Options:

| Option | Description |
| --- | --- |
| `-a, --agent <ids>` | Filter by comma-separated agent ids. |
| `--dir <path>` | Filter by project root. |
| `--all` | Required when reverting all entries without another selector. |
| `--keep-backups` | Request backup retention. Encrypted snapshots are currently retained regardless because automatic path-based deletion is unsupported. |
| `--acknowledge <tokens>` | Comma-separated exact drift tokens returned by the dry-run plan. |
| `--snapshot-passphrase-fd <number>` | Read the snapshot passphrase from an inherited descriptor; otherwise use hidden terminal input when acknowledgement needs it. |
| `--dry-run` | Preview rollback actions. |
| `--json` | Print the Core revert plan/result and mutation identity or receipt. |

Revert uses the same store lock, immutable plan validation, journal, revision,
and operation receipt boundary as apply. A dry-run has no mutation result; a
successful write returns `mutation.result.receipt`.

## `secret`

Manages the encrypted vault. Values are never printed by `ls`.

```bash
# Human: hidden prompts for the secret value and vault passphrase.
node packages/cli/dist/bin.js secret add OPENAI_API_KEY

# Agent: protected secret input plus a separate inherited vault-passphrase descriptor.
node packages/cli/dist/bin.js secret add OPENAI_API_KEY --stdin --passphrase-fd 3 3< "$CELLARER_VAULT_PASSPHRASE_FILE" < "$CELLARER_SECRET_INPUT_FILE"
node packages/cli/dist/bin.js secret add OPENAI_API_KEY --fd 4 --passphrase-fd 3 3< "$CELLARER_VAULT_PASSPHRASE_FILE" 4< "$CELLARER_SECRET_INPUT_FILE"

node packages/cli/dist/bin.js secret ls
node packages/cli/dist/bin.js secret rm OPENAI_API_KEY
```

`secret add` accepts only the name as a positional argument. Without `--stdin`
or `--fd`, it requires an interactive terminal and reads the value with echo
disabled. The two non-interactive channels are mutually exclusive; `--fd`
requires an inherited descriptor numbered 3 or greater. Vault and snapshot
passphrases likewise use hidden input or their explicit `--*-passphrase-fd`
options. Secret values and passphrases are never accepted as option values.

Use `--provider keychain` to select the injected system keychain; vault is the
default provider. `ls` currently lists vault names and therefore requires the
vault passphrase.

## `authority rotate`

Explicitly rotates the current Store's OS-keychain mutation authority:

```bash
node packages/cli/dist/bin.js authority rotate
```

Rotation is refused while `operations/active.json` exists, including when that
journal is malformed or cannot be automatically recovered. A successful
rotation preserves the authority id, advances its epoch, generates a new random
256-bit key, and verifies the credential by reading it back. Plans and journals
sealed by the prior epoch immediately become invalid and are manual-only.

Provisioning and rotation share the Store authority-coordination lock. Rotation
also holds mutation/recovery exclusion while checking the active journal and
replacing the credential, so rotation and an executable mutation or recovery
take one serial order. Do not bypass this lifecycle by editing the reserved
credential entries directly.

When `CELLARER_MUTATION_AUTHORITY` is active, the command refuses to mutate the
runner's environment. Rotate headless authority by replacing the protected
runner secret with a higher positive epoch only after confirming there is no
active journal. Moving or cloning a Store changes its normalized scope; run
`init` at the new root to provision a separate local authority rather than
copying plans or journals.

## `ui`

Starts the local Web console.

```bash
node packages/cli/dist/bin.js ui
node packages/cli/dist/bin.js ui --port 4317 --token local-token
```

Options:

| Option | Description |
| --- | --- |
| `--port <port>` | Port, default `4317`. |
| `--token <token>` | Require `Authorization: Bearer <token>` for API requests. |

`ui` preloads any available authority before starting the server and injects
only the narrow in-memory `MutationAuthority` capability needed for sealing,
current-epoch leases, and protected journal tips. Web receives no general
`SecretStore`, raw key, credential-provider handle, or authority provisioning or
rotation operation. The capability's protected backend can check only its own
epoch and replay tip; routes cannot perform arbitrary credential operations.
Web scan/import composition always uses environment-reference mode and makes
zero vault or keychain secret calls. Authorityless scan planning remains
available, while executable import and other mutation routes fail closed.
