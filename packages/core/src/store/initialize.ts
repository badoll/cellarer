import { join } from "node:path";
import type { Env } from "../env.js";
import { emptyDirectoryFingerprint } from "../fs/hashDir.js";
import { readFileOrNull } from "../fs/probe.js";
import { assertSafeAtomicPublicationPath } from "../fs/safety.js";
import { withCurrentMutationAuthorityLease } from "../protocol/canonical.js";
import { targetState } from "../protocol/execute.js";
import { operationReceiptsPath } from "../protocol/journal.js";
import type { OperationResult } from "../protocol/models.js";
import {
  executeStoreActionMutation,
  StoreMutationConflictError,
} from "../protocol/store-mutation.js";
import { sha256 } from "./checksum.js";
import {
  CONFIG_FILENAME,
  initialConfigText,
  packagedConfigText,
  parseConfig,
  parsePackagedConfigForSettings,
} from "./config.js";
import type { InitResult } from "./store.js";

export interface InitializeStoreResult extends InitResult {
  operation: OperationResult;
}

export interface InitializeStoreOptions {
  readonly agentTargets?: readonly string[];
}

export async function initializeStore(
  env: Env,
  storeRoot: string,
  opts: InitializeStoreOptions = {},
): Promise<InitializeStoreResult> {
  // Only protocol scaffolding may precede the mutation lock. Product layout and config are signed
  // actions with journal receipts below.
  await env.fs.mkdir(storeRoot, { recursive: true });
  return withCurrentMutationAuthorityLease(env, async (authorityLease) => {
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
        const configData =
          existingConfig ?? (await initialConfigWithAgentTargets(env, opts.agentTargets));
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
      { authorityLease },
    );
    if (!transaction.operation.ok) {
      throw new StoreMutationConflictError(transaction.operation.conflict);
    }
    return { ...transaction.value, operation: transaction.operation };
  });
}

async function initialConfigWithAgentTargets(
  env: Env,
  agentTargets: readonly string[] | undefined,
): Promise<string> {
  const initialText = await initialConfigText(env);
  if (agentTargets === undefined) return initialText;
  if (new Set(agentTargets).size !== agentTargets.length) {
    throw new TypeError("initial agent targets must be unique");
  }
  const packaged = parsePackagedConfigForSettings(await packagedConfigText(env));
  const builtinIds = Object.keys(packaged.builtinAdapters);
  const known = new Set(builtinIds);
  const unknown = agentTargets.filter((agentId) => !known.has(agentId));
  if (unknown.length > 0)
    throw new TypeError(`unknown initial agent target: ${unknown.join(", ")}`);
  const selected = new Set(agentTargets);
  const config = parseConfig(initialText);
  return `${JSON.stringify(
    {
      ...config,
      adapterOverrides: Object.fromEntries(
        builtinIds.map((agentId) => [
          agentId,
          { ...config.adapterOverrides[agentId], enabled: selected.has(agentId) },
        ]),
      ),
    },
    null,
    2,
  )}\n`;
}
