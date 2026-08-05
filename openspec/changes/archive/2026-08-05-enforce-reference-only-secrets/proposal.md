## Why

cellarer can currently permit resolved plaintext in generated configuration, accepts a secret value as a positional CLI argument, and does not apply one recursive secret guard to every staged artifact. A local-first manager must make secret non-disclosure an invariant rather than a caller-selected mode before more automation surfaces are added.

## What Changes

- Enforce reference-only generated outputs: `${ENV_VAR}` or `${CELLARER_SECRET:name}` may be written, resolved secret values may not.
- Remove the global escape hatch that permits resolved plaintext in generated targets.
- Add recursive staged-output scanning, value-aware redaction, and a final pre-write guard for Rules, MCP, Skills, plans, receipts, logs, errors, and API responses.
- Make vault/keychain mutations atomic, permission-restricted, and part of the transactional store protocol.
- Replace positional secret values with hidden interactive input or explicit stdin/file-descriptor input that is safe for non-interactive agents.
- Verify required references without exposing their values and block adapters that cannot operate without plaintext materialization.
- Require independently provisioned, domain-separated mutation authorization for externally supplied plans and durable recovery journals; self-digests remain integrity evidence only.
- **BREAKING**: configurations or adapters that require cellarer to write a resolved secret are rejected instead of enabled by `allowResolvedPlaintext`.
- **BREAKING**: unsigned plans and journals, authority records from another store, and records sealed by a missing or rotated authority are rejected rather than accepted through legacy compatibility.

## Capabilities

### New Capabilities
- `reference-only-secret-safety`: End-to-end secret reference preservation, recursive leak prevention, safe secret input/storage, redaction, and reference verification.

### Modified Capabilities

None. This repository does not yet contain accepted capability specs to modify.

## Impact

This change follows `add-transactional-change-protocol` and affects Core secret resolution, planners/renderers, staged writes, vault/keychain adapters, the mutation plan and journal schemas, `Env`, CLI/Web composition roots, CLI secret commands, Web API serialization, logs, and security documentation. It reuses the existing OS-keychain dependency for persistent mutation authority, permits an explicit protected environment channel for headless automation, adds no production dependency, removes unreleased compatibility paths, and requires regression tests proving both plaintext non-disclosure and zero-interaction rejection of unauthenticated mutations.
