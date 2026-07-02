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

Imports a local source into the store.

```bash
node packages/cli/dist/bin.js add ./my-rules.md
node packages/cli/dist/bin.js add ./server.json --force
node packages/cli/dist/bin.js add ./my-skill/
```

Options:

| Option | Description |
| --- | --- |
| `--force` | Overwrite an existing artifact with the same name. |

Supported local sources:

| Source | Artifact kind |
| --- | --- |
| `.md` file | rules |
| `.json` file | MCP server |
| directory | skill |

Git and URL sources are not implemented yet.

## `ls`

Lists stored artifacts and channel tags.

```bash
node packages/cli/dist/bin.js ls
node packages/cli/dist/bin.js ls --channel internal
```

Options:

| Option | Description |
| --- | --- |
| `--channel <channel>` | Show artifacts visible for a channel. |

## `apply`

Plans or writes artifacts to selected agents.

```bash
node packages/cli/dist/bin.js apply --dry-run --agent claude-code,codex
node packages/cli/dist/bin.js apply --agent claude-code,codex --dir /path/to/project --rules
```

Options:

| Option | Description |
| --- | --- |
| `--agent <ids>` | Required. Comma-separated agent ids. |
| `--dir <path>` | Project scope root. Omit for global scope. |
| `--channel <channel>` | Filter artifacts by channel. |
| `--rules` | Include rules. If no capability flag is set, all capabilities are included. |
| `--mcp` | Include MCP servers. |
| `--skills` | Include skills. |
| `--copy` | Prefer copy instead of symlink for skills. |
| `--mcp-overwrite` | Use overwrite instead of merge for MCP server groups. |
| `--secret-mode <mode>` | `env`, `vault`, or `keychain`. |
| `--vault-passphrase <pp>` | Vault passphrase for `--secret-mode vault`. |
| `--dry-run` | Print the plan without writing. |

## `scan`

Reads native agent configuration and imports normalized artifacts into the
store.

```bash
node packages/cli/dist/bin.js scan --agent codex --dry-run
node packages/cli/dist/bin.js scan --agent codex --into-channel common --conflict copy
```

Options:

| Option | Description |
| --- | --- |
| `--agent <id>` | Required. Exactly one agent id. |
| `--dir <path>` | Project scope root. Omit for global scope. |
| `--rules` | Scan only rules. |
| `--mcp` | Scan only MCP servers. |
| `--skills` | Scan only skills. |
| `--into-channel <channel>` | Tag imported artifacts with this channel. |
| `--conflict <strategy>` | `keep-theirs`, `keep-mine`, or `copy`. |
| `--select <names>` | Comma-separated artifact names to import. |
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
| `--agent <ids>` | Filter by comma-separated agent ids. |
| `--dir <path>` | Filter by project root. |
| `--json` | Print machine-readable output. |

## `revert`

Rolls back ledger entries.

```bash
node packages/cli/dist/bin.js revert --agent codex
node packages/cli/dist/bin.js revert --all --dry-run
```

Options:

| Option | Description |
| --- | --- |
| `--agent <ids>` | Filter by comma-separated agent ids. |
| `--dir <path>` | Filter by project root. |
| `--all` | Required when reverting all entries without another selector. |
| `--keep-backups` | Leave `.bak` files in place. |
| `--dry-run` | Preview rollback actions. |

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
