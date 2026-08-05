## Why

The CLI is currently optimized for terminal presentation and exposes inconsistent command-specific shapes, which makes automation depend on prose parsing and prompt behavior. Keeping TypeScript/Node is the right implementation choice, but the external command contract must be stable, discoverable, and language-neutral so developer agents can safely drive cellarer.

## What Changes

- Define one versioned CLI result envelope and JSON Schema for success, warnings, typed errors, plans, and operation receipts.
- Add global `--output text|json|jsonl`, `--non-interactive`, and structured `--input <path|->` behavior with consistent precedence.
- Reserve stdout for protocol data in machine modes and stderr for diagnostics; disable color, spinners, prompts, and incidental logs.
- Define stable exit-code classes and stable error codes independent of localized human messages.
- Add `cellarer capabilities` and `cellarer schema` discovery commands plus an accurate package-derived `--version`.
- Make every existing command honor the same non-interactive and output contract, including dry-run/apply/revert/recovery.
- **BREAKING**: replace ad hoc JSON output and prompt fallback with the versioned protocol; machine mode fails when required input is missing.

## Capabilities

### New Capabilities
- `agent-cli-protocol`: Versioned machine input/output, stream discipline, error/exit semantics, capability discovery, and deterministic non-interactive execution.

### Modified Capabilities

None. This repository does not yet contain accepted capability specs to modify.

## Impact

This change follows the Core safety changes and affects `@cellarer/cli`, shared public result/error types in `@cellarer/core`, command tests, snapshots, shell completion, and public CLI documentation. The implementation remains TypeScript/Node; no MCP wrapper or language rewrite is required for the stable command protocol.
