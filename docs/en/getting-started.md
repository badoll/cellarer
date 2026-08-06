# Getting Started

[Documentation index](../README.md) | [简体中文](../zh-CN/getting-started.md)

cellarer is currently used from source. Package metadata is prepared at
`0.1.0-alpha.0`, but no package has been published yet.

## Prerequisites

- Node.js `>=20.19`
- pnpm `10.12.1`
- Ubuntu, macOS, or Windows

## npm Installation (After Publication)

The npm packages are not published yet. Once `@cellarer/cli` is published, the
supported installation and one-shot commands will be:

```bash
npm install --global @cellarer/cli
cellarer --help
npx @cellarer/cli --help
```

The CLI installation brings in the synchronized release set: `@cellarer/core`
contains runtime logic and packaged adapter configuration, `@cellarer/web`
contains the server and built client assets, and `@cellarer/cli` contains the
compiled executable. Until publication, use the source build below.

## Build the CLI

```bash
pnpm install
pnpm build
node packages/cli/dist/bin.js --help
```

The examples below use the built CLI path. After publication, the same command
surface will be available through the `cellarer` bin.

## Initialize the Store

```bash
node packages/cli/dist/bin.js init --agent codex,claude-code
```

By default this creates or reuses the store under `~/.cellarer`. Set
`CELLARER_HOME` when you want an isolated store for testing. Initialization
reports the detected/configured inventory and enables only the exact adapter
IDs passed with `--agent`. Omitting targets returns `INPUT_REQUIRED`; it never
selects all detected agents implicitly.

## Add Resources

```bash
node packages/cli/dist/bin.js add ./my-rules.md
node packages/cli/dist/bin.js add ./context7.json
node packages/cli/dist/bin.js add ./my-skill/
node packages/cli/dist/bin.js add vercel-labs/skills --list
node packages/cli/dist/bin.js add vercel-labs/skills --skill nextjs --collection public
```

Current source support:

- `.md` files are imported as rules.
- `.json` files are imported as MCP server resources.
- local skill directories and parent directories are imported as skills.
- GitHub `owner/repo`, repository URLs, and `/tree/<ref>/<subpath>` URLs are
  supported for skills.

Remote skill imports write provenance under `store/metadata/skills/<name>.json`.
GitLab and arbitrary git URLs are not supported in this milestone.

## List Library Resources

```bash
node packages/cli/dist/bin.js ls
node packages/cli/dist/bin.js ls --collection default
node packages/cli/dist/bin.js resource list --kind rules
node packages/cli/dist/bin.js resource show rules/my-rules
```

Use `resource list/show` for stable IDs, provenance, validation, collection
membership, desired selection, and applied usage. Mutation commands use the
immutable ID (for example `rules/my-rules`), not a resource name.

## Inspect Agents

```bash
node packages/cli/dist/bin.js agents
node packages/cli/dist/bin.js doctor
node packages/cli/dist/bin.js agent list --scope project --dir /path/to/project
node packages/cli/dist/bin.js agent show codex --scope global
```

Use `agents --dir <path>` or `doctor --dir <path>` to inspect project-scope
targets. Both commands support `-a, --agent <ids>` and `--json`.

## Manage Agents, Collections, and Settings

```bash
node packages/cli/dist/bin.js agent configure codex \
  --adapter '{"displayName":"Codex Local"}' --dry-run
node packages/cli/dist/bin.js agent add my-agent \
  --adapter '{"displayName":"My Agent","rules":{"project":"{dir}/.my-agent/RULES.md"}}'
node packages/cli/dist/bin.js collection create work \
  --resource rules/my-rules --description "Work resources"
node packages/cli/dist/bin.js collection defaults set --collection default,work
node packages/cli/dist/bin.js config update --settings '{"method":"copy"}'
```

Run any control-plane mutation with `--dry-run` to receive its revisioned plan
without changing the store or targets. Built-in patches live in
`adapterOverrides`; declarative custom agents live in `customAdapters`.
Apply that exact plan instead of repeating the mutation inputs:

```bash
PLAN_JSON=$(node packages/cli/dist/bin.js --output json \
  config update --settings '{"method":"copy"}' --dry-run | \
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s).data.plan)))')
node packages/cli/dist/bin.js --output jsonl apply --plan "$PLAN_JSON"
```

This round trip works for every agent/adapter, collection membership/default,
and typed config mutation. The plan contains only reference-safe publication
bytes. Any revision, config, ledger, artifact-membership, or target change
between planning and the mutation lock rejects the plan without a receipt.

## Preview and Apply

Create an exact serializable distribution plan first:

```bash
PLAN_JSON=$(node packages/cli/dist/bin.js --output json plan \
  --agent claude-code,codex --scope global --rules --mcp --skills | \
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s).data.plan)))')
```

Apply the exact authority-sealed plan after reviewing it:

```bash
node packages/cli/dist/bin.js --output jsonl apply --plan "$PLAN_JSON"
```

`--agent` is required for the planning path (`plan`, direct `apply`, or
`apply --dry-run`), but not for `apply --plan`. The top-level `plan` response is
`{ plan: <sealed-plan>, preview }`; distribution dry-run/apply returns
`{ plan: <preview>, entries, failures, mutation }`, with a receipt only at
`mutation.result.receipt` after execution. Settings dry-run returns
`{ plan, changedFields }`; settings `apply --plan` also returns `mutation` and,
on success, `receipt`.

Use `--dir <path>` for project scope. Without `--dir`, cellarer writes to each
agent's global location. For structured input, put the unchanged plan object at
`input.plan` in an `apply` request. Do not combine `plan` with agents,
capabilities, `dir`, acknowledgements, or `dryRun`.

## Scan Existing Agent Configuration

```bash
node packages/cli/dist/bin.js scan --agent codex --dry-run --json
node packages/cli/dist/bin.js scan --agent codex --rules --into-collection default \
  --select '[{"kind":"rules","name":"team","source":"/absolute/path/AGENTS.md"}]'
```

`scan` accepts one agent at a time. The plan omits secret values and only returns
secret reference names. A mutating `--select` is a JSON array of complete
`kind`, `name`, and `source` selectors copied from the preview; name-only input
is rejected.

## Check and Revert

```bash
node packages/cli/dist/bin.js status
node packages/cli/dist/bin.js verify --scope project --dir /path/to/project \
  --agent claude-code,codex --rules
node packages/cli/dist/bin.js operation list
node packages/cli/dist/bin.js --output json operation recover operation-<id> --dry-run
node packages/cli/dist/bin.js --output json operation recover operation-<id>
node packages/cli/dist/bin.js revert --agent claude-code,codex
```

`revert` uses the ledger written by `apply`. To revert everything without an
agent or directory selector, pass `--all` explicitly.
Diagnose recovery with `--dry-run` before attempting it. If the result is
`RECOVERY_REQUIRED`, follow its typed evidence and leave locks and journals in
place; do not delete them manually.

## Start the Web UI

```bash
node packages/cli/dist/bin.js ui
node packages/cli/dist/bin.js ui --port 4317 --token-fd 3 3< /path/to/ui-token
```

The server listens on `127.0.0.1` only.
