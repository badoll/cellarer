# CLI Reference

[Documentation index](../README.md) | [简体中文](../zh-CN/cli-reference.md)

Run from source after `pnpm build`:

```bash
node packages/cli/dist/bin.js <command>
```

## `init`

Initializes the store.

```bash
node packages/cli/dist/bin.js init
```

Options:

| Option | Description |
| --- | --- |
| `--global` | Accepted for clarity; global store initialization is the current default. |

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
agent detection, and target path write access without writing files.

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
| `--vault-passphrase <pp>` | Vault passphrase for `--secret-mode vault`. |
| `--replace-unowned <tokens>` | Comma-separated exact replacement tokens from `plan.conflicts`. |
| `--override-drift <tokens>` | Comma-separated exact drift-override tokens from `plan.conflicts`. |
| `--snapshot-passphrase <passphrase>` | Encrypt the before-state snapshot required by an approved replacement. |
| `--dry-run` | Print the plan without writing. |
| `--json` | Print the complete Core apply plan/result, including conflicts and acknowledgement tokens. |

An unacknowledged ownership conflict blocks apply and exits nonzero. Inspect the JSON dry-run,
then repeat the same selection with the exact conflict token in `--replace-unowned` or
`--override-drift` and provide `--snapshot-passphrase`.

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
| `--dry-run` | Show candidates without writing. |
| `--json` | Print JSON output. |

## `status`

Checks the apply ledger against the file system.

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

## `revert`

Rolls back ledger entries.

```bash
node packages/cli/dist/bin.js revert --agent codex --dry-run --json
node packages/cli/dist/bin.js revert --agent codex --acknowledge "$ACK_TOKEN" --snapshot-passphrase "$CELLARER_SNAPSHOT_PASSPHRASE"
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
| `--keep-backups` | Leave `.bak` files in place. |
| `--acknowledge <tokens>` | Comma-separated exact drift tokens returned by the dry-run plan. |
| `--snapshot-passphrase <passphrase>` | Passphrase used to decrypt a recorded before-state snapshot. |
| `--dry-run` | Preview rollback actions. |
| `--json` | Print the complete Core revert plan and result. |

## `secret`

Manages the encrypted vault. Values are never printed by `ls`.

```bash
node packages/cli/dist/bin.js secret add OPENAI_API_KEY "$OPENAI_API_KEY" --passphrase "$CELLARER_VAULT_PASSPHRASE"
node packages/cli/dist/bin.js secret ls --passphrase "$CELLARER_VAULT_PASSPHRASE"
node packages/cli/dist/bin.js secret rm OPENAI_API_KEY --passphrase "$CELLARER_VAULT_PASSPHRASE"
```

Current `secret add <name> <value>` passes the value as a command argument. Be
careful with shell history until a hidden prompt or stdin mode is added.

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
