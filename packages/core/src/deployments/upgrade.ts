import { isAbsolute, join, normalize } from "node:path";
import type { Env } from "../env.js";
import type { Deployment } from "../model/index.js";
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
import { loadLedger } from "../store/ledger.js";
import { fingerprintTarget } from "../target-ownership.js";
import { canonicalDeploymentTarget, makeDeployment, validateDeploymentState } from "./model.js";
import { serializeDeploymentState } from "./state.js";

function storePath(root: string): string {
  if (!isAbsolute(root)) throw new TypeError("Store root must be absolute");
  return join(normalize(root), "state.json");
}

async function prepareUpgrade(env: Env, storeRoot: string) {
  const ledger = await loadLedger(env, storeRoot);
  if (ledger.version !== 2) throw new TypeError("deployment upgrade requires a valid v2 ledger");
  const records: Deployment[] = [];
  const targetEvidence: { target: string; fingerprint: string | null }[] = [];
  for (const owner of ledger.owners) {
    const root = owner.scope === "project" ? owner.projectRoot : env.homedir();
    if (!root) throw new TypeError("owner has no canonical root");
    const identity = await canonicalDeploymentTarget(env, owner.target, root);
    targetEvidence.push({
      target: identity.target,
      fingerprint: await fingerprintTarget(env, identity.target),
    });
    records.push(
      makeDeployment({
        ...identity,
        capability: owner.capability,
        receipt: owner.receipt,
        artifactIds: owner.artifactIds,
        ...(owner.secretRefs ? { secretRefs: owner.secretRefs } : {}),
        itemAttribution: "unknown",
        consumers: [
          {
            agent: owner.agent,
            scope: owner.scope,
            root: identity.root,
            capability: owner.capability,
            kind: owner.syncProfile ? "profile" : "ad-hoc",
            ...(owner.syncProfile ? { profile: owner.syncProfile } : {}),
          },
        ],
      }),
    );
  }
  const state = validateDeploymentState({ version: 3, deployments: records });
  return { state, targetEvidence, data: serializeDeploymentState(state) };
}

export async function planDeploymentUpgrade(env: Env, opts: { storeRoot: string }) {
  const path = storePath(opts.storeRoot);
  // Diagnosis takes its own authority lease; never nest it inside another lease.
  // The mutation kernel checks recovery again before authorizing publication.
  if ((await diagnoseMutationRecovery(env, opts.storeRoot)).status !== "clean")
    throw new TypeError("deployment upgrade requires clean recovery");
  return withCurrentMutationAuthorityScope(env, async (scope) => {
    const authorityLease = await assertCurrentMutationAuthorityScope(env, scope);
    // Evidence is captured again inside the stable-revision observer below.
    const initial = await prepareUpgrade(env, opts.storeRoot);
    return planStorePublicationMutation(
      env,
      opts.storeRoot,
      "settings",
      "deployment-upgrade",
      async () => {
        const prepared = await prepareUpgrade(env, opts.storeRoot);
        if (
          prepared.data !== initial.data ||
          canonicalJson(prepared.targetEvidence) !== canonicalJson(initial.targetEvidence)
        )
          throw new TypeError("upgrade evidence changed while planning");
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

export async function applyDeploymentUpgradePlan(
  env: Env,
  plan: MutationPlan,
  opts: { storeRoot: string },
) {
  const path = storePath(opts.storeRoot);
  return withCurrentMutationAuthorityScope(env, async (scope) => {
    const authorityLease = await assertCurrentMutationAuthorityScope(env, scope);
    return applyStorePublicationPlan(env, opts.storeRoot, plan, {
      operation: "settings",
      allowedMutationKinds: ["deployment-upgrade"],
      requiredTarget: path,
      requiredProvenancePathsByMutationKind: { "deployment-upgrade": [path] },
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
          const expected = await prepareUpgrade(env, opts.storeRoot);
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
