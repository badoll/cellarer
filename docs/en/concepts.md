# Concepts

[Documentation index](../README.md) | [简体中文](../zh-CN/concepts.md)

## Store

The store is the single local source of truth. By default it lives at
`~/.cellarer`; `CELLARER_HOME` can point to another store.

Typical layout:

```text
~/.cellarer/
├── store/
│   ├── rules/
│   ├── mcp/
│   └── skills/
├── config.json
├── state.json
└── secrets/
```

## Artifact

An artifact is one distributable unit:

- a rule file or rule fragment
- one canonical MCP server definition
- one skill directory

## Channel

Channels classify artifacts by context. Common examples are `common` and
`internal`. Distribution can filter by one channel.

## Agent Adapter

An adapter knows where an agent stores rules, MCP servers, and skills. The base
adapter list ships with the package. `config.json` stores keyed overrides for
built-ins and custom adapters for new agents.

## Scope

Scope decides where artifacts land:

- `global`: the agent's home-directory configuration
- `project`: a specific project directory passed with `--dir`

## Plan and Apply

Distribution is split into two phases:

- plan: compute actions and previews
- apply: execute the plan and write the ledger

`--dry-run` returns the plan only.

## Ledger

`state.json` records applied targets, methods, checksums, backups, and secret
references. `status` and `revert` use this ledger.

## Secrets

Store artifacts and generated files should not contain plaintext secrets.
Artifacts should use environment references such as `${OPENAI_API_KEY}` or
cellarer secret references such as `${CELLARER_SECRET:OPENAI_API_KEY}`.

## Non-goals

cellarer does not run an MCP proxy, host a cloud registry, manage agent
installation, or provide a multi-user service.
