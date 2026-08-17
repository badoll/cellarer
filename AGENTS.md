# AGENTS.md — cellarer Engineering Guide

Repository instructions for coding agents. Keep this file short: product usage
and design rationale belong in public documentation; accepted behavior belongs
in OpenSpec.

## Read only what the task needs

- For product context or commands, start with `README.md` (English) or
  `README.zh-CN.md` (中文), then open the relevant section of
  `docs/README.md` or `docs/README.zh-CN.md`.
- Read one language by default. Compare both only when changing public docs.
- Before a behavior change, run `openspec list --json`, read the matching active
  change artifacts, and open only the current specs for the affected capability.
- Do not read `openspec/changes/archive/**` unless the task explicitly asks for
  history or the current artifacts lack required context.

## Architecture invariants

1. **Core first**: business logic belongs in `@cellarer/core`; CLI and Web are
   thin input and presentation shells.
2. **Effects through `Env`**: Core filesystem, home, cwd, platform, environment,
   clock, and secret-store access come from `packages/core/src/env.ts`, not
   direct `process`, `os`, or `node:fs` calls in business logic.
3. **Plan before apply**: mutations first produce an inspectable plan; dry-run
   does not write; apply executes the unchanged authorized plan and records it.
4. **Agents through adapters**: extend `AgentAdapter` or declarative adapter
   config instead of adding agent-ID branches to engines.
5. **Convergent and recoverable**: repeated apply converges; material writes,
   ownership, receipts, and recovery state remain representable in the ledger.
6. **Reference-only secrets**: never persist plaintext secret values in Store
   artifacts, generated targets, logs, responses, argv, or recovery evidence.

## Change workflow

- Preserve unrelated and uncommitted work. Prefer TDD for behavior changes,
  temporary directories, and injected or fake `Env` objects for filesystem tests.
- Keep at most one change in implementation. The controller selects one coherent
  task group and one writer; that writer owns its first repair wave. Planning,
  status, findings, and completion remain in OpenSpec rather than a second plan
  or progress ledger.
- Use focused checks inside a task group. Use one combined review for integration
  work and one adversarial review for high-risk mutation, recovery, ownership, or
  secret work. After one repair wave, re-review only the findings and affected
  paths; if the same Important/Critical class recurs or scope crosses an
  undeclared capability/package/boundary, stop and update the OpenSpec artifacts.
- Superpowers techniques such as TDD and systematic debugging may support the
  selected task. Do not add brainstorming, writing-plans, executing-plans,
  subagent-driven-development, or branch-finishing as parallel workflow controllers
  unless the user explicitly requests them.
- Run the applicable full gate once when closing the change, and repeat it only
  after a final cross-cutting repair:

  ```bash
  pnpm build
  pnpm test
  pnpm lint
  pnpm typecheck
  ```

- OpenSpec is the sole state for planned product or behavior changes:
  `openspec/config.yaml` defines artifact rules, `openspec/specs/**` defines
  accepted behavior, and `openspec/changes/**` holds active work until validated
  and archived. Do not create a parallel roadmap or completion ledger.
- Purely editorial documentation changes do not require an OpenSpec change.
  Keep active artifacts aligned when scope changes; archive only after
  implementation and validation are complete.

## Code and documentation

- TypeScript is ESM + NodeNext: relative source imports use `.js`; use
  `import type` for type-only imports. Names are English. Comments explain why,
  not what the next line already says.
- Public docs are only `README.md`, `README.zh-CN.md`, `docs/README.md`,
  `docs/README.zh-CN.md`, package READMEs, and `examples/adapters/*.json`.
- Keep English and Simplified Chinese docs semantically aligned. Verify CLI
  examples against source and package metadata; label future or release-dependent
  behavior instead of presenting it as available.
- Public docs contain stable user, architecture, security, and maintainer
  guidance—not comparisons, implementation diaries, review logs, or task lists.
