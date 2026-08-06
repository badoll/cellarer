# CLI Reference

[Documentation index](../README.md) | [简体中文](../zh-CN/cli-reference.md)

Run from source after `pnpm build`:

```bash
node packages/cli/dist/bin.js <command>
```

## Machine protocol

Every registered command uses CLI protocol `1.0` and accepts the same global
transport options:

| Option | Description |
| --- | --- |
| `--output text\|json\|jsonl` | Select human text, one terminal JSON envelope, or newline-delimited protocol records. Default: `text`. |
| `--non-interactive` | Forbid prompts and fail with `INPUT_REQUIRED` when mandatory input or acknowledgement is missing. |
| `--input <path\|->` | Read a versioned command request from a file or stdin (`-`) and validate it before invoking Core. |

Place global options before the command in scripts. `--output json` and
`--output jsonl` imply non-interactive execution. So do `--input -` and a
non-TTY invocation. Older command-local `--json` flags remain aliases for
`--output json`; an explicit `--output` takes precedence. New automation should
use `--output` because it works for every registered command.

### Structured input

The command remains in argv for auditable routing. The request repeats that
identity and supplies command-domain fields under `input`:

```json
{
  "protocolVersion": "1.0",
  "command": "status",
  "requestId": "ci:status:42",
  "input": {
    "agents": ["codex"],
    "dir": "/workspace/project"
  }
}
```

```bash
node packages/cli/dist/bin.js --output json --input request.json status
node packages/cli/dist/bin.js --output json --input - status < request.json
```

The request must validate against the command's advertised input schema. A
domain field cannot appear in both argv and `input`; duplication returns
`INPUT_AMBIGUITY` before Core is invoked. Transport flags such as `--output`
stay in argv. Secret values and passphrases do not belong in request JSON: use
`--stdin`, an inherited `--fd`, or the command's protected passphrase/token FD.

### JSON results and JSONL completion

JSON mode writes exactly one compact terminal envelope to stdout:

```json
{
  "protocolVersion": "1.0",
  "command": "status",
  "requestId": "req-...",
  "status": "success",
  "data": { "items": [] },
  "warnings": []
}
```

A handled failure uses the same envelope with `status: "error"` and a typed
`error` object. Its optional `data` remains command-specific. In `json` and
`jsonl` modes, stdout contains protocol records only: no prompts, colors,
spinners, banners, or diagnostics. Redacted diagnostics use stderr.

Commands advertised with `streaming: true` (`apply`, `scan`, and `revert`) may
write JSONL event envelopes before the result. Each non-empty stdout line is one
complete JSON object; event `sequence` starts at 1, and the final line is exactly
one terminal result envelope. A stream that ends without that terminal record
is transport-interrupted and must not be treated as success. Non-streaming
commands emit only the terminal line when `--output jsonl` is selected.

### Exit classes and stable errors

Branch on the stable `error.code`; the localized `message` is for people. Exit
codes classify failures coarsely:

| Exit | Meaning | Error codes |
| ---: | --- | --- |
| `0` | Success | — |
| `2` | Usage, input schema, ambiguity, or missing input | `INVALID_USAGE`, `INVALID_INPUT`, `INPUT_REQUIRED`, `INPUT_AMBIGUITY` |
| `3` | Policy or domain validation | `POLICY_VIOLATION`, `DOMAIN_VALIDATION_FAILED` |
| `4` | Concurrency or precondition conflict | `STALE_REVISION`, `LOCK_CONFLICT`, `TARGET_CONFLICT` |
| `5` | Execution or partial failure | `EXECUTION_FAILED`, `PARTIAL_FAILURE` |
| `6` | Manual recovery required | `RECOVERY_REQUIRED` |
| `70` | Unexpected internal failure; details are redacted | `INTERNAL_ERROR` |

### Capability and schema discovery

Discovery is local and requires no network access:

```bash
node packages/cli/dist/bin.js --output json capabilities
node packages/cli/dist/bin.js --output json schema
node packages/cli/dist/bin.js --output json schema \
  urn:cellarer:cli:protocol:1.0:command:status:output
```

`capabilities` returns supported protocol versions and every command's
mutability, streaming support, input/output schema IDs, optional event schema
ID, and required features. `schema [schema-id]` returns the selected JSON Schema
inside the terminal envelope's `data`; without an ID it returns a deterministic
local bundle. Retrieve schema IDs from `capabilities` instead of constructing
them. `--version` is derived from the installed CLI package metadata.

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

`init` previews supported/detected/configured agents, but never turns every
detected agent into a mutation target. The current source CLI requires the
exact initial target set explicitly in both human and machine invocations:

```bash
node packages/cli/dist/bin.js init --agent codex,claude-code
```

Options:

| Option | Description |
| --- | --- |
| `--global` | Accepted for clarity; global store initialization is the current default. |
| `-a, --agent <ids>` | Required exact comma-separated adapter IDs. Only these agents are enabled in the initial config. |

Omitting `--agent` returns `INPUT_REQUIRED` with the agent inventory and creates
no product config. An unknown ID returns `INVALID_INPUT`; there is no implicit
"all detected agents" mutation default.

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
node packages/cli/dist/bin.js --output json add https://github.com/vercel-labs/skills/tree/main/skills/web-design-guidelines
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
| `--json` | Compatibility alias for `--output json`; command data contains the candidate list or import report. |

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
node packages/cli/dist/bin.js --output json agents -a codex,claude-code --dir /path/to/project
```

Options:

| Option | Description |
| --- | --- |
| `-a, --agent <ids>` | Show only these comma-separated agent ids. |
| `--dir <path>` | Project scope root. Omit for global scope. |
| `--json` | Compatibility alias for `--output json`. |

`agents` is the earlier inspection command. The complete control-plane surface
uses the singular `agent` group below.

## Resource, agent, collection, and config control plane

These commands call the same Core DTOs and services as the overlapping Web
routes. Read commands never require mutation authority. A control-plane
`--dry-run` returns `{ plan, changedFields }` and writes nothing. Executing the
same mutation directly returns `{ plan, changedFields, receipt }`; submitting
its sealed plan through `apply --plan` returns
`{ plan, changedFields, mutation, receipt }` on success.

Every `agent`, custom-adapter, `collection`, and `config` mutation supports an
exact dry-run-to-apply round trip. Extract the complete `data.plan` object from
the JSON envelope and submit those unchanged bytes to `apply --plan`:

```bash
PLAN_JSON=$(node packages/cli/dist/bin.js --output json \
  agent disable codex --dry-run | \
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s).data.plan)))')
node packages/cli/dist/bin.js --output jsonl apply --plan "$PLAN_JSON"
```

The same pattern applies to `agent add|update|remove`, collection membership
and defaults, and `config update|reset`. `apply` consumes the exact
authority-sealed plan: it does not replan. A changed revision, target,
configuration, ownership ledger, or artifact membership returns a typed
conflict with no receipt. Publication data in a settings plan contains only
reference-safe configuration bytes and is checked again by the final secret
guard before writing.

### `resource list|show`

```bash
node packages/cli/dist/bin.js resource list --kind rules --state managed \
  --source /absolute/path/to/rules.md --no-include-discovered
node packages/cli/dist/bin.js resource show rules/team-rules
```

`resource list` accepts `--kind <rules|mcp|skills>`, comma-separated
`--state`, exact comma-separated `--source`, `--agent`, `--collection`,
`--destination <user|project>`, `--dir`, and `--no-include-discovered`.
`resource show` accepts the same query options and requires one immutable
resource ID such as `rules/team-rules`; a name alone is only a read filter and
is never a mutation identity.

### `agent list|show|enable|disable|configure|reset|add|update|remove`

```bash
node packages/cli/dist/bin.js agent list --scope project --dir /workspace/app \
  --agent codex,claude-code
node packages/cli/dist/bin.js agent show codex --scope global
node packages/cli/dist/bin.js agent disable codex --dry-run
node packages/cli/dist/bin.js agent configure codex \
  --adapter '{"displayName":"Codex Local"}'
node packages/cli/dist/bin.js agent add my-agent \
  --adapter '{"displayName":"My Agent","rules":{"project":"{dir}/.my-agent/RULES.md"}}'
node packages/cli/dist/bin.js agent update my-agent \
  --adapter '{"displayName":"My Agent","rules":{"global":"~/.my-agent/RULES.md"}}'
node packages/cli/dist/bin.js agent remove my-agent
```

`list` and `show` report supported, detected, configured, and enabled states,
detection evidence, capability scopes, target paths, and validation issues.
`configure` and `reset` are for packaged built-ins and persist only
`adapterOverrides`. `add`, `update`, and `remove` manage `customAdapters`.
Removal is blocked while owned targets or an enabled desired selection still
depend on the custom adapter. Every mutation accepts `--dry-run`.

### `collection list|show|create|update|delete|members set|defaults set`

```bash
node packages/cli/dist/bin.js collection create work \
  --description "Work resources" --resource rules/team-rules,skills/review
node packages/cli/dist/bin.js collection members set work \
  --resource rules/team-rules
node packages/cli/dist/bin.js collection defaults set --collection default,work
node packages/cli/dist/bin.js collection show work
```

Collection membership accepts immutable IDs only. Use `--resource ""` with
`members set` to clear membership. `update` requires `--description`; `delete`
is blocked while the collection appears in `defaults.collections`. Mutations
accept `--dry-run`.

### `config show|validate|update|reset`

```bash
node packages/cli/dist/bin.js config show
node packages/cli/dist/bin.js config validate \
  --config '{"version":1,"defaults":{"method":"copy"}}'
node packages/cli/dist/bin.js config update \
  --settings '{"method":"copy","secretMode":"env"}'
node packages/cli/dist/bin.js config reset --field method,secretMode
```

`config update` accepts only typed non-secret defaults: `method`, `secretMode`,
and per-OS `method` under `os`. `config reset` accepts `method`, `secretMode`,
and `os`; omitting `--field` resets all three. Unknown or secret-shaped fields
return `INVALID_INPUT` without a write.

### `diff`, `verify`, `discovery summary`, and `operation list|show|recover`

```bash
node packages/cli/dist/bin.js diff --scope project --dir /workspace/app \
  --agent codex,claude-code --collection work --rules --method copy
node packages/cli/dist/bin.js verify --scope project --dir /workspace/app \
  --agent codex,claude-code --collection work --rules --method copy
node packages/cli/dist/bin.js discovery summary --destination project \
  --dir /workspace/app --agent codex,claude-code
node packages/cli/dist/bin.js operation list --limit 20
node packages/cli/dist/bin.js operation show operation-<id>
node packages/cli/dist/bin.js --output json operation recover operation-<id> --dry-run
node packages/cli/dist/bin.js --output json operation recover operation-<id>
```

`diff` reports desired-versus-applied actions; `verify` additionally separates
disk drift, secret-reference readiness, and recovery health. Verification
supports `--scope`, `--dir`, `--agent`, `--collection`, `--rules`, `--mcp`,
`--skills`, `--method <symlink|copy>`, and
`--mcp-strategy <merge|overwrite>`. Operation output is redacted.
Always diagnose with `operation recover <id> --dry-run` first. Run the same
command without `--dry-run` only when the diagnosis permits evidence-based
recovery. A `RECOVERY_REQUIRED` result includes typed recovery evidence; do not
delete locks or journals manually.

## `doctor`

Checks store initialization, `config.json`, store directories, adapter loading,
agent detection, target path write access, and mutation recovery evidence
without writing files.

```bash
node packages/cli/dist/bin.js doctor
node packages/cli/dist/bin.js --output json doctor -a codex
```

Options:

| Option | Description |
| --- | --- |
| `-a, --agent <ids>` | Check only these comma-separated agent ids. |
| `--dir <path>` | Project scope root. Omit for global scope. |
| `--json` | Compatibility alias for `--output json`. |

The JSON report includes `mutationRecovery`. `clean` means there is no
incomplete operation; `incomplete` and `manual-recovery-required` include a
typed error and operation evidence. `doctor` diagnoses but does not repair an
operation. Do not delete an old lock manually; follow the evidence-based
procedure in [Concepts](concepts.md#concurrency-and-interrupted-operation-recovery).

## `apply`

Plans or writes resources to selected agents.

```bash
node packages/cli/dist/bin.js --output json plan \
  --agent claude-code,codex --scope global --rules --mcp --skills
node packages/cli/dist/bin.js apply --agent claude-code,codex --collection default
node packages/cli/dist/bin.js --output json apply --dry-run --agent claude-code --rules
node packages/cli/dist/bin.js --output jsonl apply --plan "$PLAN_JSON"
```

Options:

| Option | Description |
| --- | --- |
| `-a, --agent <ids>` | Required only when `apply` plans from these options, including `--dry-run`; omitted for `apply --plan` because the sealed plan already binds its targets. |
| `--plan <json>` | Apply an exact authority-sealed `data.plan` returned by `plan` or a control-plane mutation dry-run. Cannot be combined with planning inputs or `--dry-run`. |
| `--dir <path>` | Project scope root. Omit for global scope. |
| `--collection <collection>` | Filter resources by collection. |
| `--rules` | Include rules. Interactive text and dry-run may default to all capabilities; a non-interactive write requires at least one explicit capability flag. |
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
| `--json` | Compatibility alias for `--output json`; command data contains the Core plan/result, mutation identity or receipt, conflicts, and acknowledgement tokens. |

An unacknowledged ownership conflict blocks apply and exits nonzero. Inspect the JSON dry-run,
then repeat the same selection with the exact conflict token in `--replace-unowned` or
`--override-drift` and provide the snapshot passphrase through hidden input or
`--snapshot-passphrase-fd`.

The top-level `plan` command is the serializable planning surface for resource
distribution; its JSON envelope contains the exact executable plan at
`data.plan` and the human-readable distribution preview at `data.preview`.
`apply --dry-run` remains a convenience preview and returns
`{ plan: <distribution-preview>, entries: [], failures: [], mutation }`; its
`mutation` has no result or receipt. Executed distribution apply has the same
top-level fields, with the operation receipt at `mutation.result.receipt`.
`apply --plan` accepts either
that distribution plan or an `operation: "settings"` plan returned by any
agent/adapter/collection/config `--dry-run`. In structured input, place the same
plan object at `input.plan`; do not also provide agents, capabilities, `dir`,
acknowledgements, or `dryRun`.

Distribution apply and settings `apply --plan` responses include
`mutation.planId`, `planDigest`, `operation`, and `baseRevision`. Successful
receipts contain the operation id, resulting revision, outcome, and per-action
receipts; direct control-plane mutation responses instead expose that receipt
at top-level `data.receipt`.
The public envelope maps Core conflicts to stable CLI errors such as
`LOCK_CONFLICT`, `STALE_REVISION`, `TARGET_CONFLICT`, and `RECOVERY_REQUIRED`;
the original Core code remains in redacted error details. These failures exit
nonzero without performing an unauthorized target write.

## `scan`

Reads native agent configuration and imports normalized resources into the
store.

```bash
node packages/cli/dist/bin.js scan --agent codex --dry-run
node packages/cli/dist/bin.js scan --agent codex --rules --into-collection default \
  --select '[{"kind":"rules","name":"team","source":"/absolute/path/AGENTS.md"}]'
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
| `--select <json>` | JSON array of complete `{kind,name,source}` selectors. Every object must contain exactly those three fields. |
| `--secret-mode <mode>` | Secret source for a mutating import: `env`, `vault`, or `keychain`. Ignored by read-only dry-run, which always uses `env`. |
| `--vault-passphrase-fd <number>` | Read the vault passphrase from an inherited descriptor for a mutating vault-backed import. |
| `--keychain-service <name>` | Keychain service for a mutating keychain-backed import; default `cellarer`. |
| `--dry-run` | Show candidates without writing. |
| `--json` | Compatibility alias for `--output json`. |

`scan --dry-run` is a pure read-only preview that cannot be submitted to an
execution API. It does not provision, load, or query mutation authority or
secret credentials and always scans in environment-reference mode, even if a
vault or keychain mode was requested. A non-dry-run import remains an executable
mutation and requires authority. A non-interactive write also requires one
explicit agent and at least one capability flag; dry-run requires the agent but
may inspect all capabilities when no capability flag is present.

Name-only mutation selection is not supported. Copy the exact `kind`, `name`,
and `source` values from the dry-run item into `--select`, or provide the same
array as structured input. Store-side collection commands use immutable IDs
such as `rules/team`, not the scan tuple.

## `status`

Checks applied state. With `--agent`, it verifies desired-versus-applied and
applied-versus-disk separately and includes mutation recovery health.

```bash
node packages/cli/dist/bin.js status
node packages/cli/dist/bin.js --output json status --agent codex
```

Options:

| Option | Description |
| --- | --- |
| `-a, --agent <ids>` | Filter by comma-separated agent ids. |
| `--dir <path>` | Filter by project root. |
| `--json` | Compatibility alias for `--output json`. |

`--output json status --agent <ids>` returns `verification.desiredVsApplied`,
`verification.appliedVsDisk`, `verification.recovery`, and
`verification.healthy`. Without `--agent`, the command returns ledger-versus-
disk `items` only and does not claim full verification health.

## `revert`

Rolls back ledger entries.

```bash
node packages/cli/dist/bin.js --output json revert --agent codex --dry-run
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
| `--json` | Compatibility alias for `--output json`; command data contains the Core revert plan/result and mutation identity or receipt. |

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
node packages/cli/dist/bin.js ui --port 4317 --token-fd 3 3< /path/to/ui-token
```

Options:

| Option | Description |
| --- | --- |
| `--port <port>` | Port in the range `1..65535`, default `4317`. |
| `--token-fd <number>` | Read the optional bearer token from an inherited descriptor numbered `3` or greater. |

The bearer token never belongs in argv or structured request JSON. Pass only
the descriptor number and source its bytes from a runner-owned protected file,
pipe, or equivalent channel; the example file should be readable only by its
owner.

`ui` preloads any available authority before starting the server and injects
only the narrow in-memory `MutationAuthority` capability needed for sealing,
current-epoch leases, and protected journal tips. Web receives no general
`SecretStore`, raw key, credential-provider handle, or authority provisioning or
rotation operation. The capability's protected backend can check only its own
epoch and replay tip; routes cannot perform arbitrary credential operations.
Web scan/import composition always uses environment-reference mode and makes
zero vault or keychain secret calls. Authorityless scan planning remains
available, while executable import and other mutation routes fail closed.
