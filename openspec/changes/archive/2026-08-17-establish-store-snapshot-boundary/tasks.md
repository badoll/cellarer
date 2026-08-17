## 1. Configuration Layout Identity

**Verification:** `CI=true pnpm exec vitest run packages/core/tests/store-snapshot.test.ts -t "layout"`

- [x] 1.1 Add failing fake-Env tests for canonical Store aliases, configuration/revision path parity, containment, and a managed configuration symlink.
- [x] 1.2 Implement the limited immutable `StoreLayout` for canonical identity, configuration, and revision paths without migrating unrelated consumers.

## 2. Revision-Coherent Configuration Snapshot

**Verification:** `CI=true pnpm exec vitest run packages/core/tests/store-snapshot.test.ts -t "coherence"`

- [x] 2.1 Add failing tests for a stable observation, one revision advance followed by success, and repeated drift returning `STALE_STORE_SNAPSHOT`.
- [x] 2.2 Implement immutable `observeStoreConfigSnapshot` with before/after revision checks, one retry, and discarded-attempt isolation.

## 3. Read Safety and Capability Independence

**Verification:** `CI=true pnpm exec vitest run packages/core/tests/store-snapshot.test.ts -t "safety"`

- [x] 3.1 Add failing tests proving a managed configuration symlink is rejected before external content is read and malformed configuration remains a typed read failure.
- [x] 3.2 Prove snapshot construction succeeds without mutation authority or secret-provider capability and exposes references without provider values.

## 4. Representative Control-plane Consumer

**Verification:** `CI=true pnpm exec vitest run packages/core/tests/store-snapshot.test.ts packages/core/tests/control-plane.test.ts -t "config"`

- [x] 4.1 Add DTO-parity and concurrent-drift tests for `showControlPlaneConfig` using the public projected configuration.
- [x] 4.2 Migrate only `showControlPlaneConfig` to the snapshot and export the minimum Core types required for later expansion.

## 5. Change Closure

**Verification:** full repository and OpenSpec gates

- [x] 5.1 Run `CI=true pnpm build`, `CI=true pnpm test`, `CI=true pnpm lint`, `CI=true pnpm typecheck`, `git diff --check`, and `openspec validate establish-store-snapshot-boundary --strict --no-interactive`.
