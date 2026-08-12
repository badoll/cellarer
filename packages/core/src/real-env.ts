import type { Env } from "./env.js";
import { createRealCredentialAdapter } from "./runtime/credential-adapter.js";
import {
  createRealFilesystemAdapter,
  type SnapshotWorkerRunner,
} from "./runtime/filesystem-adapter.js";
import {
  createRealMutationAuthorityAdapter,
  headlessLifetimeOwnerEndpoint,
} from "./runtime/mutation-authority-adapter.js";
import { createRealProcessPlatformAdapter } from "./runtime/process-platform-adapter.js";
import {
  createRealResourceSourceTransport,
  type ResourceSourceTransportOptions,
} from "./runtime/resource-source-transport-adapter.js";

export interface RealEnvOptions extends ResourceSourceTransportOptions {
  readonly snapshotWorkerRunner?: SnapshotWorkerRunner;
}

export type {
  SnapshotRuntimeSupport,
  SnapshotWorkerRequest,
  SnapshotWorkerRunner,
} from "./runtime/filesystem-adapter.js";
export {
  classifyWindowsSnapshotIdentity,
  SNAPSHOT_WORKER_BUDGET,
  snapshotRuntimeSupport,
} from "./runtime/filesystem-adapter.js";
export { headlessLifetimeOwnerEndpoint };

export function createRealEnv(options: RealEnvOptions = {}): Env {
  const fs = createRealFilesystemAdapter(options.snapshotWorkerRunner);
  return {
    fs,
    ...createRealProcessPlatformAdapter(),
    ...createRealCredentialAdapter(),
    ...createRealMutationAuthorityAdapter(),
    resourceSourceTransport: createRealResourceSourceTransport(fs, options),
  };
}
