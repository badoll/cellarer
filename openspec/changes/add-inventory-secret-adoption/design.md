## Context

Ordinary Inventory classifies any probable plaintext secret as `needs-attention` and ordinary import is provider-free. Standard MCP formats, however, contain well-known env, header, argument, or URL fields that can be converted to a reference without rewriting the original source. This crosses source read, protected provider write, and Store publication, so it is isolated from the base path.

## Goals / Non-Goals

**Goals:**

- Support explicit adoption for narrowly recognized MCP fields with zero plaintext observability.
- Preserve exact authority and source preconditions across provider and Store effects.
- Make partial cross-provider failure recoverable and operator-visible.

**Non-Goals:**

- Do not adopt from Rules, Skills, arbitrary custom structures, or ambiguous findings.
- Do not expose provider browsing, plaintext resolution, overwrite, source rewrite, or target writes.

## Decisions

### Use a separate adoption operation

Ordinary refresh/import remains strictly provider-free. Adoption planning is requested for one exact candidate and closed field set. The plan binds candidate/source fingerprint, redacted selector, provider kind, derived reference name, absent-entry precondition, normalized reference-bearing Store publication, and authority. Adding a flag to ordinary import was rejected because it would silently increase its privileges.

### Read plaintext only inside the apply capability

The executable plan contains no value or reversible derivative. After authority and source checks, a narrow provider port reads the exact unchanged local field, creates only the bound absent entry, and returns metadata. The handler, renderer, receipt, journal, and public DTO never receive plaintext.

### Fail closed on existing references

The first version requires the derived provider entry to be absent. It never compares or returns an existing value and never overwrites. Allowing an “equal existing value” optimization was rejected because equality checking expands provider reads and observable timing without being necessary.

### Report, do not silently compensate, an orphan

Provider creation cannot be atomically committed with filesystem Store publication. If the latter fails, the operation records a typed orphaned reference name, provider metadata, and exact cleanup command. Automatic deletion was rejected because compensation could delete a credential whose ownership changed concurrently.

### Inject a capability-shaped port into Web

The local API composition receives only `planInventorySecretAdoption` and `applyInventorySecretAdoption`. It never receives general provider get/list/delete or a raw `SecretStore`.

## Risks / Trade-offs

- **[Risk] Plaintext escapes through an exception or spy.** → Run known-value canaries through final observable guards and assert no value reaches handler arguments or receipts.
- **[Risk] Source field parsing selects the wrong value.** → Bind a closed dialect-aware field selector and revalidate the complete source fingerprint before provider access.
- **[Trade-off] Orphan cleanup is manual.** → Prefer explicit evidence over unsafe cross-system compensation.

## Migration Plan

1. Add supported-field and unsupported-shape matrices plus canary tests.
2. Implement plan construction and the least-privilege provider port.
3. Implement apply ordering and orphan evidence.
4. Expose CLI/API actions only after Core observable and recovery tests pass.
5. Rollback removes adoption surfaces; blocked Inventory candidates and any explicitly created provider entry remain visible for manual cleanup.

## Open Questions

None.
