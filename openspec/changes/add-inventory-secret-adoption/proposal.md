## Why

The base Inventory must safely expose secret-bearing candidates as blocked, but supported MCP fields otherwise require manual source remediation before import. Secret adoption is a valuable high-risk extension and should be introduced only after ordinary refresh and Store import are stable.

## What Changes

- Add an explicit authority-sealed adoption plan for supported MCP secret fields only.
- Bind candidate identity, source fingerprint, redacted field selector, provider kind, derived reference name, and absent-entry precondition without placing plaintext in observable data.
- Apply through a narrow injected adoption capability that reads the unchanged local source, creates only the plan-bound protected entry, and publishes only reference-bearing Store content.
- Refuse overwrites, source drift, unsupported structures, Rules/Skills adoption, and arbitrary provider operations.
- Report typed orphan cleanup evidence if provider creation succeeds but Store publication fails; do not silently delete credentials.
- Expose only exact plan/apply to CLI and the authenticated local API; ordinary Inventory refresh/import remains provider-free.

## Capabilities

### New Capabilities

- `inventory-secret-adoption`: Define the narrow supported-MCP adoption workflow and its cross-provider failure semantics.

### Modified Capabilities

- `reference-only-secret-safety`: Permit explicit plan-bound adoption while retaining zero-plaintext observability and reference-only persistence.
- `local-client-api`: Expose only a narrow adoption plan/apply service, never a general secret provider.
- `agent-cli-protocol`: Define non-disclosing adoption contracts and typed failures.

## Impact

- Inventory findings, MCP field classification, secret providers, mutation authority, Store transaction recovery, CLI, and `/api/v1` composition.
- Depends on ordinary Inventory refresh and Store import; it is intentionally not a prerequisite for replacing `init`.
- No source rewrite, target write, general secret browser, or plaintext API input.
