import { sha256 } from "../store/checksum.js";
import { canonicalJson } from "./canonical.js";
import type {
  CanonicalJsonObject,
  CanonicalJsonValue,
  MutationOperation,
  MutationPlan,
  OperationResult,
} from "./models.js";

export interface MutationPlanContract {
  readonly id: string;
  readonly operation: MutationOperation;
  readonly mutationKind: string | null;
  readonly allowsEmptyActions: boolean;
  readonly normalizeIntent: (plan: MutationPlan) => CanonicalJsonObject;
  readonly bindProvenance: (plan: MutationPlan) => CanonicalJsonValue | null;
  readonly validateActionSet: (plan: MutationPlan) => boolean;
  readonly prepareEffects: <Prepared>(prepare: () => Prepared) => Prepared;
  readonly projectReceipt: (result: OperationResult) => OperationResult;
}

export interface MutationPlanContractRegistry {
  readonly select: (plan: MutationPlan) => MutationPlanContract | null;
  readonly values: () => readonly MutationPlanContract[];
}

interface ContractDefinition {
  readonly operation: MutationOperation;
  readonly mutationKind?: string;
  readonly allowsEmptyActions?: boolean;
  readonly validateActionSet: (plan: MutationPlan) => boolean;
}

const CONTROL_PLANE_MUTATION_KINDS = [
  "builtin-agent-enable",
  "builtin-agent-disable",
  "builtin-agent-configure",
  "builtin-agent-reset",
  "custom-adapter-add",
  "custom-adapter-update",
  "custom-adapter-remove",
  "custom-adapter-upsert",
  "config-update",
  "config-reset",
  "collection-create",
  "collection-update",
  "collection-delete",
  "collection-set-members",
  "collection-set-defaults",
] as const;

const PROFILE_MUTATION_KINDS = ["profile-create", "profile-update", "profile-delete"] as const;

const definitions: readonly ContractDefinition[] = [
  contract("initialize", "initialize-store", false, (plan) => validateInitializePlan(plan)),
  fixedContract("apply", true, validateApplyPlan),
  fixedContract("revert", true, validateRevertPlan),
  ...[...CONTROL_PLANE_MUTATION_KINDS, ...PROFILE_MUTATION_KINDS].map((mutationKind) =>
    contract("settings", mutationKind, false, validateSettingsPlan),
  ),
  contract("secret-metadata", "vault-update", false, (plan) => validateSecretPublicationPlan(plan)),
  contract("secret-metadata", "vault-secret-set", false, (plan) =>
    validateSecretPublicationPlan(plan),
  ),
  contract("secret-metadata", "vault-secret-delete", false, (plan) =>
    validateSecretPublicationPlan(plan),
  ),
  contract("secret-metadata", "keychain-secret-set", false, (plan) =>
    validateKeychainSecretPlan(plan, "keychain-secret-set"),
  ),
  contract("secret-metadata", "keychain-secret-delete", false, (plan) =>
    validateKeychainSecretPlan(plan, "keychain-secret-delete"),
  ),
  contract("store-import", "add", true, validateAddPlan),
  contract("store-import", "resource-update", false, (plan) => validateResourceUpdatePlan(plan)),
  contract("store-import", "inventory-store-import", false, validateInventoryImportActions),
  contract("store-import", "inventory-secret-adoption", false, (plan) =>
    validateInventoryAdoptionPlan(plan),
  ),
  contract("resource-lifecycle", "resource-local-fork", true, (plan) =>
    validateResourceLifecyclePlan(plan, () =>
      exactKinds(plan, ["install-resource-content", "publish-resource-metadata"]),
    ),
  ),
  contract("resource-lifecycle", "resource-rename", true, (plan) =>
    validateResourceLifecyclePlan(plan, () => validateResourceRenameActions(plan)),
  ),
  contract("resource-lifecycle", "resource-remove-cascade", true, (plan) =>
    validateResourceLifecyclePlan(plan, () => validateResourceRemoveActions(plan)),
  ),
  contract("resource-lifecycle", "resource-remove-ordinary", true, (plan) =>
    validateResourceLifecyclePlan(plan, () => validateResourceRemoveActions(plan)),
  ),
  contract("resource-lifecycle", "resource-export", false, (plan) =>
    validateResourceLifecyclePlan(plan, () => exactKinds(plan, ["write-resource-bundle"])),
  ),
  contract("resource-lifecycle", "resource-bundle-import", false, (plan) =>
    validateResourceLifecyclePlan(plan, () =>
      exactKinds(plan, ["preserve-file", "install-resource-content", "publish-resource-metadata"]),
    ),
  ),
  contract("sync-uninstall", "sync-target-uninstall", true, (plan) =>
    validateSyncUninstallPlan(plan),
  ),
];

const expectedContractKeys = Object.freeze(
  definitions.map(({ operation, mutationKind }) => contractKey(operation, mutationKind ?? null)),
);

export const mutationPlanContracts = Object.freeze(definitions.map(defineContract));

export function createMutationPlanContractRegistry(
  contracts: readonly MutationPlanContract[],
): MutationPlanContractRegistry {
  const expected = new Set(expectedContractKeys);
  const registered = new Map<string, MutationPlanContract>();
  for (const candidate of contracts) {
    const key = contractKey(candidate.operation, candidate.mutationKind);
    if (!expected.has(key)) throw new TypeError(`unknown mutation plan contract: ${key}`);
    if (registered.has(key)) throw new TypeError(`duplicate mutation plan contract: ${key}`);
    registered.set(key, candidate);
  }
  const missingContracts = expectedContractKeys.filter((key) => !registered.has(key));
  if (missingContracts.length > 0) {
    throw new TypeError(
      `incomplete mutation plan contract registry: ${missingContracts.join(", ")}`,
    );
  }
  return Object.freeze({
    select: (plan: MutationPlan) => {
      const mutationKind = mutationKindFor(plan);
      return registered.get(contractKey(plan.operation, mutationKind)) ?? null;
    },
    values: () => Object.freeze([...registered.values()]),
  });
}

const registry = createMutationPlanContractRegistry(mutationPlanContracts);

export function mutationPlanContractFor(plan: MutationPlan): MutationPlanContract | null {
  return registry.select(plan);
}

function contract(
  operation: MutationOperation,
  mutationKind: string,
  allowsEmptyActions: boolean,
  validateActionSet: (plan: MutationPlan) => boolean,
): ContractDefinition {
  return { operation, mutationKind, allowsEmptyActions, validateActionSet };
}

function fixedContract(
  operation: MutationOperation,
  allowsEmptyActions: boolean,
  validateActionSet: (plan: MutationPlan) => boolean,
): ContractDefinition {
  return { operation, allowsEmptyActions, validateActionSet };
}

function defineContract(definition: ContractDefinition): MutationPlanContract {
  const mutationKind = definition.mutationKind ?? null;
  return Object.freeze({
    id: contractKey(definition.operation, mutationKind),
    operation: definition.operation,
    mutationKind,
    allowsEmptyActions: definition.allowsEmptyActions ?? false,
    normalizeIntent: (plan: MutationPlan) => plan.normalizedInputs,
    bindProvenance: (plan: MutationPlan) =>
      plan.normalizedInputs.storeProvenance ?? plan.normalizedInputs.provenance ?? null,
    validateActionSet: (plan: MutationPlan) =>
      plan.operation === definition.operation &&
      mutationKindFor(plan) === mutationKind &&
      (plan.actions.length > 0 || definition.allowsEmptyActions === true) &&
      definition.validateActionSet(plan),
    prepareEffects: <Prepared>(prepare: () => Prepared): Prepared => prepare(),
    projectReceipt: (result: OperationResult) => result,
  });
}

function mutationKindFor(plan: MutationPlan): string | null {
  if (plan.operation === "apply" || plan.operation === "revert") return null;
  const mutationKind = plan.normalizedInputs.mutationKind;
  return typeof mutationKind === "string" && mutationKind.length > 0 ? mutationKind : null;
}

function contractKey(operation: MutationOperation, mutationKind: string | null): string {
  return `${operation}:${mutationKind ?? "fixed"}`;
}

type KindExpectation = string | ReadonlySet<string>;

function oneOf(...kinds: string[]): ReadonlySet<string> {
  return new Set(kinds);
}

function exactKinds(plan: MutationPlan, expected: readonly KindExpectation[]): boolean {
  return (
    plan.actions.length === expected.length &&
    expected.every((kind, index) => {
      const actual = plan.actions[index]?.kind;
      return typeof kind === "string" ? actual === kind : actual !== undefined && kind.has(actual);
    })
  );
}

function suffixKinds(
  plan: MutationPlan,
  productKinds: ReadonlySet<string>,
  suffixKind: string,
): boolean {
  let reachedSuffix = false;
  for (const action of plan.actions) {
    if (action.kind === suffixKind) {
      reachedSuffix = true;
    } else if (reachedSuffix || !productKinds.has(action.kind)) {
      return false;
    }
  }
  return true;
}

function validateApplyPlan(plan: MutationPlan): boolean {
  const input = plan.normalizedInputs;
  const keys = [
    "agents",
    "configFingerprint",
    "capabilityRootProvenance",
    "distributePlan",
    "scope",
    "storeProvenance",
    "storeRoot",
  ];
  for (const optional of [
    "dir",
    "capabilities",
    "resourceIds",
    "method",
    "mcpStrategy",
    "syncProfile",
  ]) {
    if (optional in input) keys.push(optional);
  }
  if (
    !hasExactKeys(input, keys) ||
    typeof input.storeRoot !== "string" ||
    (input.scope !== "global" && input.scope !== "project") ||
    !isStringArray(input.agents) ||
    !isSha256(input.configFingerprint) ||
    !isStoreProvenance(input.storeProvenance) ||
    !Array.isArray(input.capabilityRootProvenance) ||
    !isPlainRecord(input.distributePlan) ||
    !hasExactDistributePlanKeys(input.distributePlan) ||
    !Array.isArray(input.distributePlan.actions) ||
    !isStringArray(input.distributePlan.warnings) ||
    !Array.isArray(input.distributePlan.conflicts)
  ) {
    return false;
  }
  const valid = suffixKinds(
    plan,
    new Set(["copy", "merge", "overwrite", "symlink", "write"]),
    "sync-gitignore",
  );
  if (!valid) return false;
  const helperCount = plan.actions.filter(({ kind }) => kind === "sync-gitignore").length;
  if (input.scope === "project" ? helperCount !== 1 : helperCount !== 0) return false;
  const executable = input.distributePlan.actions.filter(
    (action) => isPlainRecord(action) && action.op !== "skip",
  );
  const productActions = plan.actions.filter(({ kind }) => kind !== "sync-gitignore");
  return (
    executable.length === productActions.length &&
    productActions.every((action, index) => {
      const planned = executable[index];
      return (
        isPlainRecord(planned) &&
        hasExactKeys(action.payload, ["planAction"]) &&
        action.kind === planned.op &&
        action.target === planned.target &&
        canonicalJson(action.payload.planAction) === canonicalJson(planned)
      );
    })
  );
}

function validateRevertPlan(plan: MutationPlan): boolean {
  const input = plan.normalizedInputs;
  const keys = ["revertPlan", "storeRoot"];
  for (const optional of [
    "scope",
    "dir",
    "agents",
    "artifactIds",
    "acknowledgements",
    "keepBackups",
  ]) {
    if (optional in input) keys.push(optional);
  }
  if (
    !hasExactKeys(input, keys) ||
    typeof input.storeRoot !== "string" ||
    !isPlainRecord(input.revertPlan) ||
    !hasExactKeys(input.revertPlan, ["conflicts", "targets", "warnings"]) ||
    !Array.isArray(input.revertPlan.targets) ||
    !Array.isArray(input.revertPlan.conflicts) ||
    !isStringArray(input.revertPlan.warnings) ||
    !suffixKinds(plan, new Set(["remove-target", "restore-snapshot"]), "sync-gitignore")
  ) {
    return false;
  }
  const eligible = input.revertPlan.targets.filter(
    (target) => isPlainRecord(target) && target.blocked === false,
  );
  const productActions = plan.actions.filter(({ kind }) => kind !== "sync-gitignore");
  return (
    eligible.length === productActions.length &&
    productActions.every((action, index) => {
      const target = eligible[index];
      return (
        isPlainRecord(target) &&
        hasExactKeys(action.payload, ["revertTarget"]) &&
        action.target === target.target &&
        action.kind === target.proposedAction &&
        canonicalJson(action.payload.revertTarget) === canonicalJson(target)
      );
    })
  );
}

function validateAddActions(plan: MutationPlan): boolean {
  let reachedPublication = false;
  for (let index = 0; index < plan.actions.length; index += 1) {
    const kind = plan.actions[index]?.kind;
    if (kind === "publish-file") {
      if (reachedPublication || index !== plan.actions.length - 1) return false;
      reachedPublication = true;
      continue;
    }
    if (reachedPublication) return false;
    if (kind === "add-skills") {
      if (plan.actions[index + 1]?.kind !== "add-skill-provenance") return false;
      index += 1;
      continue;
    }
    if (kind !== "add-rules" && kind !== "add-mcp") return false;
  }
  return true;
}

function validateAddPlan(plan: MutationPlan): boolean {
  return hasExactKeys(plan.normalizedInputs, ["mutationKind"]) && validateAddActions(plan);
}

function validateInitializePlan(plan: MutationPlan): boolean {
  if (
    !hasExactKeys(plan.normalizedInputs, ["mutationKind"]) ||
    !exactKinds(plan, [oneOf("publish-file", "preserve-file"), "mkdir", "mkdir", "mkdir", "mkdir"])
  ) {
    return false;
  }
  const config = plan.actions[0];
  if (
    !config ||
    !hasExactKeys(config.payload, ["digest", "mode", "path"]) ||
    config.payload.path !== config.target ||
    config.payload.mode !== 0o600 ||
    !isSha256(config.payload.digest) ||
    config.postcondition?.state !== "present" ||
    config.postcondition.fingerprint !== config.payload.digest
  ) {
    return false;
  }
  return plan.actions
    .slice(1)
    .every(
      (action) =>
        hasExactKeys(action.payload, ["path"]) &&
        action.payload.path === action.target &&
        action.postcondition?.state === "present",
    );
}

function validateSettingsPlan(plan: MutationPlan): boolean {
  if (
    !hasExactKeys(plan.normalizedInputs, [
      "businessInput",
      "changedFields",
      "mutationKind",
      "storeProvenance",
    ]) ||
    !isPlainRecord(plan.normalizedInputs.businessInput) ||
    settingsMutationKindFor(plan.normalizedInputs.businessInput) !==
      plan.normalizedInputs.mutationKind ||
    !isUniqueNonEmptyStringArray(plan.normalizedInputs.changedFields) ||
    !isStoreProvenance(plan.normalizedInputs.storeProvenance)
  ) {
    return false;
  }
  return validatePublicationAction(plan, 0, { selfContained: true });
}

function validateSecretPublicationPlan(plan: MutationPlan): boolean {
  return (
    hasExactKeys(plan.normalizedInputs, ["mutationKind"]) &&
    validatePublicationAction(plan, 0, { currentUserOnly: true })
  );
}

function validateKeychainSecretPlan(plan: MutationPlan, kind: string): boolean {
  if (!hasExactKeys(plan.normalizedInputs, ["mutationKind"]) || !exactKinds(plan, [kind])) {
    return false;
  }
  const action = plan.actions[0];
  return Boolean(
    action &&
      hasExactKeys(action.payload, ["name", "provider", "service"]) &&
      action.payload.provider === "keychain" &&
      typeof action.payload.service === "string" &&
      action.payload.service.length > 0 &&
      typeof action.payload.name === "string" &&
      action.payload.name.length > 0 &&
      action.postcondition?.state === "present",
  );
}

function validateResourceUpdatePlan(plan: MutationPlan): boolean {
  const expectedKeys = [
    "changedFields",
    "currentContentFingerprint",
    "currentRevisionId",
    "currentSourceEvidence",
    "desiredStateEffect",
    "kind",
    "mutationKind",
    "name",
    "redactedDiff",
    "resourceId",
    "sourceEvidence",
    "stageFileDigest",
    "stagePath",
    "stagedBytes",
    "stagedContentDigest",
    "storeProvenance",
  ];
  if (
    !hasExactKeys(plan.normalizedInputs, expectedKeys) ||
    plan.normalizedInputs.desiredStateEffect !== "diverged-until-distributed" ||
    !isStoreProvenance(plan.normalizedInputs.storeProvenance) ||
    !exactKinds(plan, ["install-resource-revision", "publish-resource-metadata"])
  ) {
    return false;
  }
  const content = plan.actions[0];
  const metadata = plan.actions[1];
  return Boolean(
    content &&
      metadata &&
      hasExactKeys(content.payload, [
        "content",
        "contentDigest",
        "contentFingerprint",
        "resourceId",
      ]) &&
      content.payload.resourceId === plan.normalizedInputs.resourceId &&
      hasExactKeys(metadata.payload, ["data", "digest", "mode", "path"]) &&
      metadata.payload.path === metadata.target &&
      metadata.payload.mode === 0o600 &&
      typeof metadata.payload.data === "string" &&
      metadata.payload.digest === sha256(metadata.payload.data) &&
      metadata.postcondition?.state === "present" &&
      metadata.postcondition.fingerprint === metadata.payload.digest,
  );
}

function validateInventoryImportActions(plan: MutationPlan): boolean {
  const candidateIds = plan.normalizedInputs.candidateIds;
  const intoCollection = plan.normalizedInputs.intoCollection;
  if (
    !hasExactKeys(plan.normalizedInputs, [
      "candidateIds",
      "intoCollection",
      "mutationKind",
      "refreshScope",
    ]) ||
    !isUniqueNonEmptyStringArray(candidateIds) ||
    [...candidateIds].sort().join("\0") !== candidateIds.join("\0") ||
    (intoCollection !== null && typeof intoCollection !== "string") ||
    !hasExactKeys(plan.normalizedInputs.refreshScope, ["agentId", "projectRoot"])
  ) {
    return false;
  }
  const expectedLength = candidateIds.length * 2 + (typeof intoCollection === "string" ? 1 : 0);
  if (plan.actions.length !== expectedLength) return false;
  for (let index = 0; index < candidateIds.length; index += 1) {
    const content = plan.actions[index * 2];
    const metadata = plan.actions[index * 2 + 1];
    if (
      content?.kind !== "inventory-resource-content" ||
      metadata?.kind !== "inventory-resource-metadata" ||
      content.payload.candidateId !== candidateIds[index] ||
      metadata.payload.candidateId !== candidateIds[index] ||
      typeof content.payload.resourceId !== "string" ||
      metadata.payload.resourceId !== content.payload.resourceId
    ) {
      return false;
    }
  }
  return typeof intoCollection === "string"
    ? plan.actions.at(-1)?.kind === "inventory-collection-membership"
    : true;
}

function validateInventoryAdoptionPlan(plan: MutationPlan): boolean {
  if (
    !hasExactKeys(plan.normalizedInputs, [
      "candidateId",
      "candidateName",
      "mutationKind",
      "provider",
      "providerPrecondition",
      "refreshScope",
      "selector",
      "targetName",
    ]) ||
    typeof plan.normalizedInputs.candidateId !== "string" ||
    typeof plan.normalizedInputs.candidateName !== "string" ||
    typeof plan.normalizedInputs.targetName !== "string" ||
    !exactKinds(plan, ["inventory-resource-content", "inventory-resource-metadata"])
  ) {
    return false;
  }
  const content = plan.actions[0];
  const metadata = plan.actions[1];
  return Boolean(
    content &&
      metadata &&
      content.payload.candidateId === plan.normalizedInputs.candidateId &&
      metadata.payload.candidateId === plan.normalizedInputs.candidateId &&
      content.payload.resourceId === `mcp/${plan.normalizedInputs.candidateName}` &&
      metadata.payload.resourceId === content.payload.resourceId,
  );
}

function validatePublicationAction(
  plan: MutationPlan,
  index: number,
  options: { readonly selfContained?: boolean; readonly currentUserOnly?: boolean },
): boolean {
  if (plan.actions.length !== 1 || plan.targetPreconditions.length !== 1) return false;
  const action = plan.actions[index];
  if (action?.kind !== "publish-file") return false;
  const payloadKeys = [
    ...(options.selfContained ? ["data"] : []),
    "digest",
    "mode",
    "path",
    ...(options.currentUserOnly ? ["currentUserOnly"] : []),
  ];
  if (
    !hasExactKeys(action.payload, payloadKeys) ||
    action.payload.path !== action.target ||
    !isSha256(action.payload.digest) ||
    typeof action.payload.mode !== "number" ||
    action.postcondition?.state !== "present" ||
    action.postcondition.fingerprint !== action.payload.digest ||
    (options.currentUserOnly && action.payload.currentUserOnly !== true)
  ) {
    return false;
  }
  if (
    options.selfContained &&
    (typeof action.payload.data !== "string" ||
      sha256(action.payload.data) !== action.payload.digest)
  ) {
    return false;
  }
  const mutationKind = plan.normalizedInputs.mutationKind;
  if (typeof mutationKind !== "string") return false;
  return (
    action.actionId ===
    sha256(
      JSON.stringify({
        mutationKind,
        index,
        kind: "publish-file",
        path: action.target,
        digest: action.payload.digest,
        mode: action.payload.mode,
        currentUserOnly: action.payload.currentUserOnly === true,
      }),
    )
  );
}

function isStoreProvenance(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const paths: string[] = [];
  for (const descriptor of value) {
    if (
      !hasExactKeys(descriptor, ["expected", "path"]) ||
      typeof descriptor.path !== "string" ||
      descriptor.path.length === 0 ||
      !isTargetState(descriptor.expected)
    ) {
      return false;
    }
    paths.push(descriptor.path);
  }
  return new Set(paths).size === paths.length;
}

function isTargetState(value: unknown): boolean {
  return (
    (hasExactKeys(value, ["state"]) && value.state === "absent") ||
    (hasExactKeys(value, ["fingerprint", "state"]) &&
      value.state === "present" &&
      typeof value.fingerprint === "string")
  );
}

function isUniqueNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.length > 0) &&
    new Set(value).size === value.length
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    isPlainRecord(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function validateResourceRenameActions(plan: MutationPlan): boolean {
  if (plan.actions.length === 0) return false;
  const kinds = plan.actions.map(({ kind }) => kind);
  const prefixLength =
    kinds[0] === "rename-resource-content"
      ? 1
      : kinds[0] === "install-resource-content" && kinds[1] === "remove-resource-path"
        ? 2
        : 0;
  if (prefixLength === 0 || kinds[prefixLength] !== "publish-resource-metadata") return false;
  return (
    kinds.length === prefixLength + 1 ||
    (kinds.length === prefixLength + 2 && kinds.at(-1) === "remove-resource-path")
  );
}

function validateResourceRemoveActions(plan: MutationPlan): boolean {
  if (plan.actions.length === 0) return false;
  let reachedPublication = false;
  for (const action of plan.actions) {
    if (action.kind === "remove-resource-path" && !reachedPublication) continue;
    if (action.kind === "publish-file") {
      reachedPublication = true;
      continue;
    }
    return false;
  }
  return plan.actions.filter(({ kind }) => kind === "publish-file").length <= 2;
}

function validateResourceLifecyclePlan(
  plan: MutationPlan,
  validateActions: () => boolean,
): boolean {
  const input = plan.normalizedInputs;
  const mutationKind = input.mutationKind;
  const keys = [
    "blocked",
    "businessInput",
    "capabilitySnapshot",
    "currentRevisionId",
    "mutationKind",
    "storeProvenance",
  ];
  if (
    mutationKind === "resource-local-fork" ||
    mutationKind === "resource-rename" ||
    mutationKind === "resource-remove-cascade" ||
    mutationKind === "resource-remove-ordinary"
  ) {
    keys.push("dependencyReport");
  } else if (mutationKind === "resource-export" || mutationKind === "resource-bundle-import") {
    keys.push("bundleDigest");
  }
  if (
    !hasExactKeys(input, keys) ||
    !isPlainRecord(input.businessInput) ||
    !matchesResourceLifecycleIntent(mutationKind, input.businessInput) ||
    !isPlainRecord(input.capabilitySnapshot) ||
    typeof input.currentRevisionId !== "string" ||
    !isResourceLifecycleBlocks(input.blocked) ||
    !isStoreProvenance(input.storeProvenance)
  ) {
    return false;
  }
  if (keys.includes("dependencyReport") && !isPlainRecord(input.dependencyReport)) return false;
  if (keys.includes("bundleDigest") && !isSha256(input.bundleDigest)) return false;
  if (input.blocked.length > 0) return plan.actions.length === 0;
  return validateActions();
}

function settingsMutationKindFor(input: Record<string, unknown>): string | null {
  const action = input.action;
  if (typeof action !== "string") return null;
  if (input.kind === "builtin") return `builtin-agent-${action}`;
  if (input.kind === "custom") return `custom-adapter-${action}`;
  if (input.kind === "settings") return `config-${action}`;
  if (input.kind === "collection") return `collection-${action}`;
  if (!("kind" in input) && ["create", "update", "delete"].includes(action)) {
    return `profile-${action}`;
  }
  return null;
}

function matchesResourceLifecycleIntent(
  mutationKind: unknown,
  input: Record<string, unknown>,
): boolean {
  if (mutationKind === "resource-local-fork") {
    return input.operation === "rename" && input.mode === "local-fork";
  }
  if (mutationKind === "resource-rename") {
    return input.operation === "rename" && input.mode === "rename";
  }
  if (mutationKind === "resource-remove-cascade") {
    return input.operation === "remove" && input.cascade === true;
  }
  if (mutationKind === "resource-remove-ordinary") {
    return input.operation === "remove" && input.cascade === false;
  }
  if (mutationKind === "resource-export") return input.operation === "export";
  if (mutationKind === "resource-bundle-import") return input.operation === "bundle-import";
  return false;
}

function validateSyncUninstallPlan(plan: MutationPlan): boolean {
  const input = plan.normalizedInputs;
  const businessInput = input.businessInput;
  if (
    !hasExactKeys(input, ["businessInput", "capabilitySnapshot", "mutationKind", "targets"]) ||
    !isPlainRecord(businessInput) ||
    !hasExactSyncUninstallBusinessInput(businessInput) ||
    !isUniqueNonEmptyStringArray(businessInput.targetKeys) ||
    [...businessInput.targetKeys].sort().join("\0") !== businessInput.targetKeys.join("\0") ||
    !Array.isArray(input.capabilitySnapshot) ||
    !Array.isArray(input.targets) ||
    !suffixKinds(plan, new Set(["remove-target"]), "sync-gitignore")
  ) {
    return false;
  }
  const targetKeys = businessInput.targetKeys as string[];
  if (
    input.targets.length !== targetKeys.length ||
    input.targets.some(
      (target, index) => !isPlainRecord(target) || target.key !== targetKeys[index],
    )
  ) {
    return false;
  }
  const productActions = plan.actions.filter(({ kind }) => kind === "remove-target");
  const executableTargets = input.targets.filter(
    (target) => isPlainRecord(target) && target.blocked === false,
  );
  return (
    productActions.length === executableTargets.length &&
    productActions.every((action, index) => {
      const target = executableTargets[index];
      return isPlainRecord(target) && action.target === target.target;
    })
  );
}

function hasExactDistributePlanKeys(value: Record<string, unknown>): boolean {
  const keys = ["actions", "conflicts", "warnings"];
  for (const optional of ["secretFindings", "secretReferenceFindings", "invalidLedger"]) {
    if (optional in value) keys.push(optional);
  }
  return hasExactKeys(value, keys);
}

function isResourceLifecycleBlocks(value: unknown): value is string[] {
  const allowed = new Set([
    "LOCAL_FORK_REQUIRED",
    "RESOURCE_COLLISION",
    "COLLECTION_DEPENDENCY",
    "PROFILE_DEPENDENCY",
    "DESIRED_SELECTION_DEPENDENCY",
    "OWNED_TARGET_DEPENDENCY",
  ]);
  return (
    isStringArray(value) &&
    new Set(value).size === value.length &&
    value.every((code) => allowed.has(code))
  );
}

function hasExactSyncUninstallBusinessInput(value: Record<string, unknown>): boolean {
  const keys = ["targetKeys"];
  if ("acknowledgements" in value) keys.push("acknowledgements");
  if ("syncProfile" in value) keys.push("syncProfile");
  return (
    hasExactKeys(value, keys) &&
    (!("acknowledgements" in value) || isStringArray(value.acknowledgements)) &&
    (!("syncProfile" in value) || isPlainRecord(value.syncProfile))
  );
}
