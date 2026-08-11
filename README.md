# cellarer

`English` | [简体中文](README.zh-CN.md)

> One local store for AI agent skills, MCP servers, and rules. Maintain once,
> distribute to multiple agents, scan existing configuration back, and keep
> secrets out of generated files.

cellarer is a local-first configuration manager for people who use several AI
coding agents on the same machine. It manages three resource types:

- rules, such as `AGENTS.md`, `CLAUDE.md`, or agent-specific rule files
- MCP server definitions in each agent's native JSON or TOML shape
- skills directories

The repository is currently pre-release. Package metadata is prepared at
`0.1.0-alpha.0`, but nothing has been published, so use the source build until
the npm release checklist is completed.

## Installation Status and Requirements

cellarer requires Node.js `>=20.19` and supports Ubuntu, macOS, and Windows.
The following commands describe the intended npm interface, but do not work
until `@cellarer/cli` is published:

```bash
npm install --global @cellarer/cli
npx @cellarer/cli --help
```

The release set contains `@cellarer/core` (runtime logic and packaged adapter
configuration), `@cellarer/web` (server output and built dashboard assets), and
`@cellarer/cli` (the executable `cellarer` bin). Use the source workflow below
while the packages remain unpublished.

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

Import local resources into the store:

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

It binds only to `127.0.0.1` and uses a random HttpOnly browser session. Managed
clients can use protected bearer and lifetime descriptors; see the [Web UI and
local API guide](docs/en/web-ui.md).

## Commands

| Command | Purpose |
| --- | --- |
| `init` | Initialize the store at `~/.cellarer` or `CELLARER_HOME`. |
| `add <source>` | Import local rules/MCP files or local/GitHub skill sources into the store. |
| `ls` | List stored rules, MCP servers, skills, and collection tags. |
| `agents` | Show registered agent adapters, detect results, capabilities, and target paths. |
| `doctor` | Check store initialization, adapter loading, agent detection, and target path write access. |
| `apply` | Plan and sync resources to selected agents. Use `--dry-run` before writing. |
| `scan` | Read native agent configuration and import normalized resources into the store. |
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

CI runs these checks and the installed-artifact readiness gate on Node 20.19
across Ubuntu, macOS, and Windows.

## License

MIT, see [LICENSE](LICENSE).
