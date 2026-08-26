# Isolated resource E2E harness

This directory is the only project root and writable runtime boundary used by
the resource end-to-end acceptance test. The harness never points Cellarer at a
real user home or Store.

## Modes

- `fixture` is deterministic and is the default for local runs and CI. It stages
  `test/fixtures/skills-pool` together with the tracked Rules and MCP fixtures.
- `real-pool` is an explicit strict mode. Pass the absolute pool path through
  `CELLARER_E2E_SKILLS_POOL`; the harness copies it without following symbolic
  links and verifies the source fingerprint before and after the run.

Run the complete journey with:

```bash
pnpm e2e:resources
```

Run the strict real-pool variant with:

```bash
CELLARER_E2E_MODE=real-pool \
CELLARER_E2E_SKILLS_POOL=/absolute/path/to/skills \
pnpm e2e:resources
```

Generated state is limited to `test/.sandbox`, `test/.reports`, and the agent
targets `test/.claude`, `test/.agents`, `test/.codex`, `test/.codebuddy`,
`test/CLAUDE.md`, `test/AGENTS.md`, `test/.mcp.json`, and the generated
`test/.gitignore` ownership marker. These paths are ignored and removed by exact
allowlist cleanup; tracked fixtures and tests are retained. Source pools that
overlap their staging destination are rejected before copying.

The first run refuses to delete any pre-existing generated path. Once the
harness establishes `test/.sandbox/harness-owned-v1`, later runs may clean only
the documented allowlist. Removing that marker restores the fail-closed
first-run behavior.

The report is closed structured evidence. It records the mode, phase outcomes,
assertions, and typed skips. It does not contain raw command streams, secret
values, mutation authority, absolute external pool paths, or credentials.

This harness validates Cellarer compatibility through subprocesses and on-disk
artifacts. It does not execute Claude, Codex, CodeBuddy, or any remote MCP
server. `codebuddy-e2e` is a test-only declarative adapter and is not an official
product compatibility claim.
