## 1. Shared Control-Plane DTOs

- [x] 1.1 Inventory Core, CLI, and Web surfaces and add contract tests for resource, agent, collection, config, diff, status, verify, summary, and operation DTOs
- [x] 1.2 Move or add missing application services in Core without importing CLI or Web layers
- [x] 1.3 Register command input/output schemas and capability metadata for the complete surface

## 2. Read-Only Commands

- [x] 2.1 Implement `resource list/show` with kind/source/state filters, provenance, membership, and desired/applied usage
- [x] 2.2 Implement `agent list/show`, `collection list/show`, and `config show/validate`
- [x] 2.3 Implement desired/applied diff, discovery summary, combined verify, and `operation list/show`

## 3. Agent and Configuration Mutations

- [x] 3.1 Add planned built-in enable/disable/configure/reset operations using `adapterOverrides`
- [x] 3.2 Add planned custom adapter add/update/remove operations using `customAdapters` and dependency guards
- [x] 3.3 Add typed non-secret settings update/reset operations through the transaction protocol

## 4. Collections and Exact Selection

- [x] 4.1 Add planned collection create/update/delete and exact membership/default operations
- [x] 4.2 Replace legacy name-only CLI selection with resource IDs or complete kind/name/source selectors
- [x] 4.3 Update init to return detected/configured inventory and require explicit non-interactive agent targets
- [x] 4.4 Add `--dry-run` plan support and operation receipts to every control-plane mutation

## 5. End-to-End Verification and Documentation

- [x] 5.1 Add human and protocol-mode end-to-end tests covering the full multi-agent management journey without Web or file editing
- [x] 5.2 Verify CLI and Web return equivalent shared Core DTO semantics for overlapping operations
- [x] 5.3 Synchronize English and Chinese CLI reference, first-run guide, exact selector examples, and adapter configuration docs
- [x] 5.4 Run relevant Core, CLI, and Web tests, then run `pnpm lint`, `pnpm typecheck`, and `pnpm build`
