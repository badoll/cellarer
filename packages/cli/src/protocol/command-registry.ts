import {
  AGENT_ID_PATTERN,
  CLI_PROTOCOL_VERSION,
  NORMALIZED_STORE_RELATIVE_SOURCE_PATTERN,
} from "@cellarer/core";
import type { JsonSchema } from "./schemas.js";
import {
  assertClosedJsonSchema,
  CLI_ERROR_SCHEMA,
  CLI_WARNING_SCHEMA,
  createCommandProtocolSchemas,
  jsonSchema,
  PROTECTED_DESCRIPTOR_MAX,
  PROTECTED_DESCRIPTOR_MIN,
} from "./schemas.js";

export type CommandMutability = "read" | "write" | "service";

export interface CommandInputBinding {
  readonly field: string;
  readonly option?: string;
  readonly positional?: number;
  readonly encode?: (value: unknown) => unknown;
}

export interface CommandDefinition<TCommand extends string = string> {
  readonly command: TCommand;
  readonly mutability: CommandMutability;
  readonly streaming: boolean;
  readonly requiredFeatures: readonly string[];
  readonly inputSchemaId: string;
  readonly outputSchemaId: string;
  readonly eventSchemaId?: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly eventSchema?: JsonSchema;
  readonly inputBindings: readonly CommandInputBinding[];
}

export interface CommandCapability {
  readonly command: string;
  readonly mutability: CommandMutability;
  readonly streaming: boolean;
  readonly inputSchemaId: string;
  readonly outputSchemaId: string;
  readonly eventSchemaId?: string;
  readonly requiredFeatures: readonly string[];
}

export interface CliCapabilities {
  readonly protocolVersions: readonly string[];
  readonly commands: readonly CommandCapability[];
}

export interface ProtocolSchemaEntry {
  readonly schemaId: string;
  readonly schema: JsonSchema;
}

export interface ProtocolSchemaBundle {
  readonly bundleVersion: 1;
  readonly protocolVersion: typeof CLI_PROTOCOL_VERSION;
  readonly schemas: readonly ProtocolSchemaEntry[];
}

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

const legacyCommandRegistry = [
  defineCommand({
    command: "init",
    mutability: "write",
    requiredFeatures: ["mutation-authority", "exact-agent-targets"],
    input: jsonSchema.object({
      global: jsonSchema.boolean(),
      agents: stringArray,
      dryRun: jsonSchema.boolean(),
    }),
    bindings: [option("global"), option("agents", "agent", joinList), option("dryRun")],
    output: {
      oneOf: [
        dataObject(["dryRun", "storeRoot", "agentTargets", "inventory"], {
          dryRun: { const: true },
          storeRoot: jsonSchema.string(),
          agentTargets: stringArray,
          inventory: agentListOutput,
        }),
        dataObject(["storeRoot", "createdConfig", "operation", "inventory"], {
          storeRoot: jsonSchema.string(),
          createdConfig: jsonSchema.boolean(),
          operation: presentedOperationResult,
          inventory: agentListOutput,
        }),
      ],
    },
  }),
  defineCommand({
    command: "add",
    mutability: "write",
    requiredFeatures: ["mutation-authority"],
    input: jsonSchema.object(
      {
        source: jsonSchema.string({ minLength: 1 }),
        force: jsonSchema.boolean(),
        list: jsonSchema.boolean(),
        skills: stringArray,
        all: jsonSchema.boolean(),
        collection: jsonSchema.string({ minLength: 1 }),
        yes: jsonSchema.boolean(),
        secretMode,
        vaultPassphraseFd: jsonSchema.integer(PROTECTED_DESCRIPTOR_MIN, PROTECTED_DESCRIPTOR_MAX),
        keychainService: jsonSchema.string({ minLength: 1 }),
      },
      ["source"],
    ),
    bindings: [
      positional("source", 0),
      option("force"),
      option("list"),
      option("skills", "skill"),
      option("all"),
      option("collection"),
      option("yes"),
      option("secretMode"),
      option("vaultPassphraseFd", undefined, stringify),
      option("keychainService"),
    ],
    output: dataObject(["imported", "skipped", "rejected", "candidates"], {
      imported: jsonSchema.array(importedArtifact),
      skipped: jsonSchema.array(rejectedArtifact),
      rejected: jsonSchema.array(rejectedArtifact),
      candidates: jsonSchema.array(skillCandidate),
      operation: presentedOperationResult,
    }),
  }),
  defineCommand({
    command: "agents",
    mutability: "read",
    input: scopeInput(),
    bindings: scopeBindings(),
    output: dataObject(["storeRoot", "scope", "agents"], {
      storeRoot: jsonSchema.string(),
      scope: jsonSchema.enumeration(["global", "project"]),
      dir: jsonSchema.string({ minLength: 1 }),
      agents: jsonSchema.array(inspectedAgent),
    }),
  }),
  defineCommand({
    command: "ls",
    mutability: "read",
    input: jsonSchema.object({ collection: jsonSchema.string({ minLength: 1 }) }),
    bindings: [option("collection")],
    output: dataObject(["artifacts", "storeEmpty"], {
      artifacts: artifactArray,
      storeEmpty: jsonSchema.boolean(),
    }),
  }),
  defineCommand({
    command: "apply",
    mutability: "write",
    streaming: true,
    requiredFeatures: ["mutation-authority", "plan-apply", "protected-secret-channel"],
    input: jsonSchema.object(
      {
        plan: applyMutationPlan,
        agents: stringArray,
        dir: jsonSchema.string({ minLength: 1 }),
        collection: jsonSchema.string({ minLength: 1 }),
        capabilities: capabilityArray,
        copy: jsonSchema.boolean(),
        mcpOverwrite: jsonSchema.boolean(),
        secretMode,
        vaultPassphraseFd: jsonSchema.integer(PROTECTED_DESCRIPTOR_MIN, PROTECTED_DESCRIPTOR_MAX),
        keychainService: jsonSchema.string({ minLength: 1 }),
        replaceUnowned: stringArray,
        overrideDrift: stringArray,
        snapshotPassphraseFd: jsonSchema.integer(
          PROTECTED_DESCRIPTOR_MIN,
          PROTECTED_DESCRIPTOR_MAX,
        ),
        dryRun: jsonSchema.boolean(),
      },
      [],
    ),
    bindings: [
      option("plan", undefined, stringifyJson),
      option("agents", "agent", joinList),
      option("dir"),
      option("collection"),
      ...capabilityBindings(),
      option("copy"),
      option("mcpOverwrite"),
      option("secretMode"),
      option("vaultPassphraseFd", undefined, stringify),
      option("keychainService"),
      option("replaceUnowned", undefined, joinList),
      option("overrideDrift", undefined, joinList),
      option("snapshotPassphraseFd", undefined, stringify),
      option("dryRun"),
    ],
    output: { oneOf: [distributionApplyOutput, settingsApplyOutput] },
    event: progressEvent,
  }),
  defineCommand({
    command: "authority.rotate",
    mutability: "write",
    requiredFeatures: ["mutation-authority"],
    input: jsonSchema.object(),
    bindings: [],
    output: dataObject(["operation"], {
      operation: dataObject(["rotated"], { rotated: { const: true } }),
    }),
  }),
  defineCommand({
    command: "scan",
    mutability: "write",
    streaming: true,
    requiredFeatures: ["mutation-authority", "protected-secret-channel"],
    input: jsonSchema.object(
      {
        agent: jsonSchema.string({ minLength: 1 }),
        dir: jsonSchema.string({ minLength: 1 }),
        capabilities: capabilityArray,
        intoCollection: jsonSchema.string({ minLength: 1 }),
        conflict: jsonSchema.enumeration(["keep-theirs", "keep-mine", "copy"]),
        select: jsonSchema.array(exactResourceSelector),
        dryRun: jsonSchema.boolean(),
        secretMode,
        vaultPassphraseFd: jsonSchema.integer(PROTECTED_DESCRIPTOR_MIN, PROTECTED_DESCRIPTOR_MAX),
        keychainService: jsonSchema.string({ minLength: 1 }),
      },
      ["agent"],
    ),
    bindings: [
      option("agent"),
      option("dir"),
      ...capabilityBindings(),
      option("intoCollection"),
      option("conflict"),
      option("select", undefined, stringifyJson),
      option("dryRun"),
      option("secretMode"),
      option("vaultPassphraseFd", undefined, stringify),
      option("keychainService"),
    ],
    output: dataObject(["plan", "imported"], {
      plan: scanPlan,
      imported: jsonSchema.array(scanItem),
      operation: presentedOperationResult,
    }),
    event: progressEvent,
  }),
  defineCommand({
    command: "revert",
    mutability: "write",
    streaming: true,
    requiredFeatures: ["mutation-authority", "plan-apply"],
    input: jsonSchema.object({
      agents: stringArray,
      dir: jsonSchema.string({ minLength: 1 }),
      all: jsonSchema.boolean(),
      keepBackups: jsonSchema.boolean(),
      acknowledgements: stringArray,
      snapshotPassphraseFd: jsonSchema.integer(PROTECTED_DESCRIPTOR_MIN, PROTECTED_DESCRIPTOR_MAX),
      dryRun: jsonSchema.boolean(),
    }),
    bindings: [
      option("agents", "agent", joinList),
      option("dir"),
      option("all"),
      option("keepBackups"),
      option("acknowledgements", "acknowledge", joinList),
      option("snapshotPassphraseFd", undefined, stringify),
      option("dryRun"),
    ],
    output: dataObject(["plan", "reverted", "failures", "mutation", "warnings"], {
      plan: revertPlan,
      reverted: jsonSchema.array(ledgerEntry),
      failures: jsonSchema.array(revertFailure),
      mutation: mutationPresentation,
      warnings: stringArray,
    }),
    event: progressEvent,
  }),
  defineCommand({
    command: "status",
    mutability: "read",
    input: scopeInput(),
    bindings: scopeBindings(),
    output: dataObject(["items"], {
      items: jsonSchema.array(statusItem),
      verification: verifyOutput,
    }),
  }),
  defineCommand({
    command: "secret.add",
    mutability: "write",
    requiredFeatures: ["protected-secret-channel"],
    input: jsonSchema.object(
      {
        name: jsonSchema.string({ minLength: 1 }),
        provider,
        stdin: jsonSchema.boolean(),
        fd: jsonSchema.integer(PROTECTED_DESCRIPTOR_MIN, PROTECTED_DESCRIPTOR_MAX),
        passphraseFd: jsonSchema.integer(PROTECTED_DESCRIPTOR_MIN, PROTECTED_DESCRIPTOR_MAX),
      },
      ["name"],
    ),
    bindings: [
      positional("name", 0),
      option("provider"),
      option("stdin"),
      option("fd", undefined, stringify),
      option("passphraseFd", undefined, stringify),
    ],
    output: secretMutationOutput(),
  }),
  defineCommand({
    command: "secret.ls",
    mutability: "read",
    requiredFeatures: ["protected-secret-channel"],
    input: jsonSchema.object({
      passphraseFd: jsonSchema.integer(PROTECTED_DESCRIPTOR_MIN, PROTECTED_DESCRIPTOR_MAX),
    }),
    bindings: [option("passphraseFd", undefined, stringify)],
    output: dataObject(["names"], { names: stringArray }),
  }),
  defineCommand({
    command: "secret.rm",
    mutability: "write",
    requiredFeatures: ["protected-secret-channel"],
    input: jsonSchema.object(
      {
        name: jsonSchema.string({ minLength: 1 }),
        provider,
        passphraseFd: jsonSchema.integer(PROTECTED_DESCRIPTOR_MIN, PROTECTED_DESCRIPTOR_MAX),
      },
      ["name"],
    ),
    bindings: [
      positional("name", 0),
      option("provider"),
      option("passphraseFd", undefined, stringify),
    ],
    output: secretMutationOutput(),
  }),
  defineCommand({
    command: "doctor",
    mutability: "read",
    input: scopeInput(),
    bindings: scopeBindings(),
    output: dataObject(
      ["storeRoot", "scope", "checks", "agents", "mutationRecovery", "limitations"],
      {
        storeRoot: jsonSchema.string(),
        scope: jsonSchema.enumeration(["global", "project"]),
        dir: jsonSchema.string({ minLength: 1 }),
        defaultMethod: jsonSchema.enumeration(["symlink", "copy"]),
        checks: jsonSchema.array(diagnosticCheck),
        agents: jsonSchema.array(doctorAgent),
        mutationRecovery: mutationRecoveryPresentation,
        limitations: jsonSchema.array({
          oneOf: [
            dataObject(["capability", "code", "reason"], {
              capability: { const: "native-keychain" },
              code: { const: "KEYCHAIN_MODULE_UNAVAILABLE" },
              reason: { const: "module-unavailable" },
            }),
            dataObject(["capability", "code", "reason"], {
              capability: { const: "native-keychain" },
              code: { const: "KEYCHAIN_SMOKE_ISOLATION_UNAVAILABLE" },
              reason: { const: "credential-store-not-isolated" },
            }),
          ],
        }),
      },
    ),
  }),
  defineCommand({
    command: "ui",
    mutability: "service",
    requiredFeatures: ["long-running-process", "protected-secret-channel"],
    input: jsonSchema.object({
      port: jsonSchema.integer(1, 65_535),
      tokenFd: jsonSchema.integer(PROTECTED_DESCRIPTOR_MIN, PROTECTED_DESCRIPTOR_MAX),
    }),
    bindings: [option("port", undefined, stringify), option("tokenFd", undefined, stringify)],
    output: dataObject(["url", "port"], {
      url: jsonSchema.string(),
      port: jsonSchema.integer(1, 65_535),
    }),
  }),
  defineCommand({
    command: "capabilities",
    mutability: "read",
    input: jsonSchema.object(),
    bindings: [],
    output: jsonSchema.object(
      {
        protocolVersions: stringArray,
        commands: jsonSchema.array(commandCapability),
      },
      ["protocolVersions", "commands"],
    ),
  }),
  defineCommand({
    command: "schema",
    mutability: "read",
    input: jsonSchema.object({ schemaId: jsonSchema.string({ minLength: 1 }) }),
    bindings: [positional("schemaId", 0)],
    output: jsonSchema.object(
      {
        bundleVersion: { const: 1 },
        protocolVersion: { const: CLI_PROTOCOL_VERSION },
        schemas: jsonSchema.array(protocolSchemaEntry),
      },
      ["bundleVersion", "protocolVersion", "schemas"],
    ),
  }),
] as const satisfies readonly CommandDefinition[];

// These contracts describe the complete control-plane surface. Task groups promote definitions
// into commandRegistry only after the corresponding executable leaf handlers exist.
export const controlPlaneCommandRegistry = [
  defineCommand({
    command: "resource.list",
    mutability: "read",
    requiredFeatures: ["exact-resource-selector"],
    input: resourceQueryInput(),
    bindings: resourceQueryBindings(),
    output: resourceListOutput,
  }),
  defineCommand({
    command: "resource.show",
    mutability: "read",
    requiredFeatures: ["exact-resource-selector"],
    input: jsonSchema.object(
      {
        resourceId: jsonSchema.string({ minLength: 1 }),
        ...resourceQueryProperties(),
      },
      ["resourceId"],
    ),
    bindings: [positional("resourceId", 0), ...resourceQueryBindings()],
    output: dataObject(["resource", "warnings"], {
      resource: nullableObject(controlPlaneResource),
      warnings: stringArray,
    }),
  }),
  defineCommand({
    command: "agent.list",
    mutability: "read",
    input: controlPlaneScopeInput(),
    bindings: controlPlaneScopeBindings(),
    output: agentListOutput,
  }),
  defineCommand({
    command: "agent.show",
    mutability: "read",
    input: jsonSchema.object({ agentId, ...controlPlaneScopeProperties() }, ["agentId"]),
    bindings: [positional("agentId", 0), ...controlPlaneScopeBindings()],
    output: dataObject(["agent", "warnings"], {
      agent: nullableObject(controlPlaneAgent),
      warnings: stringArray,
    }),
  }),
  defineControlPlaneMutation({
    command: "agent.enable",
    properties: { agentId },
    required: ["agentId"],
    bindings: [positional("agentId", 0)],
  }),
  defineControlPlaneMutation({
    command: "agent.disable",
    properties: { agentId },
    required: ["agentId"],
    bindings: [positional("agentId", 0)],
  }),
  defineControlPlaneMutation({
    command: "agent.configure",
    properties: {
      agentId,
      adapter: adapterPatch,
    },
    required: ["agentId", "adapter"],
    bindings: [positional("agentId", 0), option("adapter")],
  }),
  defineControlPlaneMutation({
    command: "agent.reset",
    properties: { agentId },
    required: ["agentId"],
    bindings: [positional("agentId", 0)],
  }),
  defineControlPlaneMutation({
    command: "agent.add",
    properties: {
      agentId,
      adapter: adapterBody,
    },
    required: ["agentId", "adapter"],
    bindings: [positional("agentId", 0), option("adapter")],
  }),
  defineControlPlaneMutation({
    command: "agent.update",
    properties: {
      agentId,
      adapter: adapterBody,
    },
    required: ["agentId", "adapter"],
    bindings: [positional("agentId", 0), option("adapter")],
  }),
  defineControlPlaneMutation({
    command: "agent.remove",
    properties: { agentId },
    required: ["agentId"],
    bindings: [positional("agentId", 0)],
  }),
  defineCommand({
    command: "collection.list",
    mutability: "read",
    input: jsonSchema.object(),
    bindings: [],
    output: collectionListOutput,
  }),
  defineCommand({
    command: "collection.show",
    mutability: "read",
    input: jsonSchema.object({ collectionName: jsonSchema.string({ minLength: 1 }) }, [
      "collectionName",
    ]),
    bindings: [positional("collectionName", 0)],
    output: dataObject(["revision", "collection"], {
      revision: jsonSchema.integer(),
      collection: nullableObject(controlPlaneCollection),
    }),
  }),
  defineControlPlaneMutation({
    command: "collection.create",
    properties: {
      collectionName: jsonSchema.string({ minLength: 1 }),
      description: jsonSchema.string(),
      resourceIds: stringArray,
    },
    required: ["collectionName", "resourceIds"],
    bindings: [
      positional("collectionName", 0),
      option("description"),
      option("resourceIds", "resource", joinList),
    ],
    requiredFeatures: ["exact-resource-selector"],
  }),
  defineControlPlaneMutation({
    command: "collection.update",
    properties: {
      collectionName: jsonSchema.string({ minLength: 1 }),
      description: jsonSchema.string(),
    },
    required: ["collectionName", "description"],
    bindings: [positional("collectionName", 0), option("description")],
  }),
  defineControlPlaneMutation({
    command: "collection.delete",
    properties: { collectionName: jsonSchema.string({ minLength: 1 }) },
    required: ["collectionName"],
    bindings: [positional("collectionName", 0)],
  }),
  defineControlPlaneMutation({
    command: "collection.members.set",
    properties: {
      collectionName: jsonSchema.string({ minLength: 1 }),
      resourceIds: stringArray,
    },
    required: ["collectionName", "resourceIds"],
    bindings: [positional("collectionName", 0), option("resourceIds", "resource", joinList)],
    requiredFeatures: ["exact-resource-selector"],
  }),
  defineControlPlaneMutation({
    command: "collection.defaults.set",
    properties: { collectionNames: stringArray },
    required: ["collectionNames"],
    bindings: [option("collectionNames", "collection", joinList)],
  }),
  defineCommand({
    command: "config.show",
    mutability: "read",
    input: jsonSchema.object(),
    bindings: [],
    output: configOutput,
  }),
  defineCommand({
    command: "config.validate",
    mutability: "read",
    input: jsonSchema.object({ config: controlPlaneConfigValidationInput }, ["config"]),
    bindings: [option("config")],
    output: dataObject(["valid", "issues"], {
      valid: jsonSchema.boolean(),
      config: controlPlaneConfig,
      issues: jsonSchema.array(validationIssue),
    }),
  }),
  defineControlPlaneMutation({
    command: "config.update",
    properties: { settings: settingsPatch },
    required: ["settings"],
    bindings: [option("settings")],
  }),
  defineControlPlaneMutation({
    command: "config.reset",
    properties: { fields: stringArray },
    bindings: [option("fields", "field", joinList)],
  }),
  defineCommand({
    command: "diff",
    mutability: "read",
    input: verificationInput(),
    bindings: verificationBindings(),
    output: diffOutput,
  }),
  defineCommand({
    command: "verify",
    mutability: "read",
    input: verificationInput(),
    bindings: verificationBindings(),
    output: verifyOutput,
  }),
  defineCommand({
    command: "summary",
    mutability: "read",
    input: jsonSchema.object({
      ...verificationProperties(),
      activityLimit: jsonSchema.integer(),
      includePlanCoverage: jsonSchema.boolean(),
    }),
    bindings: [
      ...verificationBindings(),
      option("activityLimit", "limit", stringify),
      option("includePlanCoverage"),
    ],
    output: summaryOutput,
  }),
  defineCommand({
    command: "discovery.summary",
    mutability: "read",
    input: jsonSchema.object(
      {
        destination,
        dir: jsonSchema.string({ minLength: 1 }),
        agents: stringArray,
      },
      ["destination"],
    ),
    bindings: [option("destination"), option("dir"), option("agents", "agent", joinList)],
    output: discoverySummaryOutput,
  }),
  defineCommand({
    command: "operation.list",
    mutability: "read",
    input: jsonSchema.object({ limit: jsonSchema.integer() }),
    bindings: [option("limit", undefined, stringify)],
    output: dataObject(["operations"], { operations: jsonSchema.array(operationSummary) }),
  }),
  defineCommand({
    command: "operation.show",
    mutability: "read",
    input: jsonSchema.object({ operationId: jsonSchema.string({ minLength: 1 }) }, ["operationId"]),
    bindings: [positional("operationId", 0)],
    output: dataObject(["operation"], { operation: nullableObject(operationDetail) }),
  }),
  defineCommand({
    command: "operation.recover",
    mutability: "write",
    requiredFeatures: ["mutation-authority", "plan-apply", "recovery"],
    input: jsonSchema.object(
      {
        operationId: jsonSchema.string({ minLength: 1 }),
        snapshotPassphraseFd: jsonSchema.integer(
          PROTECTED_DESCRIPTOR_MIN,
          PROTECTED_DESCRIPTOR_MAX,
        ),
        dryRun: jsonSchema.boolean(),
      },
      ["operationId"],
    ),
    bindings: [
      positional("operationId", 0),
      option("snapshotPassphraseFd", undefined, stringify),
      option("dryRun"),
    ],
    output: dataObject([], {
      diagnosis: mutationRecoveryDiagnosis,
      operation: presentedOperationResult,
    }),
  }),
  defineCommand({
    command: "plan",
    mutability: "read",
    requiredFeatures: ["mutation-authority", "plan-apply", "exact-resource-selector"],
    input: jsonSchema.object(
      {
        agents: stringArray,
        scope,
        dir: jsonSchema.string({ minLength: 1 }),
        collections: stringArray,
        capabilities: capabilityArray,
        method: jsonSchema.enumeration(["symlink", "copy"]),
        mcpStrategy: jsonSchema.enumeration(["merge", "overwrite"]),
      },
      ["agents"],
    ),
    bindings: [
      option("agents", "agent", joinList),
      option("scope"),
      option("dir"),
      option("collections", "collection", joinList),
      ...capabilityBindings(),
      option("method"),
      option("mcpStrategy"),
    ],
    output: dataObject(["plan", "preview"], {
      plan: distributionMutationPlan,
      preview: distributePlan,
    }),
  }),
] as const satisfies readonly CommandDefinition[];

export type ControlPlaneCommand = (typeof controlPlaneCommandRegistry)[number]["command"];

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

export const lifecycleProfileCommandRegistry = [
  defineCommand({
    command: "resource.dependencies",
    mutability: "read",
    requiredFeatures: ["exact-resource-selector"],
    input: jsonSchema.object({ resourceId }, ["resourceId"]),
    bindings: [positional("resourceId", 0)],
    output: opaqueJsonMap,
  }),
  defineCommand({
    command: "resource.check",
    mutability: "read",
    requiredFeatures: ["exact-resource-selector", "resource-provenance"],
    input: jsonSchema.object({ resourceId }, ["resourceId"]),
    bindings: [positional("resourceId", 0)],
    output: opaqueJsonMap,
  }),
  defineCommand({
    command: "resource.update",
    mutability: "write",
    requiredFeatures: ["mutation-authority", "plan-apply", "resource-provenance"],
    input: jsonSchema.object({ resourceId, plan: opaquePlan, dryRun: jsonSchema.boolean() }, [
      "resourceId",
    ]),
    bindings: [
      positional("resourceId", 0),
      option("plan", undefined, stringifyJson),
      option("dryRun"),
    ],
    output: opaqueJsonMap,
  }),
  defineCommand({
    command: "resource.rename",
    mutability: "write",
    requiredFeatures: ["mutation-authority", "plan-apply", "exact-resource-selector"],
    input: jsonSchema.object(
      {
        resourceId,
        newName: jsonSchema.string({ minLength: 1 }),
        localFork: jsonSchema.boolean(),
        plan: opaquePlan,
        dryRun: jsonSchema.boolean(),
      },
      ["resourceId", "newName"],
    ),
    bindings: [
      positional("resourceId", 0),
      positional("newName", 1),
      option("localFork"),
      option("plan", undefined, stringifyJson),
      option("dryRun"),
    ],
    output: opaqueJsonMap,
  }),
  defineCommand({
    command: "resource.remove",
    mutability: "write",
    requiredFeatures: ["mutation-authority", "plan-apply", "exact-resource-selector"],
    input: jsonSchema.object(
      { resourceId, cascade: jsonSchema.boolean(), plan: opaquePlan, dryRun: jsonSchema.boolean() },
      ["resourceId"],
    ),
    bindings: [
      positional("resourceId", 0),
      option("cascade"),
      option("plan", undefined, stringifyJson),
      option("dryRun"),
    ],
    output: opaqueJsonMap,
  }),
  defineCommand({
    command: "resource.export",
    mutability: "write",
    requiredFeatures: ["mutation-authority", "plan-apply", "reference-only-export"],
    input: jsonSchema.object(
      {
        resourceId,
        bundlePath: jsonSchema.string({ minLength: 1 }),
        plan: opaquePlan,
        dryRun: jsonSchema.boolean(),
      },
      ["resourceId", "bundlePath"],
    ),
    bindings: [
      positional("resourceId", 0),
      positional("bundlePath", 1),
      option("plan", undefined, stringifyJson),
      option("dryRun"),
    ],
    output: opaqueJsonMap,
  }),
  defineCommand({
    command: "resource.import",
    mutability: "write",
    requiredFeatures: ["mutation-authority", "plan-apply", "reference-only-export"],
    input: jsonSchema.object(
      {
        bundlePath: jsonSchema.string({ minLength: 1 }),
        plan: opaquePlan,
        dryRun: jsonSchema.boolean(),
      },
      ["bundlePath"],
    ),
    bindings: [
      positional("bundlePath", 0),
      option("plan", undefined, stringifyJson),
      option("dryRun"),
    ],
    output: opaqueJsonMap,
  }),
  defineCommand({
    command: "profile.list",
    mutability: "read",
    input: jsonSchema.object(),
    bindings: [],
    output: opaqueJsonMap,
  }),
  defineCommand({
    command: "profile.show",
    mutability: "read",
    input: jsonSchema.object({ profileId: syncProfileId }, ["profileId"]),
    bindings: [positional("profileId", 0)],
    output: opaqueJsonMap,
  }),
  ...(["create", "update"] as const).map((action) =>
    defineCommand({
      command: `profile.${action}`,
      mutability: "write",
      requiredFeatures: ["mutation-authority", "plan-apply", "sync-profiles"],
      input: jsonSchema.object(
        { profileId: syncProfileId, desired: syncProfileDesired, dryRun: jsonSchema.boolean() },
        ["profileId", "desired"],
      ),
      bindings: [
        positional("profileId", 0),
        option("desired", undefined, stringifyJson),
        option("dryRun"),
      ],
      output: opaqueJsonMap,
    }),
  ),
  defineCommand({
    command: "profile.delete",
    mutability: "write",
    requiredFeatures: ["mutation-authority", "plan-apply", "sync-profiles"],
    input: jsonSchema.object({ profileId: syncProfileId, dryRun: jsonSchema.boolean() }, [
      "profileId",
    ]),
    bindings: [positional("profileId", 0), option("dryRun")],
    output: opaqueJsonMap,
  }),
  defineCommand({
    command: "sync.plan",
    mutability: "read",
    requiredFeatures: ["mutation-authority", "plan-apply", "sync-profiles"],
    input: profileInvocationInput(true),
    bindings: profileInvocationBindings(true),
    output: opaqueJsonMap,
  }),
  defineCommand({
    command: "sync.apply",
    mutability: "write",
    requiredFeatures: ["mutation-authority", "plan-apply", "sync-profiles"],
    input: jsonSchema.object({ ...profileInvocationProperties(true), plan: opaquePlan }, [
      "profileId",
      "plan",
    ]),
    bindings: [...profileInvocationBindings(true), option("plan", undefined, stringifyJson)],
    output: opaqueJsonMap,
  }),
  defineCommand({
    command: "sync.verify",
    mutability: "read",
    requiredFeatures: ["mutation-authority", "sync-profiles"],
    input: profileInvocationInput(),
    bindings: profileInvocationBindings(),
    output: opaqueJsonMap,
  }),
  defineCommand({
    command: "sync.uninstall",
    mutability: "write",
    requiredFeatures: ["mutation-authority", "plan-apply", "sync-profiles"],
    input: jsonSchema.object(
      {
        ...profileInvocationProperties(),
        plan: opaquePlan,
        acknowledgements: stringArray,
        dryRun: jsonSchema.boolean(),
      },
      ["profileId"],
    ),
    bindings: [
      ...profileInvocationBindings(),
      option("plan", undefined, stringifyJson),
      option("acknowledgements", "acknowledge", joinList),
      option("dryRun"),
    ],
    output: opaqueJsonMap,
  }),
] as const satisfies readonly CommandDefinition[];

const implementedControlPlaneCommandNames = [
  "resource.list",
  "resource.show",
  "agent.list",
  "agent.show",
  "agent.enable",
  "agent.disable",
  "agent.configure",
  "agent.reset",
  "agent.add",
  "agent.update",
  "agent.remove",
  "collection.list",
  "collection.show",
  "collection.create",
  "collection.update",
  "collection.delete",
  "collection.members.set",
  "collection.defaults.set",
  "config.show",
  "config.validate",
  "config.update",
  "config.reset",
  "diff",
  "verify",
  "summary",
  "discovery.summary",
  "operation.list",
  "operation.show",
  "operation.recover",
  "plan",
] as const satisfies readonly ControlPlaneCommand[];

const implementedControlPlaneCommandRegistry = implementedControlPlaneCommandNames.map((command) =>
  requireControlPlaneCommand(command),
);

export const commandRegistry = [
  ...legacyCommandRegistry,
  ...implementedControlPlaneCommandRegistry,
  ...lifecycleProfileCommandRegistry,
] as const satisfies readonly CommandDefinition[];

export type RegisteredCommand = (typeof commandRegistry)[number]["command"];

export const commandSchemas: Readonly<Record<string, JsonSchema>> = Object.fromEntries(
  commandRegistry.flatMap((definition) => [
    [definition.inputSchemaId, definition.inputSchema],
    [definition.outputSchemaId, definition.outputSchema],
    ...(definition.eventSchema && definition.eventSchemaId
      ? [[definition.eventSchemaId, definition.eventSchema] as const]
      : []),
  ]),
);

export const protocolSchemas: Readonly<Record<string, JsonSchema>> = Object.freeze({
  [requiredSchemaId(CLI_WARNING_SCHEMA)]: CLI_WARNING_SCHEMA,
  [requiredSchemaId(CLI_ERROR_SCHEMA)]: CLI_ERROR_SCHEMA,
  ...commandSchemas,
});
const canonicalProtocolSchemas: Readonly<Record<string, JsonSchema>> = Object.freeze(
  Object.fromEntries(
    Object.entries(protocolSchemas).map(([schemaId, schema]) => [
      schemaId,
      immutableJsonSnapshot(schema),
    ]),
  ),
);
const publicSchemaBundles = new WeakSet<object>();

export function getCliCapabilities(): CliCapabilities {
  return {
    protocolVersions: [CLI_PROTOCOL_VERSION],
    commands: commandRegistry.map((definition) => ({
      command: definition.command,
      mutability: definition.mutability,
      streaming: definition.streaming,
      inputSchemaId: definition.inputSchemaId,
      outputSchemaId: definition.outputSchemaId,
      ...(definition.eventSchemaId === undefined
        ? {}
        : { eventSchemaId: definition.eventSchemaId }),
      requiredFeatures: [...definition.requiredFeatures],
    })),
  };
}

export function getProtocolSchemaBundle(schemaId?: string): ProtocolSchemaBundle | undefined {
  if (schemaId !== undefined && canonicalProtocolSchemas[schemaId] === undefined) return undefined;
  const schemaIds =
    schemaId === undefined ? Object.keys(canonicalProtocolSchemas).sort() : [schemaId];
  const schemas = Object.freeze(
    schemaIds.map((id) =>
      Object.freeze({ schemaId: id, schema: canonicalProtocolSchemas[id] as JsonSchema }),
    ),
  );
  const bundle: ProtocolSchemaBundle = Object.freeze({
    bundleVersion: 1,
    protocolVersion: CLI_PROTOCOL_VERSION,
    schemas,
  });
  publicSchemaBundles.add(bundle);
  return bundle;
}

export function isPublicProtocolSchemaBundle(value: unknown): value is ProtocolSchemaBundle {
  return typeof value === "object" && value !== null && publicSchemaBundles.has(value);
}

export function getCommandDefinition(command: string): CommandDefinition | undefined {
  return commandRegistry.find((definition) => definition.command === command);
}

function requireControlPlaneCommand<TCommand extends ControlPlaneCommand>(
  command: TCommand,
): CommandDefinition<TCommand> {
  const definition = controlPlaneCommandRegistry.find(
    (candidate) => candidate.command === command,
  ) as CommandDefinition<TCommand> | undefined;
  if (!definition) throw new Error(`missing control-plane command definition: ${command}`);
  return definition;
}

interface DefinitionInput<TCommand extends string> {
  readonly command: TCommand;
  readonly mutability: CommandMutability;
  readonly streaming?: boolean;
  readonly requiredFeatures?: readonly string[];
  readonly input: JsonSchema;
  readonly bindings: readonly CommandInputBinding[];
  readonly output: JsonSchema;
  readonly event?: JsonSchema;
}

interface ControlPlaneMutationInput<TCommand extends string> {
  readonly command: TCommand;
  readonly properties: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly bindings: readonly CommandInputBinding[];
  readonly requiredFeatures?: readonly string[];
}

function defineCommand<TCommand extends string>(
  input: DefinitionInput<TCommand>,
): CommandDefinition<TCommand> {
  const {
    input: inputSchema,
    bindings: inputBindings,
    output,
    event,
    streaming = false,
    requiredFeatures = [],
  } = input;
  if (streaming !== (event !== undefined)) {
    throw new Error(`command ${input.command} must define an event schema exactly when streaming`);
  }
  assertInputBindings(input.command, inputSchema, inputBindings);
  const protocolSchemas = createCommandProtocolSchemas(input.command, inputSchema, output, event);
  assertClosedJsonSchema(protocolSchemas.inputSchema, `${input.command}.input`);
  assertClosedJsonSchema(protocolSchemas.outputSchema, `${input.command}.output`);
  if (protocolSchemas.eventSchema) {
    assertClosedJsonSchema(protocolSchemas.eventSchema, `${input.command}.event`);
  }
  return {
    command: input.command,
    mutability: input.mutability,
    streaming,
    requiredFeatures,
    inputBindings,
    ...protocolSchemas,
  };
}

function defineControlPlaneMutation<TCommand extends string>(
  input: ControlPlaneMutationInput<TCommand>,
): CommandDefinition<TCommand> {
  return defineCommand({
    command: input.command,
    mutability: "write",
    requiredFeatures: [
      "mutation-authority",
      "plan-apply",
      ...new Set(input.requiredFeatures ?? []),
    ],
    input: jsonSchema.object(
      { ...input.properties, dryRun: jsonSchema.boolean() },
      input.required ?? [],
    ),
    bindings: [...input.bindings, option("dryRun")],
    output: plannedMutationOutput,
  });
}

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

function assertInputBindings(
  command: string,
  inputSchema: JsonSchema,
  bindings: readonly CommandInputBinding[],
): void {
  const schemaFields = Object.keys(inputSchema.properties ?? {}).sort();
  const bindingFields = [...new Set(bindings.map(({ field }) => field))].sort();
  if (schemaFields.join("\0") !== bindingFields.join("\0")) {
    throw new Error(`command ${command} input schema and bindings must expose the same fields`);
  }
}

function requiredSchemaId(schema: JsonSchema): string {
  if (schema.$id === undefined) throw new Error("public protocol schema must define $id");
  return schema.$id;
}

function immutableJsonSnapshot<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing as T;

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const item of value) clone.push(immutableJsonSnapshot(item, seen));
    return Object.freeze(clone) as T;
  }

  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const [key, item] of Object.entries(value)) {
    clone[key] = immutableJsonSnapshot(item, seen);
  }
  return Object.freeze(clone) as T;
}
