## Why

Core's intended boundaries are stronger than its current dependency graph: secret resolution participates in a transaction cycle, some path helpers can consult ambient cwd, temporary publication identity is module-global, and callers sometimes depend on human error text. These hidden inputs make security properties harder to prove and future Inventory work easier to couple incorrectly.

## What Changes

- Make path roots, operation identity, clock, and temporary-name generation explicit injected runtime context rather than ambient process or module state.
- Replace control decisions based on human-readable messages or action reasons with closed typed discriminants and exhaustive mappings.
- Break the `store-mutation` / active-secret-values / vault dependency cycle by separating provider reads, provider writes, and transaction orchestration.
- Decompose `real-env.ts` behind the existing `Env` contract into focused filesystem, platform, process, credential, and mutation-authority adapters.
- Add dependency and forbidden-import tests; preserve all public CLI/API behavior and existing plan/apply semantics.
- Do not redesign the mutation kernel, secret model, or `Env` public capability set in this change.

## Capabilities

### New Capabilities

- `core-runtime-boundaries`: Define explicit runtime inputs, typed domain outcomes, acyclic security dependencies, and testable composition constraints inside Core.

### Modified Capabilities

None.

## Impact

- Core filesystem safety, atomic publication, secret providers, Store mutation protocol, `Env`, and real environment composition.
- Focused fake-Env, cross-platform path, dependency-graph, and observable-error tests.
- No user-visible command, Store-format, or API-contract change.
