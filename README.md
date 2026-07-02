# cellarer

`English` | [简体中文](README.zh-CN.md)

> One local store for AI agent skills, MCP servers, and rules. Maintain once,
> distribute to multiple agents, scan existing configuration back, and keep
> secrets out of generated files.

cellarer is a local-first configuration manager for people who use several AI
coding agents on the same machine. It manages three artifact types:

- rules, such as `AGENTS.md`, `CLAUDE.md`, or agent-specific rule files
- MCP server definitions in each agent's native JSON or TOML shape
- skills directories

The repository is currently pre-release. The workspace packages are still
`private: true` with version `0.0.0`, so use the source build until the npm
release checklist is completed.

## Quick Start

```bash
pnpm install
pnpm build
node packages/cli/dist/bin.js --help
```

Initialize the local cellarer store:

```bash
node packages/cli/dist/bin.js init
```

Import local artifacts into the store:

```bash
node packages/cli/dist/bin.js add ./my-rules.md
node packages/cli/dist/bin.js add ./context7.json
node packages/cli/dist/bin.js add ./my-skill/
```

Preview, apply, inspect, and revert a distribution:

```bash
node packages/cli/dist/bin.js agents
node packages/cli/dist/bin.js doctor
node packages/cli/dist/bin.js apply --dry-run --agent claude-code,codex --rules --mcp --skills
node packages/cli/dist/bin.js apply --agent claude-code,codex --rules --mcp --skills
node packages/cli/dist/bin.js status
node packages/cli/dist/bin.js revert --agent claude-code,codex
```

Start the local Web console:

```bash
node packages/cli/dist/bin.js ui
```

## Commands

| Command | Purpose |
| --- | --- |
| `init` | Initialize the store at `~/.cellarer` or `CELLARER_HOME`. |
| `add <source>` | Import a local `.md`, `.json`, or directory artifact into the store. Git and URL sources are not implemented yet. |
| `ls` | List stored rules, MCP servers, skills, and channel tags. |
| `agents` | Show registered agent adapters, detect results, capabilities, and target paths. |
| `doctor` | Check store initialization, adapter loading, agent detection, and target path write access. |
| `apply` | Plan and distribute artifacts to selected agents. Use `--dry-run` before writing. |
| `scan` | Read native agent configuration and import normalized artifacts into the store. |
| `status` | Check ledger entries for drift, missing targets, and broken links. |
| `revert` | Roll back previously applied ledger entries. |
| `secret` | Manage encrypted vault entries by reference name. |
| `ui` | Run the local Web console on `127.0.0.1`. |

See the full [CLI reference](docs/en/cli-reference.md).

## Architecture

cellarer is a TypeScript monorepo:

- `@cellarer/core` owns all business logic.
- `@cellarer/cli` parses command-line options and calls core.
- `@cellarer/web` exposes core through a local Hono API and React UI.

Core code receives file system, home directory, current directory, platform, and
time through an injected `Env`. Distribution is split into plan and apply
phases, and each applied change is recorded in a ledger so status and revert can
work deterministically.

Read more in the [architecture](docs/en/architecture.md) and
[security](docs/en/security.md) docs.

## Documentation

- [Documentation index](docs/README.md)
- [Getting started](docs/en/getting-started.md)
- [Concepts](docs/en/concepts.md)
- [Custom adapters](docs/en/adapters.md)
- [Web UI](docs/en/web-ui.md)
- [Release checklist](docs/en/maintainers/release.md)

## Development

```bash
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

CI is expected to run these checks on Ubuntu, macOS, and Windows.

## License

MIT, see [LICENSE](LICENSE).
