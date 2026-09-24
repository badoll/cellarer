## Why

The current Web UI presents Dashboard, Inventory, three resource-type pages, Profiles, Agents, and Settings as similar destinations. A new user must understand Cellarer's internal nouns before knowing whether to discover, organize, sync, or inspect an Agent. The previous concept overcorrected toward a first-use landing page; this change makes the normal, recurring management workflow the default. Labels such as “受管资源” and “内容库” also obscure that Skills, MCP server definitions, and Rules are different kinds of reusable Agent configuration.

## What Changes

- Make a persistent management workbench with six primary destinations: Overview, Agent Config Library, Sync, Agents, Operation History, and Settings. Keep discovery, Profiles, recovery, and all currently supported resource actions reachable within that hierarchy.
- Use **Agent 配置库** as the user-facing umbrella for stored Skills, MCP server definitions, and Rules. Keep each type visible and keep Core `Resource`, `Store`, `Collection`, and `Deployment` identifiers and semantics unchanged. Use “分组” for user-facing Collection membership.
- Make the library a searchable, filterable list and detail workspace. Show source and Store revision, group membership, target usage, and actionable states separately; provide exact multi-selection and contextual actions without relying on a first-run stepper.
- Put local discovery and exact Store import behind “查找已有配置”; show a conditional empty state when the library is empty. Tie “添加配置” to the existing validated bundle-import contract without implying a direct editor, automatic discovery import, or target sync.
- Make Sync a target-first workspace that names the Agent, scope, selected configuration or Profile, and actual Core plan changes before confirmation. Separate source updates, Store edits, target sync differences, configuration verification, and unknown native loading.
- Make operation receipts, failures, recovery, and historical actions findable from Operation History, while Overview summarizes only real counts and next actions from current evidence.
- Provide coherent Simplified Chinese and English UI labels, keyboard and narrow-screen access, and aligned public documentation.

This change does not add resource kinds, change adapters or target formats, start MCP servers, change Inventory coverage, mutate local sources during discovery, auto-import, auto-sync, or introduce a new mutation protocol. The concept image is a visual reference, not a pixel specification or source of sample counts.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `human-resource-workflows`: A management-oriented Web information architecture, Agent Config Library, discovery entry, target-first Sync and Agent journeys, honest status, and findable operation/recovery paths.
- `web-sync-selection`: View filters no longer silently authorize a sync scope; explicit resource, group, Profile, or Store-default intent remains bound to the exact reviewed plan.

## Impact

Bundled React client navigation, resource and Inventory presentation, Sync dialogs and selection state, Agent/Profile and activity surfaces, focused Web tests, and English/Chinese public documentation. Existing `/api/v1` routes and Core DTOs remain the authority; the change is expected to need no new endpoint or production dependency. Existing Store contents, Collection identifiers, plans, receipts, target ownership, and CLI behavior remain compatible.

## Execution Contract

- Risk: high
- Depends on: stabilize-first-use-inventory-flow
- Allowed paths: `packages/web/client/**`, `packages/web/tests/**`, `docs/README.md`, `docs/README.zh-CN.md`, `README.md`, `README.zh-CN.md`, `openspec/changes/redesign-web-agent-config-workbench/**`
