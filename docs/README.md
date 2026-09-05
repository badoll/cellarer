# Cellarer Guide

`English` | [简体中文](README.zh-CN.md) | [Project README](../README.md)

This is the single detailed guide to Cellarer. It explains the product model,
normal workflows, architecture, safety boundaries, automation interfaces,
extension model, and maintainer procedures. Exact CLI and HTTP schemas remain
discoverable from the running software so this guide can stay focused on how
the pieces fit together.

## Reading this guide

If you are new, start with the root [README](../README.md) and complete its first
workflow. Return here when you need to understand a decision or use a less
common operation.

Examples in this guide use the installed `cellarer` command. Contributors and
release maintainers working from a source checkout can use the source entrypoint
documented under [Development and release](#development-and-release).

Use runtime discovery when you need exact flags or machine contracts:

```bash
cellarer --help
cellarer <command> --help
cellarer --output json capabilities
cellarer --output json schema
```

Main sections:

- [Principles and boundaries](#principles-and-boundaries)
- [Mental model](#mental-model)
- [Common workflows](#common-workflows)
- [Architecture](#architecture)
- [Safety and recovery](#safety-and-recovery)
- [Automation interfaces](#automation-interfaces)
- [Custom adapters](#custom-adapters)
- [Development and release](#development-and-release)

## Principles and boundaries

Cellarer manages reusable local configuration for AI coding agents. The Store
is the source for three resource kinds:

- rules, including files such as `AGENTS.md` and `CLAUDE.md`;
- MCP server definitions normalized from agent-specific JSON or TOML shapes;
- skill directories containing `SKILL.md` and supporting files.

The product follows a few hard boundaries:

1. **Local first.** There is no account, cloud registry, telemetry pipeline, or
   multi-user service in the current product.
2. **Core first.** Business rules belong in `@cellarer/core`; CLI and Web parse
   requests and present Core results.
3. **Plan before apply.** A write is based on explicit inputs, a store revision,
   target preconditions, and an immutable plan. Dry-run does not write.
4. **Adapters own agent differences.** New paths and formats belong in adapter
   configuration or shared codecs, not scattered agent-id branches.
5. **Writes are owned and revertible.** Applied targets have receipts and one
   canonical owner. Drift and unmanaged content block destructive replacement
   unless the caller acknowledges the exact inspected state.
6. **Secrets stay references.** Store resources, plans, generated targets,
   logs, CLI output, and Web responses must not contain plaintext secret values.

Cellarer does not install agents, run an MCP proxy, execute skills, or replace a
general secret manager. It manages the configuration and evidence around those
systems.

## Mental model

### Store

The Store is the local source of truth. It defaults to `~/.cellarer`; set
`CELLARER_HOME` to use another Store, such as an isolated test environment.

Its durable state includes library content, user configuration, the applied
target ledger, monotonic revision evidence, completed operation receipts, and
recovery evidence. Credential values and plaintext target snapshots do not
belong in the Store.

### Resource

A resource is one reusable rule, MCP server definition, or skill. Managed
resources have immutable IDs such as `rules/team-rules` or `skills/review`.
Names and descriptive metadata may change, but mutations use the immutable ID
so dependency checks remain unambiguous.

`resource list` and `resource show` combine managed library data with discovered
agent content. Lifecycle commands can check for updates, stage a pinned update,
rename, remove, export, or import a reference-only bundle. Updating the Store
never silently distributes the result to agents.

Inventory is the live, read-only view before import. `inventory refresh`
inspects every registered adapter's declared bounded user sources, independently
of enabled or detected state; `--dir` adds one explicit current project and
`--agent <id>` narrows the same DTO to one registered adapter. It deduplicates
equivalent candidates, preserves redacted provenance and typed findings, marks
Store matches, and declares complete, partial, or failed completeness. Refresh
does not import, write targets, or access mutation authority or secret providers.

### Collection

A collection groups resource IDs for selection. `default` is created during
initialization; additional collections can model contexts such as `work`,
`personal`, or `review`. Collection membership is exact and does not copy the
resource.

### Agent adapter

An adapter describes how to detect an agent and where it stores rules, MCP
configuration, and skills for global and project scopes. It also declares
capabilities, codecs, path templates, and exact supported secret-reference
kinds.

Packaged agents may be adjusted through keyed `adapterOverrides`. New
declarative agents live under `customAdapters`. An agent is not considered a
mutation target merely because it was detected. Enabled state remains an
advanced distribution preference configured separately from initialization;
it never filters Inventory. Each target mutation requires its own exact agent
and capability selection.

### Scope and placement

Global scope writes to an agent's user configuration. Project scope writes
under an explicit project root supplied with `--dir` or `--workspace-root`.
Project operations never silently substitute the process working directory.

Rules and MCP data are rendered to native files. Skills can use symlink or copy
placement. The selected scope, method, merge policy, resources, agents, and
capabilities are part of the plan.

### Plan, apply, and receipt

Planning calculates actions without applying them. Executable plans bind the
operation, base Store revision, normalized inputs, ordered actions, target
preconditions, expiry policy, and authorization seal. Apply consumes those
exact semantics; it does not treat a digest as permission or silently rebuild a
changed plan.

Convenience human commands can dry-run and then repeat the same selection. A
managed client may keep the exact serializable plan and submit it through the
CLI or local API. Changed Store revision, target state, ownership, authority, or
plan content causes a typed conflict without an authorized write.

```bash
cellarer --output json apply --plan '<exact-plan-json>'
```

With structured CLI input, `input.plan` carries that same complete plan; do not
replace it with a digest or reconstruct it from selected fields.

A successful mutation returns an operation receipt with revisions and
per-action evidence. The ledger records the current applied target state;
receipts record operation outcomes. The ledger is not an activity-event log.

### Ownership, verification, and recovery

Each normalized physical target has one current owner identified by agent,
scope, capability, and path. Before mutation, Cellarer classifies it as absent,
owned-current, owned-drifted, unowned-existing, or invalid-owner.

Verification keeps three signals separate:

- desired resources versus the last applied state;
- last applied receipts versus current disk state;
- incomplete or manually recoverable mutation state.

Configuration is `healthy` only when every requested Agent/scope/capability is
covered, at least one target is verified, and all three axes converge. The
`coverage` object retains each request's typed outcome and expected/observed/failed
counts. Valid empty selections are `no-op` with `healthy: false`; unsupported,
disabled, blocked, or failed requests are `incomplete`. Complete observations with
state differences are `unhealthy`. Unknown Agent identities are invalid input.
`runtime.observation` remains `unknown`: matching files do not prove native Agent
loading or MCP connectivity.

Verification needs no mutation authority or secret provider. It only observes
journal and lock presence for recovery: absent state is clean; outstanding or
unreadable state conservatively requires authorized recovery inspection. An
interrupted operation keeps its journal and blocks later writes until
evidence-based recovery finishes or reports exact manual work.

## Common workflows

### Initialize and inspect

Interactive text-mode initialization creates or validates the Store, refreshes
the complete bounded Inventory, shows completeness and candidate state, and
asks once before importing the exact Core-default-selected ready candidate IDs.
Declining leaves Store initialization complete and imports nothing. Partial or
failed refresh remains separate, preserves its candidates and findings, and
offers no import confirmation until an explicit retry succeeds:

```bash
# Interactive Inventory review and one exact Store-import confirmation
cellarer init

# Prompt-free machine initialization; both return Inventory and import nothing
cellarer --output json init
cellarer --non-interactive init

# Exact retry and explicit import after review
cellarer inventory refresh
cellarer --output json inventory import plan --candidate '<candidate-id>'
cellarer inventory import apply --plan '<mutationPlan JSON returned by plan>'

# Agent inspection remains separate from initialization and import
cellarer agents
cellarer doctor
```

JSON, JSONL, structured input, non-TTY input, and `--non-interactive` return a
closed redacted Store/Inventory result and perform zero prompt, import, or
agent-target operations. Init no longer accepts `--agent`, `--no-agent`, or a
structured `agents` field. Repeating `init` refreshes current sources and offers
only the current Core defaults; equal in-Store revisions are not selected. A
stale confirmed plan is not retried silently: refresh, review, and create a new
exact plan. Resource import and later Sync authorization remain separate.

`doctor` is read-only. It checks Store layout, configuration, adapter loading,
agent detection, target write access, authority availability, locks, and
recovery evidence. It diagnoses an incomplete operation but does not delete or
repair evidence on its own.

### Import and inspect resources

```bash
cellarer add ./my-rules.md
cellarer add ./context7.json
cellarer add ./my-skill/
cellarer add vercel-labs/skills --list
cellarer add vercel-labs/skills --skill nextjs --collection public

cellarer ls --collection default
cellarer inventory refresh
cellarer inventory refresh --agent codex --dir "$PWD"
cellarer --output json inventory import plan \
  --candidate '<candidate-id>' --agent codex --dir "$PWD"
cellarer inventory import apply --plan '<mutationPlan JSON returned by plan>'
cellarer --output json inventory adopt plan \
  --candidate '<candidate-id>' \
  --selector '{"kind":"header","server":"example","name":"Authorization"}' \
  --provider keychain
cellarer inventory adopt apply --plan '<mutationPlan JSON returned by plan>' --confirm
cellarer resource list --kind skills
cellarer resource show skills/nextjs
```

Local `.md` files are rules, `.json` files are MCP resources, and eligible
directories are skills. GitHub owner/repository sources and repository tree URLs
are supported for remote skills. Imported remote skills retain provenance.

`inventory import plan` requires at least one exact candidate ID; it never
infers selection or prompts in non-interactive mode. The result binds the
current source evidence and Store revision in an authority-sealed,
cross-process `mutationPlan`. `inventory import apply` accepts only that plan,
revalidates its bindings, and publishes one Store revision. Neither command
writes agent targets. Use `--into-collection <id>` on planning to add every
imported resource to one existing collection in the same Store operation.

Inventory offers reference-only secret adoption only for an MCP candidate with
one unambiguous supported plaintext field. Supported selectors are stdio
environment entries, stdio flag assignments or values, remote headers, and
unique remote URL query parameters. Rules, skills, custom MCP payloads,
malformed selectors, duplicate URL parameters, and candidates with multiple
adoptable fields remain blocked. The selector is metadata; the secret value is
never accepted in argv, structured input, HTTP, logs, or browser state.

`inventory adopt plan` is read-only, makes zero provider calls, and binds the
exact candidate, source evidence, Store revision, selector, provider, absent
entry precondition, and reference-bearing Store actions into the sealed plan.
`inventory adopt apply` requires `--confirm`, revalidates those bindings before
provider interaction, and permits exactly one atomic create-if-absent attempt.
The runtime composition must supply a compatible narrow provider capability;
an unavailable provider or existing entry returns a typed rejection without
read, list, overwrite, or delete fallback. If the provider entry is created but
Store publication fails, the result and recovery diagnosis preserve the exact
provider/reference and manual `cellarer secret rm ... --provider ...` cleanup
command. Cellarer never silently deletes that orphan and never writes the
source or any agent target.

Use the resource lifecycle only when needed:

```bash
cellarer resource dependencies rules/team-rules
cellarer resource check rules/team-rules
cellarer resource update rules/team-rules --dry-run
cellarer resource rename rules/team-rules team-rules-v2 --dry-run
cellarer resource remove rules/team-rules --dry-run
```

Check and update are the only lifecycle paths that access an upstream source.
Updates are staged and pinned before Store mutation; a later distribution is a
separate operation.

### Manage agents, collections, and settings

```bash
cellarer agent list --scope global
cellarer agent show codex --scope global
cellarer agent configure codex \
  --adapter '{"displayName":"Codex Local"}' --dry-run

cellarer collection create work \
  --description "Work resources" --resource rules/team-rules
cellarer collection defaults set --collection default,work

cellarer config show
cellarer config update --settings '{"method":"copy"}' --dry-run
```

All control-plane mutations support dry-run. Built-in adapter configuration,
custom adapters, collection membership, and typed settings are revisioned
Store mutations; manual `config.json` editing is not the normal interface.

### Preview and distribute

For interactive use, preview and then repeat the same explicit selection:

```bash
cellarer apply --dry-run --agent codex,claude-code \
  --collection default --rules --mcp --skills
cellarer apply --agent codex,claude-code \
  --collection default --rules --mcp --skills
```

Use `--dir /absolute/project` for project scope. A non-interactive write must
name its agents and capabilities. Existing unmanaged or drifted targets stay
blocked; inspect machine output for exact acknowledgement tokens rather than
guessing or using a blanket force flag.

### Reusable profiles

Profiles record exact reusable desired state: agents, resource or collection
IDs, capabilities, scope, method, and merge policy. They do not store absolute
workspace paths, secret values, or permanent destructive acknowledgements.

```bash
cellarer profile create project-team --desired \
  '{"agentIds":["codex"],"scope":"project","resourceIds":["rules/team-rules"],"collectionIds":[],"capabilities":["rules"],"method":"copy","mergePolicy":"merge"}'
cellarer --output json sync plan project-team --workspace-root /workspace/app
cellarer sync verify project-team --workspace-root /workspace/app
cellarer sync uninstall project-team --workspace-root /workspace/app --dry-run
```

A project profile always receives the current absolute workspace root at
invocation time. Apply and uninstall still use the common ownership,
transaction, reference, and recovery rules.

### Migrate existing agent configuration

The legacy `scan` and `discovery summary` commands are removed and have no
compatibility aliases. Refresh Inventory to obtain current candidate IDs from
registered bounded sources:

```bash
cellarer --output json inventory refresh --agent codex
```

Plan an import with the exact reviewed candidate IDs, then apply the unchanged
authority-sealed `mutationPlan` returned by planning:

```bash
cellarer --output json inventory import plan \
  --candidate '<candidate-id>' --into-collection default
cellarer inventory import apply --plan '<mutationPlan JSON returned by plan>'
```

Inventory refresh is read-only. Import writes only to the Store and rechecks
captured source evidence without reselecting candidates. Distribution remains a
separate operation: use `apply --dry-run` and `apply`, or a reusable Sync
profile, when those Store resources should be written to agent targets.

### Verify, recover, and revert

```bash
cellarer --output json status --agent codex
cellarer --output json verify --agent codex --rules
cellarer operation list
cellarer --output json operation recover operation-<id> --dry-run
cellarer --output json revert --agent codex --dry-run
```

`status` without an agent reports ledger-versus-disk items. With an agent, it
can include the complete desired, disk, and recovery verification model.

`verify` exits 0 for `healthy` or a legitimate `no-op`, 2 for invalid input, and 3
(`DOMAIN_VALIDATION_FAILED`) for `incomplete` or `unhealthy`; error envelopes retain
the report in `data`. This corrects previously successful empty or skipped results.
The CLI and HTTP envelopes keep their existing protocol versions and now require
`configuration`, `coverage`, and `runtime` report fields. HTTP 200 only means the
query completed; inspect `data.configuration` to determine its result. Web coverage
cards display the same Core outcome and independent native runtime evidence.

Always diagnose an interrupted operation with `operation recover <id>
--dry-run`. Run recovery only when the result permits it. Never delete
`mutation.lock`, `recovery.lock`, or `operations/active.json` because it looks
old. A manual-recovery result intentionally leaves unverifiable targets and
evidence unchanged.

Revert is also plan-first and drift-aware. It removes a target created by
Cellarer only while ownership and receipts still prove it safe; a replaced
target is restored from its encrypted before-state snapshot. Exact drift
acknowledgements and the original snapshot passphrase may be required.

### Secret references

Use references in resources:

```json
{
  "command": "example-server",
  "env": {
    "OPENAI_API_KEY": "${OPENAI_API_KEY}"
  }
}
```

or, only for a target that natively supports it:

```text
${CELLARER_SECRET:OPENAI_API_KEY}
```

Add vault values through hidden input:

```bash
cellarer secret add OPENAI_API_KEY
cellarer secret ls
```

Automation must use `--stdin` or an inherited `--fd` for the value and a
separate protected descriptor for the vault passphrase. Secret values and
passphrases are not accepted as option values and are never printed by `ls`.

### Web UI and local API

```bash
cellarer ui
```

The server binds only to `127.0.0.1`. Browser mode creates a new random
`HttpOnly`, `SameSite=Strict` session and requires exact loopback Host and Origin
checks. Managed clients use bearer and lifetime material supplied through
separate inherited descriptors:

```bash
cellarer --output json ui --port 0 \
  --token-fd 3 --lifetime-fd 4 3< /path/to/token 4< /path/to/lifetime-pipe
```

Managed stdout contains one ready result after the socket, authentication,
assets, contract, and Core composition are ready. Lifetime EOF and process
signals use the same bounded shutdown path and preserve Core journals.

## Architecture

### Packages and effects

| Package | Responsibility |
| --- | --- |
| `@cellarer/core` | Store, adapters, resource lifecycle, planning, mutation, verification, recovery, revert, and reference safety. |
| `@cellarer/cli` | Human and machine command parsing and presentation. |
| `@cellarer/web` | Loopback Hono API and bundled React console. |

Core business logic receives filesystem, home, cwd, platform, environment,
clock, secret-provider, and process-lifetime effects through `Env`. It does not
read `process`, `os`, or `node:fs` directly from business logic. Tests can
therefore use temporary Stores and fake or injected effects.

### Distribution and Inventory import flows

```text
Store resources
  -> explicit agents, scope, collection/profile, and capabilities
  -> adapters and config
  -> render and secret guards
  -> immutable plan
  -> ownership and target preconditions
  -> journaled actions
  -> receipts, ledger, and revision
```

```text
Registered bounded agent sources
  -> safe read-only Inventory refresh
  -> redacted provenance, findings, and candidate IDs
  -> exact reviewed candidate selection
  -> immutable authority-sealed import plan
  -> Store mutation and receipt
```

### Versioned clients and sidecar

All supported local-client operations are under `/api/v1`. One route registry
owns methods, paths, authentication, closed request/response schemas, operation
IDs, and HTTP mappings. The same registry drives the Hono routes and OpenAPI
3.1 contract; CLI and HTTP share transport-neutral Core DTOs and error codes.

The sidecar adds no process-local mutation queue. Multiple CLI or sidecar
processes converge through Store revision, mutation authority, cross-process
locks, journals, ownership, and recovery. Liveness only proves transport;
authenticated readiness reports Store, authority, lock, and recovery blockers.

## Safety and recovery

### Reference-only output

Rendering preserves a reference only when the target adapter declares that its
exact native output supports that reference kind. `secretMode` selects a
provider for presence checks and known-value scanning; it never authorizes
plaintext rendering.

Imports, staged trees, generated bytes, plans, journals, receipts, errors, CLI
output, and Web responses pass structured and observable guards. Known values,
credential patterns, sensitive fields, malformed structured input, unsafe
symlinks, and ambiguous duplicate keys fail closed at their relevant boundary.

### Ownership and replacement

An unmanaged or drifted target cannot be overwritten by default. Explicit
replacement requires the exact acknowledgement bound to the inspected target
and a complete encrypted before-state snapshot. If capture, encryption, or
storage fails, the original target and ownership state remain unchanged.

Do not delete or edit Store evidence to bypass a conflict. Re-plan after an
ordinary stale revision; follow typed guidance for ownership or recovery
conflicts.

### Mutation authority

Executable plans and durable journal publications are sealed by a Store-scoped
mutation authority in addition to integrity digests. Normal local initialization
uses the OS credential manager. Headless environments may supply the exact
`CELLARER_MUTATION_AUTHORITY` format through a protected runner secret facility:
`v1:<positive-epoch>:<43-character-unpadded-base64url-key>`. Generate the 32
random bytes inside the credential or secret manager, encode them as unpadded
base64url, and inject the composed value without printing it or placing it in
shell history, argv, JSON, or Store files.

Authority rotation is explicit and is refused while an active journal exists.
Old or cross-Store plans are not accepted through compatibility fallbacks.
Read-only operations remain available when possible without claiming unsigned
state is safe to mutate.

### Known limits

- Secret detection is defensive, not proof that arbitrary content is safe;
  review sensitive dry-runs and use repository or provider scanners.
- The generic renderer does not translate reference tokens between agent
  dialects. Unsupported adapters fail closed.
- Recursive local Skill capture currently requires anchored no-follow traversal
  available on Darwin or Linux x64/arm64. Unsupported platforms fail before
  reading or copying the directory; safe regular Rule and MCP files remain
  supported on Windows.
- Automatic receipt or encrypted-snapshot deletion is currently unsupported
  where directory identity cannot be bound to a no-follow delete. Evidence is
  retained conservatively.
- Ledger version 1 and ambiguous pre-release ownership records require explicit
  reset or manual handling; they are not silently reinterpreted.

If a secret value ever appeared in a generated file, argv, log, response, or
backup, treat it as compromised: rotate it at the provider, remove retained
plaintext, replace it with a supported reference, then preview, apply, and run
independent secret scanning.

## Automation interfaces

### CLI protocol

Every registered command uses CLI protocol `1.0` and accepts global transport
options before the command:

```text
--output text|json|jsonl
--non-interactive
--input <path|->
```

JSON writes one terminal envelope. JSONL streaming commands may write ordered
events followed by exactly one terminal result; a stream without the terminal
record is interrupted and is not success. Machine stdout contains protocol
records only, while redacted diagnostics use stderr.

Structured requests keep the command in argv and put domain input in a
versioned request:

```json
{
  "protocolVersion": "1.0",
  "command": "status",
  "requestId": "ci:status:42",
  "input": {
    "agents": ["codex"]
  }
}
```

```bash
cellarer --output json --input request.json status
```

Do not duplicate a domain field in argv and `input`. Branch on stable
`error.code`, not localized messages. Discover supported commands, streaming
behavior, and input/output schema IDs instead of constructing them:

```bash
cellarer --output json capabilities
cellarer --output json schema
cellarer --output json schema urn:cellarer:cli:protocol:1.0:command:status:output
```

### Local HTTP API

Authenticated clients can discover version, capabilities, readiness, and the
implemented OpenAPI contract:

```text
GET /api/v1/health
GET /api/v1/version
GET /api/v1/capabilities
GET /api/v1/readiness
GET /api/v1/openapi.json
GET /api/v1/inventory?dir=/absolute/project
GET /api/v1/inventory/{agentId}?dir=/absolute/project
POST /api/v1/inventory/import/plan
POST /api/v1/inventory/import/apply
POST /api/v1/inventory/adoption/plan
POST /api/v1/inventory/adoption/apply
```

All JSON operations return a versioned envelope with request ID, status,
warnings, and either data or a typed error. Mutation routes separate plan and
apply and submit the unchanged authority-sealed plan. The unversioned `/api/*`
surface does not exist.

Only health is unauthenticated liveness. Browser and managed authentication are
explicit startup modes; there is no query token or unauthenticated fallback.
The bundled React client uses the same typed `/api/v1` boundary and does not
reconstruct Core decisions.

Both Inventory routes return the browser-safe Core Inventory DTO. The full route
refreshes every registered bounded source; the targeted route accepts one exact
registered adapter ID. A source failure remains a typed partial or failed result
inside the successful transport envelope rather than becoming a raw exception.

The Inventory import plan route accepts `candidateIds` plus optional `agentId`,
`dir`, and `intoCollection`. The apply route accepts only the unchanged
`mutationPlan` returned by planning. The bundled client passes that exact plan
between the two routes; it does not refresh, reselect, or reconstruct actions.
The bundled UI starts with Inventory-first onboarding, supports kind, source,
adapter, and state filters over merged provenance, and uses only Core defaults.
It disables import for incomplete Inventory, requires one exact confirmation,
and surfaces stale-plan refresh/replan guidance without a silent retry. A
successful import offers Library and Sync as separate next actions; neither
Inventory review nor import writes an agent target.

The two adoption routes accept only selector/provider metadata or the exact
unchanged `mutationPlan`; unknown plaintext-shaped or provider-operation fields
are rejected before the narrow Core service is called. Planning remains
available without an apply provider capability and makes no provider call.
Apply returns the typed adoption status, including stable orphan cleanup
evidence when Store publication fails. The bundled UI renders the selector and
derived reference name, lets the user choose a supported provider, reviews the
plan, and requires a separate exact confirmation. It contains no secret-value
input or general provider handle.

The superseded `GET /api/v1/discovery`, `POST /api/v1/scan/plan`,
`POST /api/v1/scan/apply`, `POST /api/v1/import/plan`, and
`POST /api/v1/import/apply` routes are removed and return not found. Clients
must use the Inventory routes above; the server does not translate legacy
requests or captured scan plans.

## Custom adapters

User configuration lives in `~/.cellarer/config.json`, or under
`$CELLARER_HOME/config.json` when a custom Store is selected. Prefer typed CLI
operations:

```bash
cellarer agent configure codex --adapter '{"displayName":"Codex Local"}'
cellarer agent reset codex
cellarer agent add my-agent \
  --adapter '{"displayName":"My Agent","rules":{"project":"{dir}/AGENTS.md","format":"markdown"}}'
cellarer agent update my-agent \
  --adapter '{"displayName":"My Agent","rules":{"project":"{dir}/AGENTS.md","format":"markdown"}}'
cellarer agent remove my-agent
```

A committed Custom Agent add or update (including the bundled UI's upsert)
remains a successful Store mutation even when its one post-commit targeted
Inventory refresh is partial or failed. CLI, local API, and the Agents UI expose
that refresh as a separate result; they do not roll back, retry, or import.
After fixing the reported source issue, retry explicitly:

```bash
cellarer inventory refresh --agent <id>
```

Built-in patches live in `adapterOverrides`; new agents live in
`customAdapters`. A custom adapter declares at least one of rules, MCP, or
skills. It may define explicit detection paths. Without them, project detection
uses the project root; global detection uses the parent of the first declared
rules, MCP, or skills path. MCP support also declares the exact
`supportedSecretReferences` its target consumes natively. An empty list blocks
all secret-backed MCP values instead of materializing plaintext.

Path templates are deliberately small:

| Template | Meaning |
| --- | --- |
| `~` or `~/...` | Home-relative global path. |
| `{dir}` | Explicit project root. |
| relative path | Resolved under the current managed root. |

Expanded paths must stay within the selected managed root. MCP dialect options
can describe field shapes such as command arrays, `environment`, or
`serverUrl`; they do not translate secret-reference tokens.

Current generic-renderer compatibility:

| Built-in | Reference support |
| --- | --- |
| Claude Code | Exact `${ENV_VAR}` environment references. |
| Gemini CLI | Exact `${ENV_VAR}` environment references. |
| Codex, Cursor, OpenCode, Windsurf | None until target-specific translation is implemented and verified. |
| All built-ins | No `${CELLARER_SECRET:name}` support. |

Start from the maintained examples:

- [Basic directory layout](../examples/adapters/acme-agent.example.json)
- [MCP field dialects](../examples/adapters/quirky-agent.example.json)

When paths plus standard JSON/TOML codecs are insufficient, extend the shared
schema or codec boundary instead of embedding special behavior in CLI or Web.

## Development and release

The monorepo uses pnpm and Node.js `>=20.19`:

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
node packages/cli/dist/bin.js --help
```

For behavior changes, keep Core, CLI, Web, tests, public docs, and relevant
OpenSpec capability requirements aligned. Public documentation changes update
English and Simplified Chinese together.

The first stable public package set is `0.1.0`:

- `@cellarer/core`: runtime logic and packaged adapter configuration;
- `@cellarer/web`: server output and built dashboard assets;
- `@cellarer/cli`: the `cellarer` executable.

The workspace root remains private. Registry publication has not been performed
from this repository. After a separately authorized publication, install the CLI
package and invoke its direct executable with:

```bash
npm install --global @cellarer/cli
cellarer --version
cellarer init
```

Release readiness is tested on Node 20.19 across Ubuntu, macOS, and Windows
using clean packed artifacts, command-path resolution, and isolated Store/home
paths:

```bash
pnpm version:check -- 0.1.0
pnpm artifact:pack
CI=true pnpm release:readiness
```

These commands build, inspect, install, and exercise local tarballs. They do not
publish packages, create tags or releases, change dist-tags, deploy, or mutate
any remote service. Publication remains a separately authorized action.
