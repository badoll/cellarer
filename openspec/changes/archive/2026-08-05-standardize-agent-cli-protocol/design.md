## Context

Core already exposes useful structured models, but CLI commands mix terminal formatting, prompts, partial JSON support, and command-specific errors. Agents need a contract that can be validated without importing the TypeScript packages. This change consumes the typed results introduced by the ordered safety changes while keeping CLI parsing and presentation thin.

## Goals / Non-Goals

**Goals:**

- Give every command deterministic non-interactive behavior.
- Make machine output self-describing, versioned, and schema-validatable.
- Separate protocol stdout from diagnostics on stderr.
- Stabilize coarse exit classes and precise error codes.
- Support structured requests too large or sensitive for argv.
- Allow agents to discover commands, schemas, and supported protocol versions locally.

**Non-Goals:**

- Rewriting Core or CLI in another language.
- Requiring an MCP server for local automation.
- Replacing ergonomic text output for human users.
- Adding missing resource/agent operations; that belongs to `complete-cli-control-plane`.
- Guaranteeing indefinite compatibility before a protocol version is declared stable.

## Decisions

### Use one versioned result envelope

JSON mode emits exactly one object with `protocolVersion`, `command`, `requestId`, `status`, `data`, `warnings`, and optional typed `error`. JSONL mode emits versioned event envelopes followed by exactly one terminal result envelope. Fields absent by contract are omitted rather than changing type between commands.

Command payload schemas remain command-specific and are referenced by stable schema IDs. This avoids a vague universal `data` object while retaining one transport envelope.

### Keep machine stdout pure

In JSON/JSONL modes stdout contains protocol records only. Progress, colors, prompts, banners, and debug logs are disabled. Optional diagnostics go to stderr and must obey secret redaction; a structured failure is still emitted to stdout before a nonzero exit.

Text mode retains current human presentation and may use stderr for errors.

### Make non-interactive behavior explicit and implied by machine input

`--non-interactive` forbids prompts and fails with `INPUT_REQUIRED` when information is missing. `--output json|jsonl`, redirected stdin used by `--input -`, or a non-TTY execution implies non-interactive behavior unless a command has no prompt path.

No command falls back to defaults that would broaden a mutation when required selection or confirmation is absent.

### Accept structured input from file or stdin

`--input <path|->` carries a versioned command request validated before Core invocation. Command name remains in argv for auditable routing. Flags may select transport concerns such as output/debug, but command-domain fields cannot be supplied from both argv and the request object; ambiguity is rejected.

Secret bytes use the protected channels defined by `enforce-reference-only-secrets`, not ordinary request JSON.

### Define coarse exit classes and precise error codes

Exit codes are: `0` success, `2` usage or input-schema failure, `3` policy or domain validation failure, `4` lock/revision/target conflict, `5` execution or partial failure, `6` recovery required, and `70` unexpected internal failure. Stable string error codes carry precise meaning within those classes.

### Generate discovery from the command registry

One typed command registry drives parsing metadata, `capabilities`, schema export, and tests. `cellarer capabilities --output json` reports protocol versions, commands, mutability, streaming support, input/output schema IDs, and required features. `cellarer schema` returns a selected schema or a local bundle.

The CLI version comes from build/package metadata injected once, not a hard-coded command string.

## Risks / Trade-offs

- [Schemas can freeze accidental payload details] → Version schema IDs and expose only intentional public Core DTOs.
- [Dual text and machine presentation can diverge] → Render both from the same command result and test protocol fixtures separately from snapshots.
- [JSONL consumers can see truncated streams after process death] → Require a terminal record for completion and let absence mean interrupted transport.
- [Exit codes are too coarse for every failure] → Keep exit classes small and use stable typed error codes for exact branching.

## Migration Plan

1. Introduce the envelope, command registry, schema bundle, exit mapper, and protocol test harness.
2. Convert read-only commands and establish stdout/stderr golden tests.
3. Convert plan/apply/revert/secret/recovery commands and remove prompt fallback in machine mode.
4. Add discovery commands and package-derived version reporting.
5. Remove ad hoc JSON shapes and update all synchronized CLI docs/examples.

Because the package is unreleased, old machine output is replaced rather than maintained behind a compatibility flag. Human command aliases may remain only when they do not weaken the protocol.

## Open Questions

None. Protocol stability policy and deprecation windows can be formalized as part of the first public release.
