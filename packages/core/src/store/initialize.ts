import { join } from "node:path";
import type { Env } from "../env.js";
import { emptyDirectoryFingerprint } from "../fs/hashDir.js";
import { readFileOrNull } from "../fs/probe.js";
import { assertSafeAtomicPublicationPath } from "../fs/safety.js";
import { targetState } from "../protocol/execute.js";
import { operationReceiptsPath } from "../protocol/journal.js";
import type { OperationResult } from "../protocol/models.js";
import {
  executeStoreActionMutation,
  StoreMutationConflictError,
} from "../protocol/store-mutation.js";
import { sha256 } from "./checksum.js";
import { CONFIG_FILENAME, initialConfigText } from "./config.js";
import type { InitResult } from "./store.js";

export interface InitializeStoreResult extends InitResult {
  operation: OperationResult;
}

export async function initializeStore(env: Env, storeRoot: string): Promise<InitializeStoreResult> {
  // Only protocol scaffolding may precede the mutation lock. Product layout and config are signed
  // actions with journal receipts below.
  await env.fs.mkdir(storeRoot, { recursive: true });
  await env.fs.mkdir(operationReceiptsPath(storeRoot), { recursive: true });

  const transaction = await executeStoreActionMutation(
    env,
    storeRoot,
    "initialize",
    "initialize-store",
    async () => {
      const configPath = join(storeRoot, CONFIG_FILENAME);
      const existingConfig = await readFileOrNull(env, configPath);
      const createdConfig = existingConfig === null;
      const configData = existingConfig ?? (await initialConfigText(env));
      const configMode = 0o600;
      const configAction = {
        actionId: sha256(
          JSON.stringify({
            mutationKind: "initialize-store",
            index: 0,
            kind: createdConfig ? "publish-file" : "preserve-file",
            path: configPath,
            digest: sha256(configData),
            mode: configMode,
          }),
        ),
        kind: createdConfig ? "publish-file" : "preserve-file",
        target: configPath,
        payload: {
          path: configPath,
          digest: sha256(configData),
          mode: configMode,
        },
        postcondition: { state: "present" as const, fingerprint: sha256(configData) },
        execute: async () => {
          if (!createdConfig) return;
          await assertSafeAtomicPublicationPath(
            env,
            configPath,
            storeRoot,
            "store initialization config",
          );
          await env.fs.publishFileAtomically(configPath, configData, { mode: configMode });
        },
      };
      const layoutPaths = [
        join(storeRoot, "store", "rules"),
        join(storeRoot, "store", "mcp"),
        join(storeRoot, "store", "skills"),
        join(storeRoot, "store", "metadata", "skills"),
      ];
      const layoutActions = await Promise.all(
        layoutPaths.map(async (path, index) => {
          const before = await targetState(env, path);
          const mode = 0o700;
          return {
            actionId: sha256(
              JSON.stringify({
                mutationKind: "initialize-store",
                index: index + 1,
                kind: "mkdir",
                path,
              }),
            ),
            kind: "mkdir",
            target: path,
            payload: { path },
            postcondition:
              before.state === "present"
                ? before
                : { state: "present" as const, fingerprint: emptyDirectoryFingerprint(mode) },
            execute: async () => {
              await env.fs.mkdir(path, { recursive: true, mode });
            },
          };
        }),
      );
      return {
        value: { storeRoot, createdConfig },
        actions: [configAction, ...layoutActions],
      };
    },
  );
  if (!transaction.operation.ok) {
    throw new StoreMutationConflictError(transaction.operation.conflict);
  }
  return { ...transaction.value, operation: transaction.operation };
}
