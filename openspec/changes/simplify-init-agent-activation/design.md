## Context

Cellarer currently uses `adapterOverrides.<id>.enabled` as a persistent activation filter. Discovery and Dashboard queries fall back to enabled adapters, while distribution planning still requires exact per-operation agents and skips disabled adapters. The state is useful, but `init` currently requires `--agent` even for an interactive TTY and preserves an existing config without checking whether a new requested set was ignored.

The CLI already classifies invocations as interactive or non-interactive from output mode, structured input, `--non-interactive`, and TTY state. Core already owns Store config parsing and initialization. This change must preserve those boundaries, add no production dependency, and keep machine stdout protocol-only.

## Goals / Non-Goals

**Goals:**

- Preserve the enabled-agent set as a persistent activation/default filter.
- Provide a safe first-run human selection path, including zero enabled agents.
- Keep every non-interactive path deterministic and fail-closed.
- Make repeated initialization idempotent only when the requested activation set matches the persisted set.
- Keep prompt effects in CLI composition and config/state validation in Core.

**Non-Goals:**

- Do not distribute resources during `init`.
- Do not weaken exact agent/capability selection for `apply`, `scan`, `revert`, profiles, or other mutations.
- Do not redesign agent inventory states, the control-plane mutation protocol, Dashboard defaults, or mutation authority provisioning.
- Do not add a general prompt framework or a third-party interactive UI dependency.

## Decisions

### Treat activation as a persisted default, not a mutation authorization

The `enabled` flag remains because it gives discovery and presentation a stable default and lets users exclude installed agents they do not manage. Documentation and prompts will call this an activation or enabled set. Exact operation inputs and the common mutation protocol remain the authority for target writes.

Removing `enabled` entirely was rejected because it would make every read surface invent its own default and remove the durable ability to ignore an installed adapter. Keeping the current mandatory flag unchanged was rejected because it adds first-run friction without adding a target write boundary.

### Resolve target intent at the CLI boundary

`init` accepts one of three target-intent sources:

1. `--agent <ids>` for an exact non-empty or shell-provided list;
2. `--no-agent` for an explicit empty set;
3. an injected interactive selector, only when the invocation is text-mode and TTY-interactive.

`--agent` and `--no-agent` are mutually exclusive. Structured requests continue to use the existing `agents` array; `agents: []` is the machine representation of the explicit empty set. JSON, JSONL, structured input, non-TTY input, and `--non-interactive` never invoke the selector and return `INPUT_REQUIRED` with inventory when neither explicit form is present.

The default selector uses Node's built-in readline support, prints the supported inventory with detection state, accepts comma-separated exact IDs, and treats an empty answer as an explicit empty set. The selector is injected into `initCommand` through CLI composition so tests exercise the real command without replacing Core behavior.

A general prompting abstraction was rejected as unnecessary scope. Silently enabling detected agents was rejected because filesystem detection is evidence, not consent.

### Validate first-run and repeated selections in Core

Core exposes one initialization-target validation path used by dry-run and committed initialization. For a missing config it validates supported built-in IDs and permits an empty set. For an existing config it derives the effective enabled set across built-in and custom adapters, compares sets without order sensitivity, and returns a typed selection-conflict error when they differ.

Committed initialization repeats the validation under the Store mutation boundary before preserving or creating config, so a dry-run result is informative but not an authorization token. A matching repeated request remains idempotent and preserves the existing config. A conflicting request performs no config change and directs the caller to planned `agent enable`/`agent disable` operations.

Letting repeated `init` reconfigure agents was rejected because it would bypass the dedicated revisioned agent-mutation surface. Continuing to ignore conflicting input was rejected because successful output would misrepresent the resulting state.

### Preserve protocol and output isolation

Interactive inventory and questions are text-only. Machine modes emit only their existing versioned result envelope. The init structured-input schema keeps `agents` as the canonical field, including an empty array; the argv-only `--no-agent` convenience does not create a second structured representation.

## Risks / Trade-offs

- **[Risk] A blank interactive answer disables every built-in adapter on first run.** → The prompt states that blank means none and initialization does not distribute or delete targets.
- **[Risk] Existing automation relied on a conflicting repeated `init --agent` succeeding while doing nothing.** → Return a typed error with current/requested sets and exact migration commands; matching requests remain idempotent.
- **[Risk] Prompt code accidentally runs in machine mode.** → Gate exclusively on the shared `invocation.nonInteractive` classification and cover JSON, structured, non-TTY, and explicit non-interactive tests.
- **[Risk] CLI validation and committed state diverge.** → Keep authoritative config comparison in Core and repeat it inside committed initialization.
- **[Trade-off] `--no-agent` and structured `agents: []` are different surface spellings.** → They normalize to the same exact empty target set before Core invocation.

## Migration Plan

1. Add the delta requirements and TDD coverage without changing protocol version `1.0`; the existing `agents` array already represents an empty set.
2. Add CLI prompt/no-agent normalization and Core repeated-selection validation.
3. Update both public documentation languages and CLI examples.
4. Existing first-run `init --agent ...` commands continue unchanged. Automation that intentionally initializes with no enabled agents uses `--no-agent` or structured `agents: []`. Automation that changes an initialized set migrates to `agent enable`/`agent disable`.
5. Rollback removes the new selector and conflict validation; existing configs remain valid because their schema is unchanged.

## Open Questions

None. The previously discussed product decision is fixed: keep activation state, simplify human initialization, and retain explicit non-interactive intent.
