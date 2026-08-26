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

The first stable public package set is prepared as `0.1.0`. The release
artifacts pass the clean-install gate, but they have not been published to npm;
registry publication remains a separate release action.

- Node.js `>=20.19`
- pnpm `10.12.1`
- Ubuntu, macOS, or Windows

Regular Rule and MCP files work on all three platforms. Recursive local Skill
directory import currently requires Darwin or Linux on x64/arm64.

## Install and run

After the registry release, install the CLI package globally. Its package name
is scoped, but the installed executable is the direct `cellarer` command:

```bash
npm install --global @cellarer/cli
cellarer --help
```

Until registry publication, release maintainers can build and exercise the same
packed command locally with the steps in [Development](#development). The user
workflows below use the installed product interface.

## First workflow

Initialize or validate the local Store. Interactive text mode refreshes the live
Inventory, preselects only Core-designated ready candidates, and asks once
before importing that exact selection into the Library:

On a headless machine without an OS credential manager, configure the protected
[mutation authority](docs/README.md#mutation-authority) before `init`.

```bash
cellarer init
```

Declining leaves Store initialization complete and imports nothing. Partial or
failed Inventory is reported separately with `inventory refresh` retry guidance.
Machine modes return the closed redacted Store and Inventory phases without a
prompt or import:

```bash
cellarer --output json init
cellarer --non-interactive init
```

Init no longer accepts `--agent`, `--no-agent`, or structured `agents`. Agent
targets are selected only by later, separately authorized distribution commands.

Refresh the read-only Inventory across every registered bounded user source, or
one exact adapter. Add `--dir <project>` to include that current project:

```bash
cellarer inventory refresh
cellarer inventory refresh --agent codex
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
cellarer --output json inventory import plan \
  --candidate '<candidate-id>'
cellarer inventory import apply \
  --plan '<mutationPlan JSON returned by plan>'
```

For a blocked MCP candidate with one `secret-adoption-required` finding, copy
the finding's exact selector into a reference-only adoption plan. Supported
fields are stdio environment entries and flag arguments, plus remote headers
and unique URL query parameters. Rule/Skill candidates, custom MCP shapes,
malformed or ambiguous fields, and multiple candidate secret fields remain
blocked:

```bash
cellarer --output json inventory adopt plan \
  --candidate '<candidate-id>' \
  --selector '{"kind":"environment","server":"example","name":"API_TOKEN"}' \
  --provider vault
cellarer inventory adopt apply \
  --plan '<mutationPlan JSON returned by plan>' --confirm
```

Planning is read-only and never contacts a secret provider. Apply requires a
runtime composition with an atomic create-if-absent provider capability; it
never accepts a secret value in argv or machine input and never overwrites an
existing entry. If provider creation succeeds but Store publication fails, the
typed result preserves the exact manual cleanup command and cellarer does not
silently delete the orphaned reference.

Use this repository's README as a real Rule input and an isolated project
directory as the target:

```bash
mkdir .cellarer-demo
cellarer add ./README.md
```

Preview before writing, then apply the same selection:

```bash
cellarer apply --dry-run --agent codex --rules \
  --dir "$PWD/.cellarer-demo"
cellarer apply --agent codex --rules \
  --dir "$PWD/.cellarer-demo"
```

Inspect the result or roll it back:

```bash
cellarer status --agent codex --dir "$PWD/.cellarer-demo"
cellarer revert --dry-run --agent codex \
  --dir "$PWD/.cellarer-demo"
cellarer revert --agent codex \
  --dir "$PWD/.cellarer-demo"
rmdir .cellarer-demo
```

The explicit `--dir` keeps this walkthrough on the demo project; omitting it
selects the agent's real global configuration.

Start the loopback-only Web console:

```bash
cellarer ui
```

## What it manages

| Area | Main operations |
| --- | --- |
| Library | Refresh Inventory; import, inspect, update, rename, remove, export, and bundle resources. |
| Agents | Detect agents, configure adapters, and inspect supported targets. |
| Distribution | Preview and sync rules, MCP servers, and skills by agent, scope, collection, or profile. |
| Safety | Verify drift, preserve target ownership, recover interrupted operations, and revert receipts. |
| Clients | Use the human CLI, versioned JSON/JSONL protocol, or authenticated local `/api/v1`. |

Run `cellarer <command> --help` for exact options. Automated
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
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
node packages/cli/dist/bin.js --help
```

## License

MIT, see [LICENSE](LICENSE).
