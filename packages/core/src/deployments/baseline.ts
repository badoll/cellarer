import { isAbsolute, join, normalize } from "node:path";
import { loadRegistry } from "../adapters/registry.js";
import type { Env } from "../env.js";
import type { ManagedContribution } from "../model/index.js";
import {
  assertCurrentMutationAuthorityScope,
  canonicalJson,
  withCurrentMutationAuthorityScope,
} from "../protocol/canonical.js";
import { invalidPlanResult } from "../protocol/execute.js";
import type { MutationPlan } from "../protocol/models.js";
import { diagnoseMutationRecovery } from "../protocol/recovery.js";
import {
  applyStorePublicationPlan,
  planStorePublicationMutation,
} from "../protocol/store-mutation.js";
import { activeSecretPublicationGuard } from "../secrets/publication-guard.js";
import { sha256 } from "../store/checksum.js";
import { loadLedger } from "../store/ledger.js";
import { fingerprintTarget } from "../target-ownership.js";
import { canonicalDeploymentTarget, validateDeploymentState } from "./model.js";
import { deploymentState, serializeDeploymentState } from "./state.js";

function storePath(root: string): string {
  if (!isAbsolute(root)) throw new TypeError("Store root must be absolute");
  return join(normalize(root), "state.json");
}

export interface DeploymentBaselineOptions {
  storeRoot: string;
  deploymentId: string;
  selectors: readonly string[];
}

async function prepareBaseline(env: Env, opts: DeploymentBaselineOptions) {
  const { storeRoot, deploymentId, selectors } = opts;
  if (!selectors.length || new Set(selectors).size !== selectors.length)
    throw new TypeError("baseline requires unique explicit selectors");
  const ledger = await loadLedger(env, storeRoot);
  if (ledger.version !== 3) throw new TypeError("baseline requires deployment state");
  const state = deploymentState(ledger.owners);
  const record = state.deployments.find((item) => item.id === deploymentId);
  if (!record || record.capability !== "mcp")
    throw new TypeError("baseline requires an existing MCP deployment");
  if (record.itemAttribution === "known")
    throw new TypeError("baseline is only for unknown historical attribution");
  await canonicalDeploymentTarget(env, record.target, record.root);
  const fingerprint = await fingerprintTarget(env, record.target);
  if (fingerprint !== record.receipt.fingerprint) throw new TypeError("baseline target drifted");
  const adapter = (await loadRegistry(env, storeRoot)).get(record.consumers[0]?.agent ?? "");
  if (!adapter?.mcp) throw new TypeError("missing MCP adapter");
  const decoded = adapter.mcp.codec.decode(
    await env.fs.readFile(record.target),
    adapter.mcp.serversKey,
  );
  const contributions: ManagedContribution[] = [...selectors].sort().map((selector) => {
    if (!Object.hasOwn(decoded.servers, selector)) throw new TypeError("baseline selector missing");
    return {
      selector,
      fingerprint: sha256(canonicalJson(decoded.servers[selector])),
      resourceIds: [],
      provenance: "local-baseline",
    };
  });
  record.itemAttribution = "known";
  record.contributions = contributions;
  const targetEvidence = {
    deploymentId,
    selectors: [...selectors].sort(),
    target: record.target,
    fingerprint,
  };
  return { state, targetEvidence, data: serializeDeploymentState(state) };
}

export async function planDeploymentBaseline(env: Env, opts: DeploymentBaselineOptions) {
  const path = storePath(opts.storeRoot);
  // Diagnosis takes its own authority lease; never nest it inside another lease.
  // The mutation kernel checks recovery again before authorizing publication.
  if ((await diagnoseMutationRecovery(env, opts.storeRoot)).status !== "clean")
    throw new TypeError("deployment baseline requires clean recovery");
  return withCurrentMutationAuthorityScope(env, async (scope) => {
    const authorityLease = await assertCurrentMutationAuthorityScope(env, scope);
    // Evidence is captured again inside the stable-revision observer below.
    const initial = await prepareBaseline(env, opts);
    return planStorePublicationMutation(
      env,
      opts.storeRoot,
      "settings",
      "deployment-baseline",
      async () => {
        const prepared = await prepareBaseline(env, opts);
        if (
          prepared.data !== initial.data ||
          canonicalJson(prepared.targetEvidence) !== canonicalJson(initial.targetEvidence)
        )
          throw new TypeError("baseline evidence changed while planning");
        return {
          value: prepared.state,
          publications: [{ path, data: prepared.data, mode: 0o600 }],
        };
      },
      {
        provenancePaths: [path],
        selfContainedPublications: true,
        normalizedInputs: {
          changedFields: ["deployments"],
          targetEvidence: initial.targetEvidence,
        },
        secretPublicationGuard: activeSecretPublicationGuard,
        validateFinalPublicationBytes: (publication, knownValues) => {
          if (
            serializeDeploymentState(
              validateDeploymentState(JSON.parse(publication.data)),
              knownValues,
            ) !== publication.data
          )
            throw new TypeError("invalid deployment publication");
        },
      },
      { authorityLease },
    );
  });
}

export async function applyDeploymentBaselinePlan(
  env: Env,
  plan: MutationPlan,
  opts: DeploymentBaselineOptions,
) {
  const path = storePath(opts.storeRoot);
  return withCurrentMutationAuthorityScope(env, async (scope) => {
    const authorityLease = await assertCurrentMutationAuthorityScope(env, scope);
    return applyStorePublicationPlan(env, opts.storeRoot, plan, {
      operation: "settings",
      allowedMutationKinds: ["deployment-baseline"],
      requiredTarget: path,
      requiredProvenancePathsByMutationKind: { "deployment-baseline": [path] },
      requiredNormalizedInputKeys: ["targetEvidence"],
      authorityLease,
      secretPublicationGuard: activeSecretPublicationGuard,
      validatePublicationData: (data) => {
        validateDeploymentState(JSON.parse(data));
      },
      validateFinalPublicationBytes: (publication, knownValues) => {
        if (
          serializeDeploymentState(
            validateDeploymentState(JSON.parse(publication.data)),
            knownValues,
          ) !== publication.data
        )
          throw new TypeError("invalid deployment publication");
      },
      validatePlanUnderLock: async (lockedPlan, publication) => {
        try {
          const expected = await prepareBaseline(env, opts);
          return publication.data === expected.data &&
            canonicalJson(lockedPlan.normalizedInputs.targetEvidence) ===
              canonicalJson(expected.targetEvidence)
            ? null
            : invalidPlanResult();
        } catch {
          return invalidPlanResult();
        }
      },
    });
  });
}
