# cellarer

`English` | [简体中文](README.zh-CN.md)

> Manage AI agent skills, MCP servers, and rules from one local store.

cellarer is for people who use several AI coding agents on the same machine.
Instead of maintaining the same rules, MCP configuration, and skills in several
agent-specific locations, you import them once, preview the exact changes, and
sync them to selected agents. Unified Inventory provides the read-only view of
existing agent configuration before an exact Store import.

The project is built around three ideas:

- **Local first:** the store and generated configuration stay on your machine.
- **Preview before mutation:** distribution, import, configuration, and revert
  operations use plan/apply boundaries and durable receipts.
- **References, not plaintext secrets:** generated files preserve supported
  environment or cellarer references instead of materializing secret values.

## Status and requirements

cellarer is pre-release. The public packages are prepared as
`0.1.0-alpha.0`, but they have not been published, so the supported path today
is to build and run the CLI from this repository.

- Node.js `>=20.19`
- pnpm `10.12.1`
- Ubuntu, macOS, or Windows

Regular Rule and MCP files work on all three platforms. Recursive local Skill
directory import currently requires Darwin or Linux on x64/arm64.

## Build and run

```bash
pnpm install
pnpm build
node packages/cli/dist/bin.js --help
```

After publication, the same command surface will be available through the
`cellarer` executable. Until then, the examples below use the built source path.

## First workflow

Initialize or validate the local Store. Interactive text mode refreshes the live
Inventory, preselects only Core-designated ready candidates, and asks once
before importing that exact selection into the Library:

On a headless machine without an OS credential manager, configure the protected
[mutation authority](docs/README.md#mutation-authority) before `init`.

```bash
node packages/cli/dist/bin.js init
```

Declining leaves Store initialization complete and imports nothing. Partial or
failed Inventory is reported separately with `inventory refresh` retry guidance.
Machine modes return the closed redacted Store and Inventory phases without a
prompt or import:

```bash
node packages/cli/dist/bin.js --output json init
node packages/cli/dist/bin.js --non-interactive init
```

Init no longer accepts `--agent`, `--no-agent`, or structured `agents`. Agent
targets are selected only by later, separately authorized distribution commands.

Refresh the read-only Inventory across every registered bounded user source, or
one exact adapter. Add `--dir <project>` to include that current project:

```bash
node packages/cli/dist/bin.js inventory refresh
node packages/cli/dist/bin.js inventory refresh --agent codex
```

Inventory reports safe candidates, provenance, findings, Store matches, counts,
and completeness; it does not import or write agent targets.

After a Custom Agent definition is committed by add or update, cellarer makes
one targeted Inventory refresh attempt. A partial or failed refresh is reported
separately and does not undo the committed mutation. Retry it explicitly with
`cellarer inventory refresh --agent <id>`; clients do not retry or import
automatically.

To import reviewed candidates into the Store, plan with their exact IDs and then
apply the unchanged `mutationPlan` returned by that command. Import never
distributes resources to agent targets:

```bash
node packages/cli/dist/bin.js --output json inventory import plan \
  --candidate '<candidate-id>'
node packages/cli/dist/bin.js inventory import apply \
  --plan '<mutationPlan JSON returned by plan>'
```

Use this repository's README as a real Rule input and an isolated project
directory as the target:

```bash
mkdir .cellarer-demo
node packages/cli/dist/bin.js add ./README.md
```

Preview before writing, then apply the same selection:

```bash
node packages/cli/dist/bin.js apply --dry-run --agent codex --rules \
  --dir "$PWD/.cellarer-demo"
node packages/cli/dist/bin.js apply --agent codex --rules \
  --dir "$PWD/.cellarer-demo"
```

Inspect the result or roll it back:

```bash
node packages/cli/dist/bin.js status --agent codex --dir "$PWD/.cellarer-demo"
node packages/cli/dist/bin.js revert --dry-run --agent codex \
  --dir "$PWD/.cellarer-demo"
node packages/cli/dist/bin.js revert --agent codex \
  --dir "$PWD/.cellarer-demo"
rmdir .cellarer-demo
```

The explicit `--dir` keeps this walkthrough on the demo project; omitting it
selects the agent's real global configuration.

Start the loopback-only Web console:

```bash
node packages/cli/dist/bin.js ui
```

## What it manages

| Area | Main operations |
| --- | --- |
| Library | Refresh Inventory; import, inspect, update, rename, remove, export, and bundle resources. |
| Agents | Detect agents, configure adapters, and inspect supported targets. |
| Distribution | Preview and sync rules, MCP servers, and skills by agent, scope, collection, or profile. |
| Safety | Verify drift, preserve target ownership, recover interrupted operations, and revert receipts. |
| Clients | Use the human CLI, versioned JSON/JSONL protocol, or authenticated local `/api/v1`. |

Run `node packages/cli/dist/bin.js <command> --help` for exact options. Automated
callers can discover stable command and schema contracts with `capabilities`
and `schema`.

## Architecture in brief

cellarer is a TypeScript monorepo. `@cellarer/core` owns the store, planning,
mutation, safety, and adapter logic. `@cellarer/cli` and `@cellarer/web` are thin
interfaces over Core. Core receives filesystem, environment, platform, clock,
and credential effects through an injected `Env`, which keeps behavior testable
and prevents presentation layers from inventing mutation rules.

For concepts, workflows, architecture, security, automation, adapters, and
release procedures, read the [detailed guide](docs/README.md).

## Development

```bash
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

## License

MIT, see [LICENSE](LICENSE).
