import {
  AGENT_ID_PATTERN,
  CLI_PROTOCOL_VERSION,
  NORMALIZED_STORE_RELATIVE_SOURCE_PATTERN,
} from "@cellarer/core";
import type { CommandInputBinding } from "./command-types.js";
import type { JsonSchema } from "./schemas.js";
import { jsonSchema, PROTECTED_DESCRIPTOR_MAX, PROTECTED_DESCRIPTOR_MIN } from "./schemas.js";

const stringArray = jsonSchema.array(jsonSchema.string({ minLength: 1 }));
const capabilityArray = jsonSchema.array(jsonSchema.enumeration(["rules", "mcp", "skills"]));
const secretMode = jsonSchema.enumeration(["env", "vault", "keychain"]);
const provider = jsonSchema.enumeration(["vault", "keychain"]);
const dataObject = (
  required: readonly string[] = [],
  properties: Record<string, JsonSchema> = {},
) => jsonSchema.object(properties, required);
const typedMap = (valueSchema: JsonSchema): JsonSchema => jsonSchema.object({}, [], valueSchema);
const nonEmptyKeyedMap = (valueSchema: JsonSchema): JsonSchema => ({
  ...typedMap(valueSchema),
  propertyNames: jsonSchema.string({ minLength: 1 }),
});
const agentId = jsonSchema.string({ minLength: 1, pattern: AGENT_ID_PATTERN });
const agentKeyedMap = (valueSchema: JsonSchema): JsonSchema => ({
  ...typedMap(valueSchema),
  propertyNames: agentId,
});
const opaqueJsonValue: JsonSchema = { "x-cellarer-opaque": true };
const opaqueJsonMap = typedMap(opaqueJsonValue);
const artifactArray = jsonSchema.array(
  dataObject(["id", "kind", "collections"], {
    id: jsonSchema.string({ minLength: 1 }),
    kind: jsonSchema.enumeration(["rules", "mcp", "skills"]),
    collections: stringArray,
  }),
);
const progressEvent = dataObject([], {
  phase: jsonSchema.string({ minLength: 1 }),
  current: jsonSchema.integer(),
  total: jsonSchema.integer(),
});
const commandCapability = jsonSchema.object(
  {
    command: jsonSchema.string({ minLength: 1 }),
    mutability: jsonSchema.enumeration(["read", "write", "service"]),
    streaming: jsonSchema.boolean(),
    inputSchemaId: jsonSchema.string({ minLength: 1 }),
    outputSchemaId: jsonSchema.string({ minLength: 1 }),
    eventSchemaId: jsonSchema.string({ minLength: 1 }),
    requiredFeatures: stringArray,
  },
  ["command", "mutability", "streaming", "inputSchemaId", "outputSchemaId", "requiredFeatures"],
);
const protocolSchemaEntry = jsonSchema.object(
  {
    schemaId: jsonSchema.string({ minLength: 1 }),
    schema: opaqueJsonMap,
  },
  ["schemaId", "schema"],
);
const scope = jsonSchema.enumeration(["global", "project"]);
const destination = jsonSchema.enumeration(["user", "project"]);
const exactResourceSelector = dataObject(["kind", "name", "source"], {
  kind: jsonSchema.enumeration(["rules", "mcp", "skills"]),
  name: jsonSchema.string({ minLength: 1 }),
  source: jsonSchema.string({ minLength: 1 }),
});
const resourceState = jsonSchema.enumeration([
  "managed",
  "discovered",
  "synced",
  "drifted",
  "missing",
  "blocked",
]);
const adapterRules = dataObject([], {
  global: jsonSchema.string({ minLength: 1 }),
  project: jsonSchema.string({ minLength: 1 }),
  format: { const: "markdown" },
});
const adapterSkills = dataObject([], {
  global: jsonSchema.string({ minLength: 1 }),
  project: jsonSchema.string({ minLength: 1 }),
  format: { const: "dir" },
});
const adapterDialect = dataObject([], {
  commandStyle: jsonSchema.enumeration(["scalar", "array"]),
  envKey: jsonSchema.string({ minLength: 1 }),
  urlKey: jsonSchema.string({ minLength: 1 }),
  typeField: jsonSchema.string({ minLength: 1 }),
  stdioType: jsonSchema.string({ minLength: 1 }),
  remoteType: jsonSchema.string({ minLength: 1 }),
});
const adapterCapabilities = dataObject([], {
  rules: jsonSchema.array(scope),
  mcp: jsonSchema.array(scope),
  skills: jsonSchema.array(scope),
});
const adapterPatchProperties: Record<string, JsonSchema> = {
  displayName: jsonSchema.string({ minLength: 1 }),
  detect: dataObject([], { global: stringArray, project: stringArray }),
  rules: adapterRules,
  mcp: dataObject([], {
    global: jsonSchema.string({ minLength: 1 }),
    project: jsonSchema.string({ minLength: 1 }),
    format: jsonSchema.enumeration(["json", "toml"]),
    serversKey: jsonSchema.string({ minLength: 1 }),
    mergeStrategy: jsonSchema.enumeration(["merge", "overwrite"]),
    supportedSecretReferences: jsonSchema.array(
      jsonSchema.enumeration(["environment", "cellarer"]),
    ),
    dialect: adapterDialect,
  }),
  skills: adapterSkills,
  capabilities: adapterCapabilities,
};
const adapterPatch = dataObject([], adapterPatchProperties);
const adapterBody: JsonSchema = {
  ...dataObject([], adapterPatchProperties),
  anyOf: [{ required: ["rules"] }, { required: ["mcp"] }, { required: ["skills"] }],
  not: {
    required: ["mcp"],
    properties: {
      mcp: { not: { required: ["supportedSecretReferences"] } },
    },
  },
};
const adapterOverride = dataObject([], {
  enabled: jsonSchema.boolean(),
  ...adapterPatchProperties,
});
const configValidationStringArray = stringArray;
const configValidationAdapterRules = dataObject([], {
  global: jsonSchema.string({ minLength: 1 }),
  project: jsonSchema.string({ minLength: 1 }),
  format: { const: "markdown" },
});
const configValidationAdapterSkills = dataObject([], {
  global: jsonSchema.string({ minLength: 1 }),
  project: jsonSchema.string({ minLength: 1 }),
  format: { const: "dir" },
});
const configValidationAdapterDialect = dataObject([], {
  commandStyle: jsonSchema.enumeration(["scalar", "array"]),
  envKey: jsonSchema.string({ minLength: 1 }),
  urlKey: jsonSchema.string({ minLength: 1 }),
  typeField: jsonSchema.string({ minLength: 1 }),
  stdioType: jsonSchema.string({ minLength: 1 }),
  remoteType: jsonSchema.string({ minLength: 1 }),
});
const configValidationAdapterPatchProperties: Record<string, JsonSchema> = {
  displayName: jsonSchema.string({ minLength: 1 }),
  detect: dataObject([], {
    global: configValidationStringArray,
    project: configValidationStringArray,
  }),
  rules: configValidationAdapterRules,
  mcp: dataObject([], {
    global: jsonSchema.string({ minLength: 1 }),
    project: jsonSchema.string({ minLength: 1 }),
    format: jsonSchema.enumeration(["json", "toml"]),
    serversKey: jsonSchema.string({ minLength: 1 }),
    mergeStrategy: jsonSchema.enumeration(["merge", "overwrite"]),
    supportedSecretReferences: jsonSchema.array(
      jsonSchema.enumeration(["environment", "cellarer"]),
    ),
    dialect: configValidationAdapterDialect,
  }),
  skills: configValidationAdapterSkills,
  capabilities: adapterCapabilities,
};
const configValidationAdapterBody: JsonSchema = {
  ...dataObject([], configValidationAdapterPatchProperties),
  anyOf: [{ required: ["rules"] }, { required: ["mcp"] }, { required: ["skills"] }],
  not: {
    required: ["mcp"],
    properties: {
      mcp: { not: { required: ["supportedSecretReferences"] } },
    },
  },
};
const configValidationAdapterOverride = dataObject([], {
  enabled: jsonSchema.boolean(),
  ...configValidationAdapterPatchProperties,
});
const settingsPatch: JsonSchema = {
  ...dataObject([], {
    method: jsonSchema.enumeration(["symlink", "copy"]),
    secretMode,
    os: dataObject([], {
      win32: dataObject([], { method: jsonSchema.enumeration(["symlink", "copy"]) }),
      darwin: dataObject([], { method: jsonSchema.enumeration(["symlink", "copy"]) }),
      linux: dataObject([], { method: jsonSchema.enumeration(["symlink", "copy"]) }),
    }),
  }),
  minProperties: 1,
};
const validationIssue = dataObject(["path", "message"], {
  path: jsonSchema.string(),
  message: jsonSchema.string(),
});
const resourceCounts = dataObject(
  ["managed", "discovered", "synced", "drifted", "missing", "blocked"],
  {
    managed: jsonSchema.integer(),
    discovered: jsonSchema.integer(),
    synced: jsonSchema.integer(),
    drifted: jsonSchema.integer(),
    missing: jsonSchema.integer(),
    blocked: jsonSchema.integer(),
  },
);
const resourceSyncTarget = dataObject(["agent", "destination", "scope", "target", "state"], {
  agent: jsonSchema.string({ minLength: 1 }),
  destination,
  scope,
  target: jsonSchema.string({ minLength: 1 }),
  state: jsonSchema.enumeration(["synced", "drifted", "missing", "blocked"]),
  reason: jsonSchema.string(),
});
const contentFingerprint = jsonSchema.string({ pattern: "^sha256:[0-9a-f]{64}$" });
const resourceSourceDescriptor: JsonSchema = {
  oneOf: [
    dataObject(["type"], {
      type: { const: "local-snapshot" },
      capturedFrom: jsonSchema.string({ minLength: 1 }),
    }),
    dataObject(["type", "repositoryUrl", "ref", "commit", "subpath"], {
      type: { const: "git" },
      repositoryUrl: jsonSchema.string({ minLength: 1 }),
      ref: jsonSchema.string({ minLength: 1 }),
      commit: jsonSchema.string({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" }),
      subpath: jsonSchema.string({ minLength: 1 }),
    }),
    dataObject(["type", "url", "integrity"], {
      type: { const: "url" },
      url: jsonSchema.string({ minLength: 1 }),
      integrity: contentFingerprint,
    }),
  ],
};
const resourceValidationEvidence = dataObject(["status", "checkedAt", "checks"], {
  status: jsonSchema.enumeration(["validated", "backfilled"]),
  checkedAt: jsonSchema.string({ minLength: 1 }),
  checks: jsonSchema.array(
    jsonSchema.enumeration([
      "content-fingerprint",
      "manifest",
      "adapter-compatibility",
      "secret-scan",
    ]),
  ),
});
const resourceRevision = dataObject(["id", "contentFingerprint", "validation", "source"], {
  id: contentFingerprint,
  contentFingerprint,
  validation: resourceValidationEvidence,
  source: resourceSourceDescriptor,
});
const controlPlaneResource = dataObject(
  [
    "id",
    "kind",
    "name",
    "source",
    "state",
    "membership",
    "selection",
    "validation",
    "secretReferenceNames",
    "usage",
  ],
  {
    id: jsonSchema.string({ minLength: 1 }),
    kind: jsonSchema.enumeration(["rules", "mcp", "skills"]),
    name: jsonSchema.string({ minLength: 1 }),
    source: jsonSchema.string({ minLength: 1 }),
    state: resourceState,
    currentRevision: resourceRevision,
    provenance: resourceSourceDescriptor,
    discovered: dataObject(["agent", "destination", "source"], {
      agent: jsonSchema.string({ minLength: 1 }),
      destination,
      source: jsonSchema.string({ minLength: 1 }),
    }),
    membership: dataObject(["collections"], { collections: stringArray }),
    selection: dataObject(["desired", "collections"], {
      desired: jsonSchema.boolean(),
      collections: stringArray,
    }),
    validation: dataObject(["status", "issues"], {
      status: jsonSchema.enumeration(["valid", "warning", "invalid"]),
      issues: jsonSchema.array(validationIssue),
    }),
    secretReferenceNames: stringArray,
    usage: dataObject(["desired", "applied"], {
      desired: jsonSchema.array(
        dataObject(["collection"], { collection: jsonSchema.string({ minLength: 1 }) }),
      ),
      applied: jsonSchema.array(resourceSyncTarget),
    }),
    lastActivityAt: jsonSchema.string({ minLength: 1 }),
  },
);
const controlPlaneAgent = dataObject(
  [
    "id",
    "displayName",
    "adapterKind",
    "supported",
    "detected",
    "configured",
    "enabled",
    "detectionEvidence",
    "capabilities",
    "capabilityScopes",
    "targets",
    "validationIssues",
  ],
  {
    id: agentId,
    displayName: jsonSchema.string({ minLength: 1 }),
    adapterKind: jsonSchema.enumeration(["built-in", "custom"]),
    supported: { const: true },
    detected: jsonSchema.boolean(),
    configured: jsonSchema.boolean(),
    enabled: jsonSchema.boolean(),
    detectionEvidence: dataObject([], { root: jsonSchema.string({ minLength: 1 }) }),
    capabilities: capabilityArray,
    capabilityScopes: dataObject(["rules", "mcp", "skills"], {
      rules: jsonSchema.array(scope),
      mcp: jsonSchema.array(scope),
      skills: jsonSchema.array(scope),
    }),
    targets: jsonSchema.array(
      dataObject(["capability", "scope", "path"], {
        capability: jsonSchema.enumeration(["rules", "mcp", "skills"]),
        scope,
        path: jsonSchema.string({ minLength: 1 }),
      }),
    ),
    validationIssues: jsonSchema.array(validationIssue),
  },
);
const controlPlaneCollection = dataObject(["name", "isDefault", "resourceIds"], {
  name: jsonSchema.string({ minLength: 1 }),
  description: jsonSchema.string(),
  isDefault: jsonSchema.boolean(),
  resourceIds: stringArray,
});
const osDefaults = dataObject([], { method: jsonSchema.enumeration(["symlink", "copy"]) });
const configDefaultsProperties = {
  method: jsonSchema.enumeration(["symlink", "copy"]),
  collections: stringArray,
  secretMode,
  os: dataObject([], { win32: osDefaults, darwin: osDefaults, linux: osDefaults }),
};
const configDefaults = dataObject(
  ["method", "collections", "secretMode"],
  configDefaultsProperties,
);
const configValidationDefaults = dataObject([], {
  ...configDefaultsProperties,
  collections: configValidationStringArray,
});
const configCollection = dataObject([], { description: jsonSchema.string() });
const secretPatternSuppression = dataObject(["source", "rule", "patternVersion"], {
  source: jsonSchema.string({
    minLength: 1,
    pattern: NORMALIZED_STORE_RELATIVE_SOURCE_PATTERN,
  }),
  rule: jsonSchema.string({ minLength: 1 }),
  patternVersion: jsonSchema.integer(1),
});
const configArtifactProperties = {
  collections: stringArray,
  secretPatternSuppressions: jsonSchema.array(secretPatternSuppression),
};
const configArtifact = dataObject(["collections"], configArtifactProperties);
const configValidationArtifact = dataObject([], {
  ...configArtifactProperties,
  collections: configValidationStringArray,
});
const controlPlaneConfig = dataObject(
  ["version", "defaults", "collections", "artifacts", "adapterOverrides", "customAdapters"],
  {
    version: { const: 1 },
    defaults: configDefaults,
    collections: nonEmptyKeyedMap(configCollection),
    artifacts: nonEmptyKeyedMap(configArtifact),
    adapterOverrides: agentKeyedMap(adapterOverride),
    customAdapters: agentKeyedMap(adapterBody),
  },
);
const controlPlaneConfigValidationInput = dataObject([], {
  version: { const: 1 },
  defaults: configValidationDefaults,
  collections: nonEmptyKeyedMap(configCollection),
  artifacts: nonEmptyKeyedMap(configValidationArtifact),
  adapterOverrides: agentKeyedMap(configValidationAdapterOverride),
  customAdapters: agentKeyedMap(configValidationAdapterBody),
});
const mutationOperation = jsonSchema.enumeration([
  "initialize",
  "apply",
  "revert",
  "settings",
  "secret-metadata",
  "store-import",
]);
const operationSummary = dataObject(
  [
    "operationId",
    "planId",
    "operation",
    "baseRevision",
    "resultingRevision",
    "outcome",
    "actionCount",
    "startedAt",
    "completedAt",
  ],
  {
    operationId: jsonSchema.string({ minLength: 1 }),
    planId: jsonSchema.string({ minLength: 1 }),
    operation: mutationOperation,
    baseRevision: jsonSchema.integer(),
    resultingRevision: jsonSchema.integer(),
    outcome: jsonSchema.enumeration(["committed", "compensated", "manual-recovery-required"]),
    actionCount: jsonSchema.integer(),
    startedAt: jsonSchema.string({ minLength: 1 }),
    completedAt: jsonSchema.string({ minLength: 1 }),
  },
);
const targetStateReceipt: JsonSchema = {
  oneOf: [
    dataObject(["state"], { state: { const: "absent" } }),
    dataObject(["state", "fingerprint"], {
      state: { const: "present" },
      fingerprint: jsonSchema.string({ minLength: 1 }),
    }),
    dataObject(
      [
        "state",
        "fingerprint",
        "recoverySnapshot",
        "recoverySnapshotDigest",
        "recoverySnapshotMode",
      ],
      {
        state: { const: "present" },
        fingerprint: jsonSchema.string({ minLength: 1 }),
        recoverySnapshot: jsonSchema.string({ minLength: 1 }),
        recoverySnapshotDigest: jsonSchema.string({ minLength: 1 }),
        recoverySnapshotMode: jsonSchema.integer(),
      },
    ),
  ],
};
const mutationAuthorization = dataObject(
  ["schemaVersion", "domain", "algorithm", "authorityId", "authorityEpoch", "seal"],
  {
    schemaVersion: { const: 1 },
    domain: { const: "executable-plan-v1" },
    algorithm: { const: "HMAC-SHA-256" },
    authorityId: jsonSchema.string({ minLength: 1 }),
    authorityEpoch: jsonSchema.integer(1),
    seal: jsonSchema.string({ pattern: "^hmac-sha256:[0-9a-f]{64}$" }),
  },
);
const appliedReceipt = dataObject(["method", "fingerprint", "backup", "generated", "appliedAt"], {
  method: jsonSchema.enumeration(["write", "symlink", "junction", "copy"]),
  fingerprint: jsonSchema.string({ minLength: 1 }),
  contentFingerprint: jsonSchema.string({ minLength: 1 }),
  sourceFingerprint: jsonSchema.string({ minLength: 1 }),
  backup: { type: ["string", "null"] },
  generated: jsonSchema.boolean(),
  appliedAt: jsonSchema.string({ minLength: 1 }),
});
const targetOwnership = dataObject(
  ["key", "classification", "target", "currentFingerprint", "expectedReceipt"],
  {
    key: jsonSchema.string({ minLength: 1 }),
    classification: jsonSchema.enumeration([
      "absent",
      "owned-current",
      "owned-drifted",
      "unowned-existing",
      "invalid-owner",
    ]),
    target: jsonSchema.string({ minLength: 1 }),
    currentFingerprint: { type: ["string", "null"] },
    expectedReceipt: { ...appliedReceipt, type: ["object", "null"] },
  },
);
const targetAcknowledgement = dataObject(["kind", "token"], {
  kind: jsonSchema.enumeration(["replace-unowned", "override-drift", "revert-drift"]),
  token: jsonSchema.string({ pattern: "^sha256:[0-9a-f]{64}$" }),
});
const distributePlanAction = dataObject(
  ["artifact", "agent", "scope", "capability", "target", "method", "op"],
  {
    artifact: jsonSchema.string({ minLength: 1 }),
    artifactIds: stringArray,
    agent: jsonSchema.string({ minLength: 1 }),
    scope,
    capability: jsonSchema.enumeration(["rules", "mcp", "skills"]),
    target: jsonSchema.string({ minLength: 1 }),
    source: jsonSchema.string({ minLength: 1 }),
    method: jsonSchema.enumeration(["symlink", "copy"]),
    op: jsonSchema.enumeration(["write", "symlink", "copy", "merge", "overwrite", "skip"]),
    reason: jsonSchema.string(),
    preview: dataObject([], { before: jsonSchema.string(), after: jsonSchema.string() }),
    secretRefs: stringArray,
    accidentalPlaintext: jsonSchema.boolean(),
    desiredEvidence: dataObject(["method"], {
      method: jsonSchema.enumeration(["write", "symlink", "copy"]),
      contentFingerprint: jsonSchema.string({ minLength: 1 }),
      sourceFingerprint: jsonSchema.string({ minLength: 1 }),
      sourceIdentity: jsonSchema.string({ minLength: 1 }),
    }),
    storeInputs: jsonSchema.array(
      dataObject(["artifactId", "path", "fingerprint"], {
        artifactId: jsonSchema.string({ minLength: 1 }),
        path: jsonSchema.string({ minLength: 1 }),
        fingerprint: jsonSchema.string({ minLength: 1 }),
      }),
    ),
    ownership: targetOwnership,
    replacement: dataObject(["acknowledgement", "snapshotRequired"], {
      acknowledgement: targetAcknowledgement,
      snapshotRequired: { const: true },
    }),
  },
);
const targetConflict = dataObject(["code", "target", "message", "ownership"], {
  code: jsonSchema.enumeration([
    "UNOWNED_TARGET",
    "OWNED_TARGET_DRIFTED",
    "INVALID_TARGET_OWNER",
    "SNAPSHOT_ENCRYPTION_REQUIRED",
    "REVERT_TARGET_DRIFTED",
    "REVERT_SNAPSHOT_UNAVAILABLE",
  ]),
  target: jsonSchema.string({ minLength: 1 }),
  message: jsonSchema.string(),
  ownership: targetOwnership,
  acknowledgement: targetAcknowledgement,
});
const distributePlan = dataObject(["actions", "warnings", "conflicts"], {
  actions: jsonSchema.array(distributePlanAction),
  warnings: stringArray,
  conflicts: jsonSchema.array(targetConflict),
  secretFindings: jsonSchema.array(
    dataObject(["artifact", "source", "line", "rule"], {
      artifact: jsonSchema.string({ minLength: 1 }),
      source: jsonSchema.string({ minLength: 1 }),
      line: jsonSchema.integer(1),
      rule: jsonSchema.string({ minLength: 1 }),
      patternVersion: jsonSchema.integer(),
    }),
  ),
  secretReferenceFindings: jsonSchema.array(
    dataObject(["reference", "provider", "status"], {
      reference: jsonSchema.string({ minLength: 1 }),
      provider: jsonSchema.enumeration(["environment", "vault", "keychain"]),
      status: jsonSchema.enumeration(["missing", "unavailable"]),
    }),
  ),
  invalidLedger: { const: true },
});
const distributionActionPayload = dataObject(["planAction"], {
  planAction: distributePlanAction,
});
const gitignoreActionPayload = dataObject(
  ["path", "projectDir", "targets", "effect", "digest", "mode"],
  {
    path: jsonSchema.string({ minLength: 1 }),
    projectDir: jsonSchema.string({ minLength: 1 }),
    targets: stringArray,
    effect: jsonSchema.enumeration(["publish", "remove"]),
    digest: jsonSchema.string({ pattern: "^sha256:[0-9a-f]{64}$" }),
    mode: { const: 0o644 },
  },
);
const publicationActionPayload = dataObject(["path", "digest", "mode", "data"], {
  path: jsonSchema.string({ minLength: 1 }),
  digest: jsonSchema.string({ pattern: "^sha256:[0-9a-f]{64}$" }),
  mode: { const: 0o600 },
  data: jsonSchema.string(),
});
function typedMutationPlanAction(
  kind: string,
  payload: JsonSchema,
  postconditionRequired = false,
): JsonSchema {
  return dataObject(
    ["actionId", "kind", "target", "payload", ...(postconditionRequired ? ["postcondition"] : [])],
    {
      actionId: jsonSchema.string({ minLength: 1 }),
      kind: { const: kind },
      target: jsonSchema.string({ minLength: 1 }),
      payload,
      postcondition: targetStateReceipt,
    },
  );
}
const mutationPlanAction: JsonSchema = {
  oneOf: [
    ...["write", "merge", "overwrite", "symlink", "copy"].map((kind) =>
      typedMutationPlanAction(kind, distributionActionPayload),
    ),
    typedMutationPlanAction("sync-gitignore", gitignoreActionPayload),
    typedMutationPlanAction("publish-file", publicationActionPayload, true),
  ],
};
const mutationPlanPreconditions = jsonSchema.array(
  dataObject(["actionId", "target", "expected"], {
    actionId: jsonSchema.string({ minLength: 1 }),
    target: jsonSchema.string({ minLength: 1 }),
    expected: targetStateReceipt,
  }),
);
const mutationPlanExpiry: JsonSchema = {
  oneOf: [
    dataObject(["policy"], { policy: { const: "none" } }),
    dataObject(["policy", "expiresAt"], {
      policy: { const: "expires-at" },
      expiresAt: jsonSchema.string({ minLength: 1 }),
    }),
  ],
};
const storeProvenanceDescriptor = dataObject(["path", "expected"], {
  path: jsonSchema.string({ minLength: 1 }),
  expected: targetStateReceipt,
});
const capabilityRootProvenanceDescriptor = dataObject(["capability", "path", "expected"], {
  capability: jsonSchema.enumeration(["rules", "mcp", "skills"]),
  path: jsonSchema.string({ minLength: 1 }),
  expected: {
    oneOf: [
      dataObject(["state"], { state: { const: "absent" } }),
      dataObject(["state", "fingerprint", "identity", "mode"], {
        state: { const: "present" },
        fingerprint: jsonSchema.string({ pattern: "^sha256:[0-9a-f]{64}$" }),
        identity: jsonSchema.string({ pattern: "^sha256:[0-9a-f]{64}$" }),
        mode: jsonSchema.integer(),
      }),
    ],
  },
});
const distributionNormalizedInputs = dataObject(
  [
    "storeRoot",
    "scope",
    "agents",
    "configFingerprint",
    "storeProvenance",
    "capabilityRootProvenance",
    "distributePlan",
  ],
  {
    storeRoot: jsonSchema.string({ minLength: 1 }),
    scope,
    agents: stringArray,
    configFingerprint: jsonSchema.string({ pattern: "^sha256:[0-9a-f]{64}$" }),
    storeProvenance: jsonSchema.array(storeProvenanceDescriptor),
    capabilityRootProvenance: jsonSchema.array(capabilityRootProvenanceDescriptor),
    dir: jsonSchema.string({ minLength: 1 }),
    capabilities: capabilityArray,
    distributePlan,
  },
);
const settingsMutationKinds = [
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
const builtinCapabilitySnapshot = dataObject(["builtinAdapterIds"], {
  builtinAdapterIds: jsonSchema.array(agentId),
});
const packagedDefaultsSnapshot = dataObject(["method", "secretMode"], {
  method: jsonSchema.enumeration(["symlink", "copy"]),
  secretMode,
  os: dataObject([], {
    win32: dataObject([], { method: jsonSchema.enumeration(["symlink", "copy"]) }),
    darwin: dataObject([], { method: jsonSchema.enumeration(["symlink", "copy"]) }),
    linux: dataObject([], { method: jsonSchema.enumeration(["symlink", "copy"]) }),
  }),
});
const settingsMutationBusinessInput: JsonSchema = {
  oneOf: [
    dataObject(["kind", "action", "agentId", "capabilitySnapshot"], {
      kind: { const: "builtin" },
      action: jsonSchema.enumeration(["enable", "disable", "reset"]),
      agentId,
      capabilitySnapshot: builtinCapabilitySnapshot,
    }),
    dataObject(["kind", "action", "agentId", "adapter", "capabilitySnapshot"], {
      kind: { const: "builtin" },
      action: { const: "configure" },
      agentId,
      adapter: adapterPatch,
      capabilitySnapshot: builtinCapabilitySnapshot,
    }),
    dataObject(["kind", "action", "agentId", "adapter", "capabilitySnapshot"], {
      kind: { const: "custom" },
      action: jsonSchema.enumeration(["add", "update", "upsert"]),
      agentId,
      adapter: adapterBody,
      capabilitySnapshot: builtinCapabilitySnapshot,
    }),
    dataObject(["kind", "action", "agentId", "capabilitySnapshot"], {
      kind: { const: "custom" },
      action: { const: "remove" },
      agentId,
      capabilitySnapshot: builtinCapabilitySnapshot,
    }),
    dataObject(["kind", "action", "settings"], {
      kind: { const: "settings" },
      action: { const: "update" },
      settings: settingsPatch,
    }),
    dataObject(["kind", "action", "fields", "capabilitySnapshot"], {
      kind: { const: "settings" },
      action: { const: "reset" },
      fields: jsonSchema.array(jsonSchema.enumeration(["method", "secretMode", "os"])),
      capabilitySnapshot: dataObject(["packagedDefaults"], {
        packagedDefaults: packagedDefaultsSnapshot,
      }),
    }),
    dataObject(["kind", "action", "collectionName", "resourceIds"], {
      kind: { const: "collection" },
      action: { const: "create" },
      collectionName: jsonSchema.string({ minLength: 1 }),
      description: jsonSchema.string(),
      resourceIds: stringArray,
    }),
    dataObject(["kind", "action", "collectionName", "description"], {
      kind: { const: "collection" },
      action: { const: "update" },
      collectionName: jsonSchema.string({ minLength: 1 }),
      description: jsonSchema.string(),
    }),
    dataObject(["kind", "action", "collectionName"], {
      kind: { const: "collection" },
      action: { const: "delete" },
      collectionName: jsonSchema.string({ minLength: 1 }),
    }),
    dataObject(["kind", "action", "collectionName", "resourceIds"], {
      kind: { const: "collection" },
      action: { const: "set-members" },
      collectionName: jsonSchema.string({ minLength: 1 }),
      resourceIds: stringArray,
    }),
    dataObject(["kind", "action", "collectionNames"], {
      kind: { const: "collection" },
      action: { const: "set-defaults" },
      collectionNames: stringArray,
    }),
  ],
};
const settingsNormalizedInputs = dataObject(
  ["mutationKind", "changedFields", "businessInput", "storeProvenance"],
  {
    mutationKind: jsonSchema.enumeration(settingsMutationKinds),
    changedFields: stringArray,
    businessInput: settingsMutationBusinessInput,
    storeProvenance: jsonSchema.array(storeProvenanceDescriptor),
  },
);
function sealedMutationPlan(
  operation: "apply" | "settings",
  normalizedInputs: JsonSchema,
  actions: JsonSchema,
): JsonSchema {
  return dataObject(
    [
      "schemaVersion",
      "planId",
      "operation",
      "baseRevision",
      "normalizedInputs",
      "targetPreconditions",
      "actions",
      "expires",
      "digest",
      "authorization",
    ],
    {
      schemaVersion: { const: 1 },
      planId: jsonSchema.string({ minLength: 1 }),
      operation: { const: operation },
      baseRevision: jsonSchema.integer(),
      normalizedInputs,
      targetPreconditions: mutationPlanPreconditions,
      actions,
      expires: mutationPlanExpiry,
      digest: jsonSchema.string({ pattern: "^sha256:[0-9a-f]{64}$" }),
      authorization: mutationAuthorization,
    },
  );
}
const distributionMutationPlan = sealedMutationPlan(
  "apply",
  distributionNormalizedInputs,
  jsonSchema.array(mutationPlanAction),
);
const settingsMutationPlan = sealedMutationPlan(
  "settings",
  settingsNormalizedInputs,
  jsonSchema.array(typedMutationPlanAction("publish-file", publicationActionPayload, true)),
);
const applyMutationPlan: JsonSchema = { oneOf: [distributionMutationPlan, settingsMutationPlan] };
const lockOwnerEvidence = dataObject(["operationId", "processId", "hostname", "acquiredAt"], {
  operationId: jsonSchema.string({ minLength: 1 }),
  processId: jsonSchema.integer(),
  hostname: jsonSchema.string({ minLength: 1 }),
  acquiredAt: jsonSchema.string({ minLength: 1 }),
});
const mutationConflict = dataObject(["code", "message"], {
  code: jsonSchema.enumeration([
    "LOCK_CONFLICT",
    "INVALID_PLAN",
    "STALE_REVISION",
    "EXPIRED_PLAN",
    "INVALID_PLAN_DIGEST",
    "TARGET_PRECONDITION_CONFLICT",
    "INTERRUPTED_OPERATION",
    "PARTIAL_FAILURE",
    "MANUAL_RECOVERY_REQUIRED",
  ]),
  message: jsonSchema.string(),
  owner: lockOwnerEvidence,
  operationId: jsonSchema.string({ minLength: 1 }),
  planId: jsonSchema.string({ minLength: 1 }),
  expectedRevision: jsonSchema.integer(),
  actualRevision: jsonSchema.integer(),
  replanRequired: { const: true },
  expiredAt: jsonSchema.string({ minLength: 1 }),
  expectedDigest: jsonSchema.string({ minLength: 1 }),
  actualDigest: jsonSchema.string({ minLength: 1 }),
  actionId: jsonSchema.string({ minLength: 1 }),
  target: jsonSchema.string({ minLength: 1 }),
  expected: targetStateReceipt,
  actual: targetStateReceipt,
  journalStatus: jsonSchema.enumeration([
    "prepared",
    "executing",
    "publishing-state",
    "completed",
    "recovery-required",
  ]),
  failedActionIds: stringArray,
  targets: stringArray,
  guidance: jsonSchema.string(),
});
const operationActionReceipt = dataObject(
  ["actionId", "target", "outcome", "before", "after", "recordedAt"],
  {
    actionId: jsonSchema.string({ minLength: 1 }),
    target: jsonSchema.string({ minLength: 1 }),
    outcome: jsonSchema.enumeration(["applied", "unchanged", "compensated", "failed"]),
    before: targetStateReceipt,
    after: targetStateReceipt,
    recordedAt: jsonSchema.string({ minLength: 1 }),
    error: dataObject(["code", "message"], {
      code: jsonSchema.string({ minLength: 1 }),
      message: jsonSchema.string(),
    }),
  },
);
const operationReceipt = dataObject(
  [
    "schemaVersion",
    "operationId",
    "planId",
    "planDigest",
    "operation",
    "baseRevision",
    "resultingRevision",
    "outcome",
    "actionReceipts",
    "startedAt",
    "completedAt",
  ],
  {
    schemaVersion: { const: 1 },
    operationId: jsonSchema.string({ minLength: 1 }),
    planId: jsonSchema.string({ minLength: 1 }),
    planDigest: jsonSchema.string({ minLength: 1 }),
    operation: mutationOperation,
    baseRevision: jsonSchema.integer(),
    resultingRevision: jsonSchema.integer(),
    outcome: jsonSchema.enumeration(["committed", "compensated", "manual-recovery-required"]),
    actionReceipts: jsonSchema.array(operationActionReceipt),
    startedAt: jsonSchema.string({ minLength: 1 }),
    completedAt: jsonSchema.string({ minLength: 1 }),
  },
);
const presentedOperationResult = dataObject(["ok"], {
  ok: jsonSchema.boolean(),
  receipt: operationReceipt,
  conflict: mutationConflict,
});
const mutationPresentation = dataObject(["planId", "planDigest", "operation", "baseRevision"], {
  planId: jsonSchema.string({ minLength: 1 }),
  planDigest: jsonSchema.string({ minLength: 1 }),
  operation: mutationOperation,
  baseRevision: jsonSchema.integer(),
  result: presentedOperationResult,
});
const controlPlaneOperationReceipt = dataObject(
  [...(operationReceipt.required ?? []), "changedFields"],
  {
    ...(operationReceipt.properties ?? {}),
    changedFields: stringArray,
  },
);
const ledgerEntry = dataObject(
  ["agent", "scope", "capability", "target", "artifactIds", "receipt"],
  {
    agent: jsonSchema.string({ minLength: 1 }),
    scope,
    projectRoot: jsonSchema.string({ minLength: 1 }),
    capability: jsonSchema.enumeration(["rules", "mcp", "skills"]),
    target: jsonSchema.string({ minLength: 1 }),
    artifactIds: stringArray,
    receipt: appliedReceipt,
    secretRefs: stringArray,
  },
);
const applyFailure = dataObject(["code", "target", "message"], {
  code: jsonSchema.enumeration(["SNAPSHOT_FAILED", "ACTION_IO_FAILED"]),
  target: jsonSchema.string({ minLength: 1 }),
  message: jsonSchema.string(),
});
const statusItem = dataObject(["artifact", "agent", "scope", "capability", "target", "status"], {
  artifact: jsonSchema.string({ minLength: 1 }),
  agent: jsonSchema.string({ minLength: 1 }),
  scope,
  capability: jsonSchema.enumeration(["rules", "mcp", "skills"]),
  target: jsonSchema.string({ minLength: 1 }),
  status: jsonSchema.enumeration(["ok", "drifted", "missing", "broken-link"]),
});
const evidenceComparison = jsonSchema.enumeration([
  "matched",
  "mismatched",
  "unverifiable",
  "not-applicable",
]);
const desiredAppliedItem = dataObject(
  [
    "agent",
    "scope",
    "capability",
    "target",
    "status",
    "desiredArtifactIds",
    "appliedArtifactIds",
    "comparisons",
  ],
  {
    agent: jsonSchema.string({ minLength: 1 }),
    scope,
    capability: jsonSchema.enumeration(["rules", "mcp", "skills"]),
    target: jsonSchema.string({ minLength: 1 }),
    status: jsonSchema.enumeration([
      "in-sync",
      "missing-applied",
      "selection-mismatch",
      "content-mismatch",
      "method-mismatch",
      "provenance-mismatch",
      "unverifiable",
      "unexpected-applied",
    ]),
    desiredArtifactIds: stringArray,
    appliedArtifactIds: stringArray,
    desiredMethod: jsonSchema.enumeration(["write", "symlink", "copy"]),
    appliedMethod: jsonSchema.enumeration(["write", "symlink", "copy"]),
    comparisons: dataObject(["selection", "content", "method", "provenance"], {
      selection: evidenceComparison,
      content: evidenceComparison,
      method: evidenceComparison,
      provenance: evidenceComparison,
    }),
  },
);
const distributionApplyOutput = dataObject(["plan", "entries", "failures", "mutation"], {
  plan: distributePlan,
  entries: jsonSchema.array(ledgerEntry),
  failures: jsonSchema.array(applyFailure),
  mutation: mutationPresentation,
});
const settingsApplyOutput = dataObject(["plan", "changedFields", "mutation"], {
  plan: settingsMutationPlan,
  changedFields: stringArray,
  mutation: mutationPresentation,
  receipt: controlPlaneOperationReceipt,
});
const mutationRecoveryDiagnosis = dataObject(["status"], {
  status: jsonSchema.enumeration([
    "clean",
    "incomplete",
    "completed-pending-cleanup",
    "manual-recovery-required",
  ]),
  operationId: jsonSchema.string({ minLength: 1 }),
  planId: jsonSchema.string({ minLength: 1 }),
  baseRevision: jsonSchema.integer(),
  error: mutationConflict,
});
const mutationRecoveryPresentation = mutationRecoveryDiagnosis;
const resourceListOutput = dataObject(["generatedAt", "resources", "counts", "warnings"], {
  generatedAt: jsonSchema.string({ minLength: 1 }),
  resources: jsonSchema.array(controlPlaneResource),
  counts: resourceCounts,
  warnings: stringArray,
});
const agentListOutput = dataObject(["storeRoot", "scope", "agents", "warnings"], {
  storeRoot: jsonSchema.string({ minLength: 1 }),
  scope,
  dir: jsonSchema.string({ minLength: 1 }),
  agents: jsonSchema.array(controlPlaneAgent),
  warnings: stringArray,
});
const collectionListOutput = dataObject(["revision", "collections"], {
  revision: jsonSchema.integer(),
  collections: jsonSchema.array(controlPlaneCollection),
});
const configOutput = dataObject(["revision", "config"], {
  revision: jsonSchema.integer(),
  config: controlPlaneConfig,
});
const diffOutput = dataObject(["storeRevision", "status", "items"], {
  storeRevision: jsonSchema.integer(),
  status: jsonSchema.enumeration(["converged", "diverged"]),
  items: jsonSchema.array(desiredAppliedItem),
});
const desiredAppliedVerification = dataObject(["status", "items"], {
  status: jsonSchema.enumeration(["converged", "diverged"]),
  items: jsonSchema.array(desiredAppliedItem),
});
const appliedDiskVerification = dataObject(["status", "items"], {
  status: jsonSchema.enumeration(["converged", "diverged"]),
  items: jsonSchema.array(statusItem),
});
const verifyOutput = dataObject(
  ["storeRevision", "desiredVsApplied", "appliedVsDisk", "recovery", "healthy"],
  {
    storeRevision: jsonSchema.integer(),
    desiredVsApplied: desiredAppliedVerification,
    appliedVsDisk: appliedDiskVerification,
    recovery: mutationRecoveryPresentation,
    healthy: jsonSchema.boolean(),
  },
);
const dashboardCapabilityReadiness = dataObject(["capability", "status", "paths", "warnings"], {
  capability: jsonSchema.enumeration(["rules", "mcp", "skills"]),
  status: jsonSchema.enumeration(["ready", "warning", "unsupported"]),
  paths: stringArray,
  warnings: stringArray,
});
const dashboardAgentReadiness = dataObject(
  [
    "id",
    "displayName",
    "enabled",
    "scope",
    "detected",
    "status",
    "supportedCapabilities",
    "capabilities",
    "warnings",
  ],
  {
    id: jsonSchema.string({ minLength: 1 }),
    displayName: jsonSchema.string({ minLength: 1 }),
    enabled: jsonSchema.boolean(),
    scope,
    root: jsonSchema.string({ minLength: 1 }),
    detected: jsonSchema.boolean(),
    status: jsonSchema.enumeration([
      "disabled",
      "not-found",
      "detected",
      "ready",
      "warning",
      "unsupported",
    ]),
    supportedCapabilities: capabilityArray,
    capabilities: jsonSchema.array(dashboardCapabilityReadiness),
    warnings: stringArray,
  },
);
const capabilityCounts = dataObject(["rules", "mcp", "skills"], {
  rules: jsonSchema.integer(),
  mcp: jsonSchema.integer(),
  skills: jsonSchema.integer(),
});
const dashboardCoverage = dataObject(
  [
    "collection",
    "scope",
    "percentage",
    "appliedCount",
    "desiredCount",
    "driftedCount",
    "missingCount",
    "brokenLinkCount",
    "blockedCount",
    "targetsCount",
    "artifactsCount",
  ],
  {
    collection: jsonSchema.string({ minLength: 1 }),
    scope,
    percentage: { type: ["integer", "null"], minimum: 0, maximum: 100 },
    appliedCount: jsonSchema.integer(),
    desiredCount: jsonSchema.integer(),
    driftedCount: jsonSchema.integer(),
    missingCount: jsonSchema.integer(),
    brokenLinkCount: jsonSchema.integer(),
    blockedCount: jsonSchema.integer(),
    targetsCount: jsonSchema.integer(),
    artifactsCount: jsonSchema.integer(),
    lastAppliedAt: jsonSchema.string({ minLength: 1 }),
    emptyReason: jsonSchema.string(),
  },
);
const activityEvent = dataObject(
  [
    "version",
    "id",
    "time",
    "actor",
    "action",
    "agents",
    "capabilities",
    "affectedCount",
    "warningsCount",
    "summary",
    "secretRefs",
  ],
  {
    version: { const: 1 },
    id: jsonSchema.string({ minLength: 1 }),
    time: jsonSchema.string({ minLength: 1 }),
    actor: jsonSchema.enumeration(["you", "system"]),
    action: jsonSchema.enumeration(["apply", "scan-import", "revert"]),
    scope,
    projectDir: jsonSchema.string({ minLength: 1 }),
    agents: stringArray,
    capabilities: capabilityArray,
    affectedCount: jsonSchema.integer(),
    warningsCount: jsonSchema.integer(),
    summary: jsonSchema.string(),
    resources: dataObject(["ledgerEntryKeys", "artifactIds"], {
      ledgerEntryKeys: stringArray,
      artifactIds: stringArray,
    }),
    secretRefs: stringArray,
  },
);
const summaryOutput = dataObject(
  [
    "generatedAt",
    "localSafety",
    "scope",
    "collections",
    "capabilities",
    "artifactCounts",
    "agentCounts",
    "driftCounts",
    "secretRefs",
    "isEmptyStore",
    "agents",
    "distributionCoverage",
    "driftItems",
    "latestActivity",
    "warnings",
  ],
  {
    generatedAt: jsonSchema.string({ minLength: 1 }),
    localSafety: dataObject(["localOnly", "host", "database", "secrets"], {
      localOnly: { const: true },
      host: { const: "127.0.0.1" },
      database: { const: false },
      secrets: { const: "[REDACTED]" },
    }),
    scope,
    dir: jsonSchema.string({ minLength: 1 }),
    collections: stringArray,
    capabilities: capabilityArray,
    artifactCounts: dataObject(["rules", "mcp", "skills", "total"], {
      ...capabilityCounts.properties,
      total: jsonSchema.integer(),
    }),
    agentCounts: dataObject(["registered", "detected", "ready", "warning", "missing"], {
      registered: jsonSchema.integer(),
      detected: jsonSchema.integer(),
      ready: jsonSchema.integer(),
      warning: jsonSchema.integer(),
      missing: jsonSchema.integer(),
    }),
    driftCounts: dataObject(["ok", "drifted", "missing", "broken-link"], {
      ok: jsonSchema.integer(),
      drifted: jsonSchema.integer(),
      missing: jsonSchema.integer(),
      "broken-link": jsonSchema.integer(),
    }),
    secretRefs: jsonSchema.array(
      dataObject(["name", "ledgerEntryCount"], {
        name: jsonSchema.string({ minLength: 1 }),
        ledgerEntryCount: jsonSchema.integer(),
      }),
    ),
    isEmptyStore: jsonSchema.boolean(),
    agents: jsonSchema.array(dashboardAgentReadiness),
    distributionCoverage: jsonSchema.array(dashboardCoverage),
    driftItems: jsonSchema.array(statusItem),
    latestActivity: jsonSchema.array(activityEvent),
    latestScanSummary: activityEvent,
    warnings: stringArray,
  },
);
const discoverySummaryOutput = dataObject(
  ["generatedAt", "destination", "totals", "agents", "warnings"],
  {
    generatedAt: jsonSchema.string({ minLength: 1 }),
    destination,
    dir: jsonSchema.string({ minLength: 1 }),
    totals: capabilityCounts,
    agents: jsonSchema.array(
      dataObject(["agent", "displayName", "detected", "counts", "warnings"], {
        agent: jsonSchema.string({ minLength: 1 }),
        displayName: jsonSchema.string({ minLength: 1 }),
        detected: jsonSchema.boolean(),
        root: jsonSchema.string({ minLength: 1 }),
        counts: capabilityCounts,
        warnings: stringArray,
      }),
    ),
    warnings: stringArray,
  },
);
const plannedMutationOutput = dataObject(["plan", "changedFields"], {
  plan: settingsMutationPlan,
  changedFields: stringArray,
  receipt: controlPlaneOperationReceipt,
});
const importedArtifact = dataObject(["kind", "name", "path"], {
  kind: jsonSchema.enumeration(["rules", "mcp", "skills"]),
  name: jsonSchema.string({ minLength: 1 }),
  path: jsonSchema.string({ minLength: 1 }),
});
const rejectedArtifact = dataObject(["kind", "name", "reason"], {
  kind: jsonSchema.enumeration(["rules", "mcp", "skills"]),
  name: jsonSchema.string({ minLength: 1 }),
  reason: jsonSchema.string(),
});
const skillFrontmatter = dataObject(["name", "description"], {
  name: jsonSchema.string({ minLength: 1 }),
  description: jsonSchema.string(),
  metadata: dataObject([], { internal: jsonSchema.boolean() }),
});
const skillCandidate = dataObject(
  [
    "name",
    "description",
    "source",
    "resolvedUrl",
    "ref",
    "commit",
    "subpath",
    "path",
    "internal",
    "warnings",
    "rejected",
    "frontmatter",
  ],
  {
    name: jsonSchema.string({ minLength: 1 }),
    description: jsonSchema.string(),
    source: jsonSchema.string({ minLength: 1 }),
    resolvedUrl: jsonSchema.string({ minLength: 1 }),
    ref: { type: ["string", "null"] },
    commit: { type: ["string", "null"] },
    subpath: jsonSchema.string(),
    path: jsonSchema.string({ minLength: 1 }),
    internal: jsonSchema.boolean(),
    warnings: stringArray,
    rejected: jsonSchema.boolean(),
    rejectionReason: jsonSchema.string(),
    frontmatter: nullableObject(skillFrontmatter),
  },
);
const agentPaths = dataObject([], {
  rules: jsonSchema.string({ minLength: 1 }),
  mcp: jsonSchema.string({ minLength: 1 }),
  skillsDir: jsonSchema.string({ minLength: 1 }),
});
const inspectedAgent = dataObject(
  [
    "id",
    "displayName",
    "enabled",
    "scope",
    "detected",
    "supportedCapabilities",
    "capabilities",
    "paths",
    "warnings",
  ],
  {
    id: jsonSchema.string({ minLength: 1 }),
    displayName: jsonSchema.string({ minLength: 1 }),
    enabled: jsonSchema.boolean(),
    scope,
    detected: jsonSchema.boolean(),
    root: jsonSchema.string({ minLength: 1 }),
    supportedCapabilities: capabilityArray,
    capabilities: dataObject(["rules", "mcp", "skills"], {
      rules: jsonSchema.array(scope),
      mcp: jsonSchema.array(scope),
      skills: jsonSchema.array(scope),
    }),
    paths: agentPaths,
    warnings: stringArray,
  },
);
const diagnosticCheck = dataObject(["id", "status", "message"], {
  id: jsonSchema.string({ minLength: 1 }),
  status: jsonSchema.enumeration(["ok", "warning", "error"]),
  message: jsonSchema.string(),
  path: jsonSchema.string({ minLength: 1 }),
});
const doctorAgent = dataObject([...(inspectedAgent.required ?? []), "checks"], {
  ...(inspectedAgent.properties ?? {}),
  checks: jsonSchema.array(diagnosticCheck),
});
const scanItem = dataObject(["kind", "name", "status", "action", "source"], {
  kind: jsonSchema.enumeration(["rules", "mcp", "skills"]),
  name: jsonSchema.string({ minLength: 1 }),
  status: jsonSchema.enumeration(["new", "conflict"]),
  action: jsonSchema.enumeration(["import", "skip"]),
  secretRefs: stringArray,
  source: jsonSchema.string({ minLength: 1 }),
});
const scanPlan = dataObject(["agent", "scope", "items", "warnings"], {
  agent: jsonSchema.string({ minLength: 1 }),
  scope,
  items: jsonSchema.array(scanItem),
  warnings: stringArray,
});
const revertSnapshot = dataObject(["path", "status", "encrypted"], {
  path: { type: ["string", "null"] },
  status: jsonSchema.enumeration(["none", "available", "missing", "invalid"]),
  encrypted: jsonSchema.boolean(),
  digest: jsonSchema.string({ minLength: 1 }),
  mode: jsonSchema.integer(),
});
const revertTarget = dataObject(
  [
    "target",
    "owners",
    "expectedReceipt",
    "ownership",
    "snapshot",
    "proposedAction",
    "blocked",
    "driftOverridden",
  ],
  {
    target: jsonSchema.string({ minLength: 1 }),
    owners: jsonSchema.array(ledgerEntry),
    expectedReceipt: appliedReceipt,
    ownership: targetOwnership,
    snapshot: revertSnapshot,
    proposedAction: jsonSchema.enumeration(["remove-target", "restore-snapshot"]),
    blocked: jsonSchema.boolean(),
    blockReason: jsonSchema.string(),
    acknowledgement: targetAcknowledgement,
    driftOverridden: jsonSchema.boolean(),
  },
);
const revertPlan = dataObject(["targets", "conflicts", "warnings"], {
  targets: jsonSchema.array(revertTarget),
  conflicts: jsonSchema.array(targetConflict),
  warnings: stringArray,
});
const revertFailure = dataObject(["code", "target", "message"], {
  code: jsonSchema.enumeration(["SNAPSHOT_PASSPHRASE_REQUIRED", "REVERT_FAILED"]),
  target: jsonSchema.string({ minLength: 1 }),
  message: jsonSchema.string(),
});
const operationDetail = dataObject([...(operationReceipt.required ?? []), "recoveryStatus"], {
  ...(operationReceipt.properties ?? {}),
  recoveryStatus: jsonSchema.enumeration(["clean", "manual-recovery-required"]),
});

const resourceId = jsonSchema.string({
  minLength: 1,
  pattern: "^(rules|mcp|skills)/[A-Za-z0-9._-]+$",
});
const syncProfileId = jsonSchema.string({
  minLength: 1,
  pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$",
});
const syncProfileDesired = dataObject(
  ["agentIds", "scope", "resourceIds", "collectionIds", "capabilities", "method", "mergePolicy"],
  {
    agentIds: jsonSchema.array(agentId),
    scope,
    resourceIds: jsonSchema.array(resourceId),
    collectionIds: stringArray,
    capabilities: capabilityArray,
    method: jsonSchema.enumeration(["symlink", "copy"]),
    mergePolicy: { const: "merge" },
  },
);
const opaquePlan = opaqueJsonMap;

function nullableObject(schema: JsonSchema): JsonSchema {
  return { ...schema, type: ["object", "null"] };
}

function controlPlaneScopeProperties(): Readonly<Record<string, JsonSchema>> {
  return {
    scope,
    dir: jsonSchema.string({ minLength: 1 }),
    agents: stringArray,
  };
}

function controlPlaneScopeInput(): JsonSchema {
  return jsonSchema.object(controlPlaneScopeProperties());
}

function controlPlaneScopeBindings(): readonly CommandInputBinding[] {
  return [option("scope"), option("dir"), option("agents", "agent", joinList)];
}

function resourceQueryProperties(): Readonly<Record<string, JsonSchema>> {
  return {
    kind: jsonSchema.enumeration(["rules", "mcp", "skills"]),
    states: jsonSchema.array(resourceState),
    sources: stringArray,
    agents: stringArray,
    collections: stringArray,
    destination,
    dir: jsonSchema.string({ minLength: 1 }),
    includeDiscovered: jsonSchema.boolean(),
  };
}

function resourceQueryInput(): JsonSchema {
  return jsonSchema.object(resourceQueryProperties());
}

function resourceQueryBindings(): readonly CommandInputBinding[] {
  return [
    option("kind"),
    option("states", "state", joinList),
    option("sources", "source", joinList),
    option("agents", "agent", joinList),
    option("collections", "collection", joinList),
    option("destination"),
    option("dir"),
    option("includeDiscovered"),
  ];
}

function verificationProperties(): Readonly<Record<string, JsonSchema>> {
  return {
    scope,
    dir: jsonSchema.string({ minLength: 1 }),
    agents: stringArray,
    collections: stringArray,
    capabilities: capabilityArray,
    method: jsonSchema.enumeration(["symlink", "copy"]),
    mcpStrategy: jsonSchema.enumeration(["merge", "overwrite"]),
  };
}

function verificationInput(): JsonSchema {
  return jsonSchema.object(verificationProperties());
}

function verificationBindings(): readonly CommandInputBinding[] {
  return [
    option("scope"),
    option("dir"),
    option("agents", "agent", joinList),
    option("collections", "collection", joinList),
    ...capabilityBindings(),
    option("method"),
    option("mcpStrategy"),
  ];
}

function profileInvocationProperties(
  includeSnapshotPassphraseFd = false,
): Readonly<Record<string, JsonSchema>> {
  return {
    profileId: syncProfileId,
    workspaceRoot: jsonSchema.string({ minLength: 1 }),
    replaceUnowned: stringArray,
    overrideDrift: stringArray,
    ...(includeSnapshotPassphraseFd
      ? {
          snapshotPassphraseFd: jsonSchema.integer(
            PROTECTED_DESCRIPTOR_MIN,
            PROTECTED_DESCRIPTOR_MAX,
          ),
        }
      : {}),
  };
}

function profileInvocationInput(includeSnapshotPassphraseFd = false): JsonSchema {
  return jsonSchema.object(profileInvocationProperties(includeSnapshotPassphraseFd), ["profileId"]);
}

function profileInvocationBindings(
  includeSnapshotPassphraseFd = false,
): readonly CommandInputBinding[] {
  return [
    positional("profileId", 0),
    option("workspaceRoot"),
    option("replaceUnowned", undefined, joinList),
    option("overrideDrift", undefined, joinList),
    ...(includeSnapshotPassphraseFd ? [option("snapshotPassphraseFd", undefined, stringify)] : []),
  ];
}

function scopeInput(): JsonSchema {
  return jsonSchema.object({
    agents: stringArray,
    dir: jsonSchema.string({ minLength: 1 }),
  });
}

function secretMutationOutput(): JsonSchema {
  return dataObject(["provider", "name", "operation"], {
    provider,
    name: jsonSchema.string(),
    operation: presentedOperationResult,
  });
}

function joinList(value: unknown): unknown {
  return (value as readonly string[]).join(",");
}

function stringify(value: unknown): unknown {
  return String(value);
}

function stringifyJson(value: unknown): unknown {
  return JSON.stringify(value);
}

function option(
  field: string,
  optionName: string | undefined = field,
  encode?: (value: unknown) => unknown,
): CommandInputBinding {
  return { field, option: optionName ?? field, ...(encode ? { encode } : {}) };
}

function positional(field: string, positionalIndex: number): CommandInputBinding {
  return { field, positional: positionalIndex };
}

function scopeBindings(): readonly CommandInputBinding[] {
  return [option("agents", "agent", joinList), option("dir")];
}

function capabilityBindings(): readonly CommandInputBinding[] {
  return [
    option("capabilities", "rules"),
    option("capabilities", "mcp"),
    option("capabilities", "skills"),
  ];
}

export const commandSchemaFragments = Object.freeze({
  CLI_PROTOCOL_VERSION,
  PROTECTED_DESCRIPTOR_MAX,
  PROTECTED_DESCRIPTOR_MIN,
  adapterBody,
  adapterPatch,
  agentId,
  agentListOutput,
  applyMutationPlan,
  artifactArray,
  capabilityArray,
  capabilityBindings,
  collectionListOutput,
  commandCapability,
  configOutput,
  controlPlaneAgent,
  controlPlaneCollection,
  controlPlaneConfig,
  controlPlaneConfigValidationInput,
  controlPlaneResource,
  controlPlaneScopeBindings,
  controlPlaneScopeInput,
  controlPlaneScopeProperties,
  dataObject,
  destination,
  diagnosticCheck,
  diffOutput,
  discoverySummaryOutput,
  distributePlan,
  distributionApplyOutput,
  distributionMutationPlan,
  doctorAgent,
  exactResourceSelector,
  importedArtifact,
  inspectedAgent,
  joinList,
  jsonSchema,
  ledgerEntry,
  mutationPresentation,
  mutationRecoveryDiagnosis,
  mutationRecoveryPresentation,
  nullableObject,
  opaqueJsonMap,
  opaquePlan,
  operationDetail,
  operationSummary,
  option,
  plannedMutationOutput,
  positional,
  presentedOperationResult,
  profileInvocationBindings,
  profileInvocationInput,
  profileInvocationProperties,
  progressEvent,
  protocolSchemaEntry,
  provider,
  rejectedArtifact,
  resourceId,
  resourceListOutput,
  resourceQueryBindings,
  resourceQueryInput,
  resourceQueryProperties,
  revertFailure,
  revertPlan,
  scanItem,
  scanPlan,
  scope,
  scopeBindings,
  scopeInput,
  secretMode,
  secretMutationOutput,
  settingsApplyOutput,
  settingsPatch,
  skillCandidate,
  statusItem,
  stringArray,
  stringify,
  stringifyJson,
  summaryOutput,
  syncProfileDesired,
  syncProfileId,
  validationIssue,
  verificationBindings,
  verificationInput,
  verificationProperties,
  verifyOutput,
});
