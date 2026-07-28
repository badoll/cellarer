## 1. Ownership Model and Fixtures

- [x] 1.1 Add failing Core tests for target-keyed ownership, duplicate physical owners, and ambiguous legacy state
- [x] 1.2 Introduce the versioned target ownership schema, canonical target key, contributing artifact IDs, and applied receipts
- [x] 1.3 Add a pre-release state reset or provably safe migration diagnostic to doctor

## 2. Target Classification

- [x] 2.1 Add failing tests for absent, owned-current, owned-drifted, unowned-existing, and invalid-owner classifications
- [x] 2.2 Implement target inspection and content or directory fingerprinting through `Env`
- [x] 2.3 Normalize adapter-resolved paths and reject unsafe ancestor symlink or out-of-bound ownership matches

## 3. Safe Planning and Placement

- [x] 3.1 Update Rules, MCP, and Skill planners to emit one target-keyed action with ownership evidence and typed conflicts
- [x] 3.2 Remove unconditional Skill destination clearing from the ordinary placement path
- [x] 3.3 Add explicit unowned-target replacement and drift-override inputs bound to the exact target receipt
- [x] 3.4 Create and record permission-restricted encrypted file or directory snapshots before approved replacements without persisting plaintext payloads

## 4. Drift-Aware Revert

- [x] 4.1 Add failing tests for revert preview, target deduplication, drift blocking, exact acknowledgement, and snapshot restoration
- [x] 4.2 Implement Core revert planning with expected receipts, current classifications, snapshot availability, and proposed actions
- [x] 4.3 Make revert apply consume the planned acknowledgements, mutate each physical target once, and update ownership only after success
- [x] 4.4 Expose ownership conflicts and revert plans through thin CLI and Web response shapes

## 5. Verification and Documentation

- [x] 5.1 Add end-to-end fixtures covering unmanaged same-name Skills, aggregate MCP selection changes, plaintext-containing targets, and failed snapshot encryption
- [x] 5.2 Document the ownership model, explicit replacement behavior, and pre-release state reset procedure in synchronized public docs
- [x] 5.3 Run the relevant Core, CLI, and Web tests, then run `pnpm lint`, `pnpm typecheck`, and `pnpm build`
