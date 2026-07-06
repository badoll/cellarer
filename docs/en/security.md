# Security

[Documentation index](../README.md) | [简体中文](../zh-CN/security.md)

cellarer is a local configuration tool, but it still treats secret handling as a
hard boundary.

## Plaintext Secret Boundary

Store artifacts and generated files must not contain plaintext secrets. Use
references instead:

```json
{
  "command": "example-server",
  "env": {
    "OPENAI_API_KEY": "${OPENAI_API_KEY}"
  }
}
```

or:

```json
{
  "command": "example-server",
  "env": {
    "OPENAI_API_KEY": "${CELLARER_SECRET:OPENAI_API_KEY}"
  }
}
```

## Secret Modes

| Mode | Behavior |
| --- | --- |
| `env` | Render secret references as environment-variable references. This is the default and safest generated-file mode. |
| `vault` | Resolve from the age-encrypted cellarer vault when explicitly requested. |
| `keychain` | Resolve through the injected system secret store when available. |

If a vault or keychain lookup cannot be safely resolved, cellarer falls back to
environment references rather than writing internal placeholder syntax that an
agent cannot use.

## Import and Scan Guards

- `add` rejects import sources that contain high-confidence plaintext secrets.
- `scan` redacts structured MCP secret fields before store writes.
- Store writes run a final plaintext guard.
- Skill directories containing symlinks are rejected during `add` because the
  symlink target cannot be safely scanned as store content.

## Web UI Security

The Web server:

- listens on `127.0.0.1`
- supports an optional bearer token
- validates Host headers as a DNS rebinding defense
- uses env-mode previews so HTTP responses do not contain secret values
- returns secret reference names only

## Known Limits

Secret detection is defensive but not perfect. Low-entropy passwords, custom
token formats, or credentials embedded in uncommon fields may require manual
review. Treat `--dry-run`, code review, and repository scans as part of the
release process for sensitive changes.

Current `secret add <name> <value>` receives the value as a CLI argument. Use
care with shell history until a hidden input or stdin mode exists.
