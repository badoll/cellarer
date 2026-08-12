import { join } from "node:path";
import { ControlPlaneValidationError } from "./control-plane-validation.js";
import type { Env } from "./env.js";
import type { CanonicalJsonObject } from "./protocol/models.js";
import {
  planStorePublicationMutation,
  type StorePublicationMutationPlan,
} from "./protocol/store-mutation.js";
import { activeSecretPublicationGuard } from "./secrets/publication-guard.js";
import {
  type CellarerConfig,
  CONFIG_FILENAME,
  parseConfig,
  parseConfigValue,
} from "./store/config.js";

interface ConfigMutationOptions {
  readonly storeRoot: string;
  readonly mutationKind: string;
  readonly changedFields: readonly string[];
  readonly provenancePaths?: readonly string[];
  readonly normalizedInputs?: CanonicalJsonObject;
}

type PrepareConfigMutation = () => Promise<CellarerConfig>;

export async function planConfigMutation(
  env: Env,
  options: ConfigMutationOptions,
  prepare: PrepareConfigMutation,
): Promise<StorePublicationMutationPlan<CellarerConfig>> {
  return planStorePublicationMutation(
    env,
    options.storeRoot,
    "settings",
    options.mutationKind,
    configPublication(options.storeRoot, prepare),
    configMutationBindings(options),
  );
}

export function validateConfigPublication(data: string): void {
  try {
    parseConfig(data);
  } catch {
    throw invalidConfigPublication();
  }
}

export function validateDerivedConfig(value: unknown): CellarerConfig {
  try {
    return parseConfigValue(value);
  } catch {
    throw invalidConfigPublication();
  }
}

function configPublication(storeRoot: string, prepare: PrepareConfigMutation) {
  return async () => {
    const config = validateDerivedConfig(await prepare());
    return {
      value: config,
      publications: [
        {
          path: join(storeRoot, CONFIG_FILENAME),
          data: `${JSON.stringify(config, null, 2)}\n`,
          mode: 0o600,
        },
      ],
    };
  };
}

function configMutationBindings(options: ConfigMutationOptions) {
  return {
    provenancePaths: options.provenancePaths ?? [join(options.storeRoot, CONFIG_FILENAME)],
    normalizedInputs: { ...(options.normalizedInputs ?? {}), changedFields: options.changedFields },
    selfContainedPublications: true,
    secretPublicationGuard: activeSecretPublicationGuard,
    validatePublications: (publications: readonly { readonly data: string }[]) => {
      for (const publication of publications) validateConfigPublication(publication.data);
    },
  } as const;
}

function invalidConfigPublication(): ControlPlaneValidationError {
  return new ControlPlaneValidationError(
    "control-plane mutation produced an invalid config publication",
    { reason: "INVALID_CONFIG_PUBLICATION" },
  );
}
