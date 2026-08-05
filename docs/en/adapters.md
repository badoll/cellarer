# Custom Adapters

[Documentation index](../README.md) | [简体中文](../zh-CN/adapters.md)

Adapters describe where an AI agent stores rules, MCP servers, and skills.
cellarer ships built-in adapters with the package. User config stores a single
`adapters` map keyed by adapter id.

## Adapter Locations

The user config is loaded from:

- store config: `~/.cellarer/config.json`
- custom store config when `CELLARER_HOME` is set: `$CELLARER_HOME/config.json`

To patch a built-in adapter, write `adapters["<built-in-id>"]`. To add a new
agent, write `adapters["<new-id>"]`. The object key is the adapter id; adapter
objects do not repeat `id` internally.

## Config Shape

`cellarer init` creates `config.json` if it is missing and never overwrites an
existing file. Adapter customization uses this shape:

```json
{
  "version": 1,
  "defaults": {
    "method": "symlink",
    "collections": ["default"],
    "secretMode": "env"
  },
  "collections": {
    "default": {
      "description": "Default"
    }
  },
  "artifacts": {},
  "agents": {},
  "adapters": {
    "claude-code": {
      "detect": {
        "global": ["~/Library/Application Support/Claude"]
      },
      "rules": {
        "global": "~/Library/Application Support/Claude/CLAUDE.md"
      },
      "mcp": {
        "global": "~/Library/Application Support/Claude/mcp.json"
      },
      "skills": {
        "global": "~/Library/Application Support/Claude/skills"
      }
    },
    "my-agent": {
      "displayName": "My Agent",
      "detect": {
        "global": ["~/.myagent"]
      },
      "rules": {
        "global": "~/.myagent/AGENTS.md",
        "project": "{dir}/.myagent/rules.md",
        "format": "markdown"
      },
      "mcp": {
        "global": "~/.myagent/mcp.json",
        "project": "{dir}/.myagent/mcp.json",
        "format": "json",
        "serversKey": "mcpServers",
        "supportedSecretReferences": ["environment", "cellarer"]
      },
      "skills": {
        "global": "~/.myagent/skills",
        "project": "{dir}/.myagent/skills",
        "format": "dir"
      },
      "capabilities": {
        "rules": ["global", "project"],
        "mcp": ["global", "project"],
        "skills": ["project"]
      }
    }
  }
}
```

When the key matches a packaged built-in adapter, the value is a patch. Fields
you do not specify continue to inherit from the packaged built-in adapter, so
package updates can still improve unchanged fields. In the Web UI, editing a
built-in adapter should save only `adapters["<built-in-id>"]`; resetting to
default should delete that key.

When the key does not match a packaged built-in adapter, the value is a custom
adapter definition and must declare at least one of `rules`, `mcp`, or `skills`.
A custom MCP adapter must also declare `supportedSecretReferences`. List only
the reference kinds that the target consumes natively. Planning skips a target
when selected content uses an unsupported kind; an empty list therefore blocks
all secret-backed MCP values instead of materializing plaintext.

## Built-in Secret-Reference Compatibility

`supportedSecretReferences` describes the exact output produced by the current
adapter, not an agent's abstract ability to use environment variables. The
generic renderer preserves `${ENV_VAR}` literally and does not translate it to
another token dialect or a structural environment-variable facility.

| Built-in adapter | Declared support | Current compatibility boundary |
| --- | --- | --- |
| Claude Code | `environment` | Its native MCP environment configuration consumes the exact `${VAR}` token emitted by the renderer. |
| Gemini CLI | `environment` | Its native MCP environment configuration consumes the exact `${VAR}` token emitted by the renderer. |
| Codex | none | Codex requires its structural `env_vars` facility; translation is not implemented. |
| Cursor | none | Exact `${VAR}` expansion is not part of cellarer's verified current target contract. |
| OpenCode | none | OpenCode uses `{env:NAME}`; translation is not implemented. |
| Windsurf | none | Windsurf uses `${env:NAME}`; translation is not implemented. |

No built-in currently declares `cellarer` support. Planning fails closed when
selected MCP content uses a reference kind absent from the target's declaration.
Codex, Cursor, OpenCode, and Windsurf therefore reject `${ENV_VAR}` until a later
adapter-specific renderer implements and verifies the required translation.

## Path Templates

| Template | Meaning |
| --- | --- |
| `~` or `~/...` | Home directory for global scope. |
| `{dir}` | Project root passed through `--dir`. |
| relative path | Resolved under the current managed root. |

Expanded paths must stay inside the managed root for the selected scope.

## MCP Field Dialects

Adapters can describe typical MCP shape differences:

```json
{
  "mcp": {
    "format": "json",
    "serversKey": "mcp",
    "supportedSecretReferences": ["environment"],
    "dialect": {
      "commandStyle": "array",
      "envKey": "environment",
      "urlKey": "serverUrl"
    }
  }
}
```

Use these for agents that store command arguments as arrays, use
`environment` instead of `env`, or use `serverUrl` for remote MCP servers.
Field-shape dialect settings do not translate secret-reference tokens and do
not by themselves justify adding `environment` support.

## Examples

- [Basic directory layout](../../examples/adapters/acme-agent.example.json)
- [MCP field dialects](../../examples/adapters/quirky-agent.example.json)

## When Configuration Is Not Enough

If an agent needs non-trivial conversion, multi-file coordination, or behavior
that cannot be represented as paths plus standard JSON or TOML MCP formats, extend
the schema or shared codecs first. Built-in changes and new agent entries both
live in `adapters`; the key decides whether the entry patches a built-in adapter
or defines a custom adapter.
