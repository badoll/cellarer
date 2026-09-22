import type { Deployment, DeploymentState, Ledger, TargetOwner } from "../model/index.js";
import { scanTextForSecrets } from "../secrets/detector.js";
import {
  assertNoSecretValues,
  containsObservableKnownValue,
  type SecretValue,
  serializeObservable,
} from "../secrets/observable.js";
import {
  consumerKey,
  makeDeployment,
  physicalTargetKey,
  projectDeployment,
  validateDeploymentState,
} from "./model.js";

export function deploymentLedger(value: unknown): Ledger {
  const state = validateDeploymentState(value);
  return { version: 3, owners: state.deployments.flatMap((record) => projectDeployment(record)) };
}

export function deploymentState(owners: readonly TargetOwner[]): DeploymentState {
  const records = new Map<string, Deployment>();
  for (const owner of owners) {
    if (!owner.deploymentRoot) throw new TypeError("deployment projection is missing its root");
    if (
      owner.scope === "project"
        ? owner.projectRoot !== owner.deploymentRoot
        : owner.projectRoot !== undefined
    )
      throw new TypeError("consumer projection root is inconsistent");
    const key = physicalTargetKey(owner.target);
    const consumer = {
      agent: owner.agent,
      scope: owner.scope,
      root: owner.deploymentRoot,
      capability: owner.capability,
      kind: owner.syncProfile ? ("profile" as const) : ("ad-hoc" as const),
      ...(owner.syncProfile ? { profile: owner.syncProfile } : {}),
    };
    const incoming = makeDeployment({
      id: owner.deploymentId,
      key,
      target: owner.target,
      root: owner.deploymentRoot,
      capability: owner.capability,
      receipt: owner.receipt,
      artifactIds: owner.artifactIds,
      ...(owner.secretRefs ? { secretRefs: owner.secretRefs } : {}),
      itemAttribution: "unknown",
      consumers: [consumer],
    });
    const prior = records.get(key);
    if (!prior) {
      records.set(key, incoming);
      continue;
    }
    if (
      JSON.stringify({ ...prior, consumers: [] }) !== JSON.stringify({ ...incoming, consumers: [] })
    ) {
      throw new TypeError("inconsistent physical deployment projections");
    }
    if (prior.consumers.some((existing) => consumerKey(existing) === consumerKey(consumer)))
      throw new TypeError("duplicate deployment consumer");
    prior.consumers.push(consumer);
  }
  return validateDeploymentState({ version: 3, deployments: [...records.values()] });
}

export function serializeDeploymentState(
  value: DeploymentState,
  knownValues: readonly SecretValue[] = [],
): string {
  assertNoSecretValues(value, "state");
  const state = validateDeploymentState(value);
  const ordinary = {
    ...state,
    deployments: state.deployments.map(({ secretRefs: _secretRefs, ...record }) => record),
  };
  const checked = JSON.parse(serializeObservable("state", ordinary, { knownValues, pretty: true }));
  if (JSON.stringify(checked) !== JSON.stringify(ordinary))
    throw new TypeError("active secret value is not allowed in deployment state");
  for (const record of state.deployments)
    for (const name of record.secretRefs ?? []) {
      if (containsObservableKnownValue(name, knownValues) || scanTextForSecrets(name).length > 0)
        throw new TypeError("active secret value is not allowed in deployment state");
    }
  return `${JSON.stringify(state, null, 2)}\n`;
}
