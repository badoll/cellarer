## Context

Core already routes most I/O through `Env`, but several seams remain implicit: path helpers can resolve against ambient cwd, atomic temporary names use a module counter, secret provider reads and vault writes participate in a dependency cycle through Store mutation, and some boundary behavior is encoded only in strings. These weaknesses are especially risky before adding a cross-adapter Inventory and more mutation operations.

## Goals / Non-Goals

**Goals:**

- Make every runtime-dependent decision injectable and deterministic in tests.
- Make domain outcomes closed, typed, and exhaustively mapped.
- Restore an acyclic dependency direction from domain policy to ports to runtime adapters.

**Non-Goals:**

- Do not replace `Env`, the mutation kernel, secret references, or public error codes.
- Do not combine this refactor with Inventory behavior.

## Decisions

### Strengthen `Env` by composition, not a breaking replacement

Call sites receive explicit canonical roots and operation-local identity generators. `real-env.ts` becomes a thin composer over focused implementations while the public `Env` interface and fake-Env pattern remain. Passing a new global context object everywhere was rejected because it would obscure least-privilege capability selection.

### Separate secret observation from secret mutation

Provider resolution and vault serialization become ports that do not import Store transaction orchestration. The secret-metadata operation adapter owns the transaction and calls those ports. This breaks the current cycle while preserving the same authority, final-byte, and publication guards. Lazy imports were rejected because they hide rather than remove the architectural cycle.

### Use discriminated unions at decision boundaries

Reasons and failures that affect control flow receive stable codes plus structured details; human messages become presentation-only. Exhaustive `switch` checks map Core results to CLI/API. Free-form strings may remain for diagnostics but cannot authorize, select, compensate, or determine exit/status classes.

### Enforce boundaries mechanically

A dependency test defines allowed Core layers and rejects cycles, Node process access in business modules, and imports from runtime adapters into domain modules. Architectural rules that are not executable tend to decay.

## Risks / Trade-offs

- **[Risk] Mechanical extraction changes security-sensitive ordering.** → Add characterization spies for zero-interaction and exact call order before moving code.
- **[Risk] Error-code expansion leaks internal detail.** → Keep public mappings closed and non-disclosing; internal discriminants need not become transport codes.
- **[Trade-off] More small modules increase navigation cost.** → Split by capability boundary, not one function per file, and retain a thin composition entry point.

## Migration Plan

1. Add dependency, ambient-input, and typed-outcome characterization tests.
2. Extract provider ports and remove the transaction cycle.
3. Make path/identity inputs explicit and migrate callers.
4. Decompose real environment composition and delete superseded helpers.
5. Roll back by restoring adapters behind the unchanged public `Env`; no persisted data changes.

## Open Questions

None.
