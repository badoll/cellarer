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
    "channels": ["common"],
    "secretMode": "env"
  },
  "channels": {
    "common": {
      "description": "Shared defaults"
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
        "serversKey": "mcpServers"
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

## Path Templates

| Template | Meaning |
| --- | --- |
| `~` or `~/...` | Home directory for global scope. |
| `{dir}` | Project root passed through `--dir`. |
| relative path | Resolved under the current managed root. |

Expanded paths must stay inside the managed root for the selected scope.

## MCP Field Dialects

Adapters can describe common MCP shape differences:

```json
{
  "mcp": {
    "format": "json",
    "serversKey": "mcp",
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

## Examples

- [Basic directory layout](../../examples/adapters/acme-agent.example.json)
- [MCP field dialects](../../examples/adapters/quirky-agent.example.json)

## When Configuration Is Not Enough

If an agent needs non-trivial conversion, multi-file coordination, or behavior
that cannot be represented as paths plus common JSON or TOML MCP formats, extend
the schema or shared codecs first. Built-in changes and new agent entries both
live in `adapters`; the key decides whether the entry patches a built-in adapter
or defines a custom adapter.
