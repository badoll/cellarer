import { dirname, join } from "node:path";
import { appendActivity } from "../activity.js";
import type { Env, FileTreeSnapshot } from "../env.js";
import { assertSafeAtomicPublicationPath } from "../fs/safety.js";
import { acquireCurrentMutationAuthorityLease, canonicalJson } from "../protocol/canonical.js";
import { CLIENT_API_MAX_REQUEST_BODY_BYTES } from "../protocol/client.js";
import type {
  CanonicalJsonObject,
  ClientErrorCode,
  InventoryCandidate,
  InventoryRefreshResult,
  MutationPlan,
  MutationPlanAction,
  TargetStateReceipt,
} from "../protocol/client-types.js";
import { invalidPlanResult, targetState } from "../protocol/execute.js";
import type { OperationActionReceipt, OperationResult } from "../protocol/models.js";
import { resolveAuthorizedMutationOperationAdapter } from "../protocol/operation-adapter.js";
import { executePreparedMutationOperation } from "../protocol/operation-execution.js";
import { planStoreActionMutation } from "../protocol/store-mutation.js";
import {
  createResourceRecord,
  parseResourceRecord,
  resourceMetadataPath,
} from "../resources/model.js";
import {
  assertFinalSerializedSecretBytes,
  assertFinalSerializedTextBytes,
} from "../secrets/final-bytes.js";
import {
  captureAnchoredSafeRecursiveSource,
  captureSafeRecursiveSource,
  installSafeRecursiveSnapshot,
  type SafeRecursiveSnapshot,
} from "../secrets/safe-tree.js";
import { sha256 } from "../store/checksum.js";
import { CONFIG_FILENAME, parseConfigValue } from "../store/config.js";
import { observeStoreConfigSnapshot } from "../store/snapshot.js";
import { isSafeArtifactName } from "../store/store.js";
import { inventoryCandidateId } from "./grouper.js";
import { captureInventoryRefresh, type InventoryRefreshOptions } from "./projector.js";
import type {
  CapturedInventoryCandidateObservation,
  CapturedInventoryPublication,
} from "./types.js";

export type InventoryStoreImportPlanningReason =
  | "CANDIDATE_IDS_REQUIRED"
  | "DUPLICATE_CANDIDATE"
  | "UNKNOWN_CANDIDATE"
  | "CANDIDATE_NOT_READY"
  | "INVENTORY_INCOMPLETE"
  | "UNSAFE_RESOURCE_NAME"
  | "STORE_SNAPSHOT_UNAVAILABLE"
  | "STORE_COLLISION"
  | "UNKNOWN_COLLECTION"
  | "PLAN_BODY_BUDGET_EXCEEDED";

export class InventoryStoreImportPlanningError extends Error {
  constructor(
    readonly code: Extract<
      ClientErrorCode,
      "INPUT_REQUIRED" | "INVALID_INPUT" | "DOMAIN_VALIDATION_FAILED"
    >,
    readonly reason: InventoryStoreImportPlanningReason,
  ) {
    super(`Inventory Store import planning failed: ${reason}`);
    this.name = "InventoryStoreImportPlanningError";
  }
}

export interface InventoryStoreImportRefreshScope {
  readonly projectRoot?: string;
  readonly agentId?: string;
}

export interface PlanInventoryStoreImportOptions {
  readonly storeRoot: string;
  readonly candidateIds: readonly string[];
  readonly refresh?: InventoryStoreImportRefreshScope;
  readonly intoCollection?: string;
}

export interface PlannedInventoryStoreImport {
  readonly inventory: InventoryRefreshResult;
  readonly candidateIds: readonly string[];
  readonly mutationPlan: MutationPlan;
}

export interface ApplyInventoryStoreImportPlanOptions {
  readonly storeRoot: string;
}

export interface AppliedInventoryStoreImport {
  readonly mutationPlan: MutationPlan;
  readonly candidateIds: readonly string[];
  readonly resourceIds: readonly string[];
  readonly operation: OperationResult;
  readonly warnings: readonly string[];
}

interface SelectedInventoryImport {
  readonly candidate: InventoryCandidate;
  readonly captured: CapturedInventoryCandidateObservation;
}

export async function planInventoryStoreImport(
  env: Env,
  options: PlanInventoryStoreImportOptions,
): Promise<PlannedInventoryStoreImport> {
  const candidateIds = normalizeCandidateIds(options.candidateIds);
  const intoCollection = normalizeCollection(options.intoCollection);
  const initialStore = await observeStoreConfigSnapshot(env, options.storeRoot).catch(() => null);
  if (!initialStore?.ok) {
    throw new InventoryStoreImportPlanningError(
      "DOMAIN_VALIDATION_FAILED",
      "STORE_SNAPSHOT_UNAVAILABLE",
    );
  }
  const canonicalStoreRoot = initialStore.snapshot.canonicalStoreRoot;
  const refreshOptions: InventoryRefreshOptions = {
    storeRoot: canonicalStoreRoot,
    ...(options.refresh?.projectRoot ? { projectRoot: options.refresh.projectRoot } : {}),
    ...(options.refresh?.agentId ? { agentId: options.refresh.agentId } : {}),
  };
  const normalizedInputs: {
    candidateIds: readonly string[];
    intoCollection: string | null;
    refreshScope: { agentId: string | null; projectRoot: string | null };
  } = {
    candidateIds,
    intoCollection,
    refreshScope: {
      agentId: options.refresh?.agentId ?? null,
      projectRoot: options.refresh?.projectRoot ?? null,
    },
  };
  let inventory: InventoryRefreshResult | null = null;
  const planned = await planStoreActionMutation(
    env,
    canonicalStoreRoot,
    "store-import",
    "inventory-store-import",
    async () => {
      const captured = await captureInventoryRefresh(env, refreshOptions);
      inventory = captured.result;
      if (
        captured.result.completeness !== "complete" ||
        captured.canonicalStoreRoot !== canonicalStoreRoot ||
        captured.storeRevision === undefined ||
        !captured.configuration
      ) {
        throw new InventoryStoreImportPlanningError(
          "DOMAIN_VALIDATION_FAILED",
          "INVENTORY_INCOMPLETE",
        );
      }
      normalizedInputs.refreshScope = {
        agentId: options.refresh?.agentId ?? null,
        projectRoot: captured.projectRoot ?? null,
      };
      const selected = selectExactCandidates(captured.result, captured.candidates, candidateIds);
      const actions = selected.flatMap(({ candidate, captured: observation }) =>
        resourceActions(env, canonicalStoreRoot, candidate, observation),
      );
      for (const action of actions) {
        if ((await targetState(env, action.target)).state !== "absent") {
          throw new InventoryStoreImportPlanningError(
            "DOMAIN_VALIDATION_FAILED",
            "STORE_COLLISION",
          );
        }
      }
      if (intoCollection) {
        if (!captured.configuration.collections[intoCollection]) {
          throw new InventoryStoreImportPlanningError(
            "DOMAIN_VALIDATION_FAILED",
            "UNKNOWN_COLLECTION",
          );
        }
        actions.push(
          await collectionMembershipAction(
            env,
            canonicalStoreRoot,
            captured.configuration,
            intoCollection,
            selected.map(({ candidate }) => `${candidate.kind}/${candidate.name}`),
          ),
        );
      }
      return {
        value: selected.map(({ candidate }) => candidate),
        actions: actions.map((action) => {
          if (!action.postcondition) throw new TypeError("Inventory import action is incomplete");
          return {
            ...action,
            postcondition: action.postcondition,
            execute: async (): Promise<void> => undefined,
          };
        }),
      };
    },
    {
      normalizedInputs: normalizedInputs as unknown as CanonicalJsonObject,
    },
  );
  if (!inventory) {
    throw new InventoryStoreImportPlanningError("DOMAIN_VALIDATION_FAILED", "INVENTORY_INCOMPLETE");
  }
  const result = Object.freeze({
    inventory,
    candidateIds: Object.freeze([...candidateIds]),
    mutationPlan: planned.plan,
  });
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength > CLIENT_API_MAX_REQUEST_BODY_BYTES
  ) {
    throw new InventoryStoreImportPlanningError(
      "DOMAIN_VALIDATION_FAILED",
      "PLAN_BODY_BUDGET_EXCEEDED",
    );
  }
  return result;
}

export async function applyInventoryStoreImportPlan(
  env: Env,
  mutationPlan: MutationPlan,
  options: ApplyInventoryStoreImportPlanOptions,
): Promise<AppliedInventoryStoreImport> {
  let decoded: DecodedInventoryStoreImport | null = null;
  try {
    if (
      !resolveAuthorizedMutationOperationAdapter(
        env,
        options.storeRoot,
        mutationPlan,
        "store-import",
      )
    ) {
      return invalidApplied(mutationPlan);
    }
    decoded = decodeInventoryStoreImportPlan(mutationPlan, options.storeRoot);
  } catch {
    return invalidApplied(mutationPlan);
  }
  if (!decoded) return invalidApplied(mutationPlan);
  const authorityLease = await acquireCurrentMutationAuthorityLease(env).catch(() => null);
  if (!authorityLease || !(await authorityLease.isCurrent().catch(() => false))) {
    await authorityLease?.release().catch(() => undefined);
    return invalidApplied(mutationPlan);
  }
  const warnings: string[] = [];
  try {
    const validateSources = () =>
      validateInventoryImportSources(env, decoded as DecodedInventoryStoreImport);
    const operation = await executePreparedMutationOperation(
      env,
      options.storeRoot,
      mutationPlan,
      async (_operationId, _record, authorize) => {
        const authorized: { action: DecodedInventoryImportAction; before: TargetStateReceipt }[] =
          [];
        for (const action of decoded?.actions ?? []) {
          const result = await authorize(action.action.actionId);
          if (!result.ok) {
            return { actionReceipts: [result.receipt], failedActionIds: [action.action.actionId] };
          }
          authorized.push({ action, before: result.before });
        }
        const applied: typeof authorized = [];
        let failure:
          | { action: DecodedInventoryImportAction; code: string; detail: string }
          | undefined;
        for (const item of authorized) {
          try {
            await executeInventoryImportAction(env, options.storeRoot, item.action);
            const after = await targetState(env, item.action.action.target);
            if (!sameTargetState(item.action.action.postcondition, after)) {
              throw Object.assign(new Error("Inventory import postcondition failed"), {
                code: "ACTION_POSTCONDITION_FAILED",
              });
            }
            applied.push(item);
          } catch (error) {
            const code = controlledActionCode(error);
            if (!code) throw error;
            failure = {
              action: item.action,
              code,
              detail: `filesystem action failed (${code})`,
            };
            break;
          }
        }
        if (failure) {
          await compensateInventoryImport(env, [...applied].reverse());
        }
        const receipts: OperationActionReceipt[] = [];
        for (const item of authorized) {
          const after = await targetState(env, item.action.action.target);
          const isFailed = item.action.action.actionId === failure?.action.action.actionId;
          receipts.push({
            actionId: item.action.action.actionId,
            target: item.action.action.target,
            outcome: isFailed
              ? "failed"
              : failure && sameTargetState(item.before, after)
                ? "compensated"
                : sameTargetState(item.before, after)
                  ? "unchanged"
                  : "applied",
            before: item.before,
            after,
            recordedAt: env.now().toISOString(),
            ...(isFailed && failure
              ? { error: { code: failure.code, message: failure.detail } }
              : {}),
          });
        }
        return {
          actionReceipts: receipts,
          ...(failure ? { failedActionIds: [failure.action.action.actionId] } : {}),
          afterCommit: async () => {
            await appendActivity(env, options.storeRoot, {
              action: "inventory-import",
              capabilities: [...(decoded?.capabilities ?? [])],
              affectedCount: decoded?.resourceIds.length ?? 0,
              summary: `Imported ${decoded?.resourceIds.length ?? 0} Inventory resources`,
              resources: { artifactIds: [...(decoded?.resourceIds ?? [])] },
            }).catch((error) => {
              warnings.push(
                `activity log failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
          },
        };
      },
      {
        authorityLease,
        validatePreflightBeforeObservation: validateSources,
        validateBeforeObservationUnderLock: validateSources,
        validateUnderLock: validateSources,
      },
    );
    return Object.freeze({
      mutationPlan,
      candidateIds: decoded.candidateIds,
      resourceIds: [...decoded.resourceIds],
      operation,
      warnings: Object.freeze(warnings),
    });
  } finally {
    await authorityLease.release().catch(() => undefined);
  }
}

function normalizeCandidateIds(candidateIds: readonly string[]): readonly string[] {
  if (candidateIds.length === 0) {
    throw new InventoryStoreImportPlanningError("INPUT_REQUIRED", "CANDIDATE_IDS_REQUIRED");
  }
  if (candidateIds.some((candidateId) => candidateId.length === 0)) {
    throw new InventoryStoreImportPlanningError("INVALID_INPUT", "UNKNOWN_CANDIDATE");
  }
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new InventoryStoreImportPlanningError("INVALID_INPUT", "DUPLICATE_CANDIDATE");
  }
  return Object.freeze([...candidateIds].sort((left, right) => left.localeCompare(right)));
}

function normalizeCollection(collection: string | undefined): string | null {
  if (collection === undefined) return null;
  const normalized = collection.trim();
  if (normalized.length === 0) {
    throw new InventoryStoreImportPlanningError("INVALID_INPUT", "UNKNOWN_COLLECTION");
  }
  return normalized;
}

function selectExactCandidates(
  inventory: InventoryRefreshResult,
  observations: readonly CapturedInventoryCandidateObservation[],
  candidateIds: readonly string[],
): readonly SelectedInventoryImport[] {
  const byId = new Map(inventory.candidates.map((candidate) => [candidate.id, candidate]));
  return Object.freeze(
    candidateIds.map((candidateId) => {
      const candidate = byId.get(candidateId);
      if (!candidate) {
        throw new InventoryStoreImportPlanningError(
          "DOMAIN_VALIDATION_FAILED",
          "UNKNOWN_CANDIDATE",
        );
      }
      if (candidate.state !== "ready") {
        throw new InventoryStoreImportPlanningError(
          "DOMAIN_VALIDATION_FAILED",
          "CANDIDATE_NOT_READY",
        );
      }
      if (!isSafeArtifactName(candidate.name)) {
        throw new InventoryStoreImportPlanningError(
          "DOMAIN_VALIDATION_FAILED",
          "UNSAFE_RESOURCE_NAME",
        );
      }
      const matches = observations
        .filter(
          (observation) =>
            inventoryCandidateId(
              observation.kind,
              observation.normalizedName,
              observation.contentFingerprint,
            ) === candidate.id,
        )
        .sort((left, right) =>
          `${left.source.id}\0${left.snapshot.rootPath}`.localeCompare(
            `${right.source.id}\0${right.snapshot.rootPath}`,
          ),
        );
      const captured = matches[0];
      if (!captured) {
        throw new InventoryStoreImportPlanningError(
          "DOMAIN_VALIDATION_FAILED",
          "UNKNOWN_CANDIDATE",
        );
      }
      assertPublicationSafe(candidate, captured.publication);
      return Object.freeze({ candidate, captured });
    }),
  );
}

function resourceActions(
  env: Env,
  storeRoot: string,
  candidate: InventoryCandidate,
  captured: CapturedInventoryCandidateObservation,
): readonly MutationPlanAction[] {
  const resourceId = `${candidate.kind}/${candidate.name}`;
  const sourceLocation = candidate.sources[0]?.location;
  const resource = createResourceRecord({
    resourceId,
    kind: candidate.kind,
    name: candidate.name,
    contentFingerprint: captured.publication.fingerprint,
    validation: {
      status: "validated",
      checkedAt: env.now().toISOString(),
      checks: [
        "content-fingerprint",
        ...(candidate.kind === "skills" ? (["manifest"] as const) : []),
        ...(candidate.kind === "mcp" ? (["adapter-compatibility"] as const) : []),
        "secret-scan",
      ],
    },
    source: {
      type: "local-snapshot",
      ...(sourceLocation ? { capturedFrom: sourceLocation } : {}),
    },
  });
  const contentTarget = resourceContentTarget(storeRoot, candidate.kind, candidate.name);
  const metadataTarget = resourceMetadataPath(storeRoot, candidate.kind, candidate.name);
  const metadata = `${JSON.stringify(resource, null, 2)}\n`;
  assertFinalSerializedSecretBytes(metadata, [], metadataTarget);
  const sourceBinding = {
    path: captured.snapshot.rootPath,
    fingerprint: captured.snapshot.fingerprint,
    physicalIdentity: captured.physicalIdentity,
  };
  const contentPayload = {
    candidateId: candidate.id,
    resourceId,
    publication: captured.publication,
    provenance: candidate.sources,
    source: sourceBinding,
  } as unknown as CanonicalJsonObject;
  const metadataPayload = {
    candidateId: candidate.id,
    resourceId,
    sourceFingerprint: captured.snapshot.fingerprint,
    data: metadata,
    digest: sha256(metadata),
    mode: 0o600,
  } as unknown as CanonicalJsonObject;
  const contentAction: MutationPlanAction = Object.freeze({
    actionId: actionId("inventory-resource-content", contentTarget, contentPayload),
    kind: "inventory-resource-content",
    target: contentTarget,
    payload: contentPayload,
    postcondition: {
      state: "present" as const,
      fingerprint: captured.publication.fingerprint,
    },
  });
  const metadataAction: MutationPlanAction = Object.freeze({
    actionId: actionId("inventory-resource-metadata", metadataTarget, metadataPayload),
    kind: "inventory-resource-metadata",
    target: metadataTarget,
    payload: metadataPayload,
    postcondition: { state: "present" as const, fingerprint: sha256(metadata) },
  });
  return Object.freeze([contentAction, metadataAction]);
}

async function collectionMembershipAction(
  env: Env,
  storeRoot: string,
  configuration: NonNullable<Awaited<ReturnType<typeof captureInventoryRefresh>>["configuration"]>,
  collectionId: string,
  resourceIds: readonly string[],
): Promise<MutationPlanAction> {
  const target = join(storeRoot, CONFIG_FILENAME);
  const snapshot = await captureAnchoredSafeRecursiveSource(env, storeRoot, target);
  const previous = snapshot
    ? {
        state: "present" as const,
        data: snapshot.files[0]?.content ?? "",
        digest: snapshot.fingerprint,
        mode: snapshot.files[0]?.mode ?? 0o600,
      }
    : { state: "absent" as const };
  const next = parseConfigValue(JSON.parse(JSON.stringify(configuration)));
  for (const resourceId of resourceIds) {
    const collections = next.artifacts[resourceId]?.collections ?? [];
    next.artifacts[resourceId] = {
      ...next.artifacts[resourceId],
      collections: [...new Set([...collections, collectionId])].sort(),
    };
  }
  const data = `${JSON.stringify(next, null, 2)}\n`;
  assertInventoryConfigPublication(data);
  const payload = {
    collectionId,
    resourceIds,
    data,
    digest: sha256(data),
    mode: 0o600,
    previous,
  } as unknown as CanonicalJsonObject;
  return Object.freeze({
    actionId: actionId("inventory-collection-membership", target, payload),
    kind: "inventory-collection-membership",
    target,
    payload,
    postcondition: { state: "present" as const, fingerprint: sha256(data) },
  });
}

function assertPublicationSafe(
  candidate: InventoryCandidate,
  publication: CapturedInventoryPublication,
): void {
  if (publication.kind === "file") {
    assertFinalSerializedSecretBytes(
      publication.data,
      [],
      candidate.kind === "mcp" ? `${candidate.name}.json` : candidate.name,
    );
    return;
  }
  for (const node of publication.nodes) {
    if (node.kind === "file") assertFinalSerializedSecretBytes(node.data, [], node.path);
  }
}

function resourceContentTarget(
  storeRoot: string,
  kind: InventoryCandidate["kind"],
  name: string,
): string {
  return join(
    storeRoot,
    "store",
    kind,
    kind === "rules" ? `${name}.md` : kind === "mcp" ? `${name}.json` : name,
  );
}

function actionId(kind: string, target: string, payload: CanonicalJsonObject): string {
  return sha256(
    canonicalJson({
      kind,
      target,
      payloadDigest: sha256(canonicalJson(payload)),
    }),
  );
}

interface DecodedInventorySourceBinding {
  readonly path: string;
  readonly fingerprint: string;
  readonly physicalIdentity: string;
}

interface DecodedInventoryContentAction {
  readonly type: "content";
  readonly action: MutationPlanAction;
  readonly candidateId: string;
  readonly resourceId: string;
  readonly source: DecodedInventorySourceBinding;
  readonly publication: CapturedInventoryPublication;
}

interface DecodedInventoryMetadataAction {
  readonly type: "metadata";
  readonly action: MutationPlanAction;
  readonly candidateId: string;
  readonly resourceId: string;
  readonly sourceFingerprint: string;
  readonly data: string;
  readonly mode: number;
}

type PreviousConfiguration =
  | { readonly state: "absent" }
  | {
      readonly state: "present";
      readonly data: string;
      readonly digest: string;
      readonly mode: number;
    };

interface DecodedInventoryCollectionAction {
  readonly type: "collection";
  readonly action: MutationPlanAction;
  readonly data: string;
  readonly mode: number;
  readonly previous: PreviousConfiguration;
}

type DecodedInventoryImportAction =
  | DecodedInventoryContentAction
  | DecodedInventoryMetadataAction
  | DecodedInventoryCollectionAction;

interface DecodedInventoryStoreImport {
  readonly candidateIds: readonly string[];
  readonly resourceIds: readonly string[];
  readonly capabilities: readonly InventoryCandidate["kind"][];
  readonly actions: readonly DecodedInventoryImportAction[];
}

function decodeInventoryStoreImportPlan(
  plan: MutationPlan,
  storeRoot: string,
): DecodedInventoryStoreImport | null {
  const inputs = plan.normalizedInputs;
  if (!hasExactKeys(inputs, ["candidateIds", "intoCollection", "mutationKind", "refreshScope"])) {
    return null;
  }
  if (
    inputs.mutationKind !== "inventory-store-import" ||
    !Array.isArray(inputs.candidateIds) ||
    inputs.candidateIds.length === 0 ||
    !inputs.candidateIds.every((candidateId) => typeof candidateId === "string") ||
    new Set(inputs.candidateIds).size !== inputs.candidateIds.length ||
    [...inputs.candidateIds].sort().join("\0") !== inputs.candidateIds.join("\0") ||
    (inputs.intoCollection !== null && typeof inputs.intoCollection !== "string") ||
    !hasExactKeys(inputs.refreshScope, ["agentId", "projectRoot"]) ||
    (inputs.refreshScope.agentId !== null && typeof inputs.refreshScope.agentId !== "string") ||
    (inputs.refreshScope.projectRoot !== null &&
      typeof inputs.refreshScope.projectRoot !== "string")
  ) {
    return null;
  }
  const candidateIds = inputs.candidateIds as string[];
  const expectsCollection = typeof inputs.intoCollection === "string";
  if (plan.actions.length !== candidateIds.length * 2 + (expectsCollection ? 1 : 0)) return null;
  const decoded: DecodedInventoryImportAction[] = [];
  const resourceIds: string[] = [];
  const capabilities: InventoryCandidate["kind"][] = [];
  for (const [index, candidateId] of candidateIds.entries()) {
    const contentAction = plan.actions[index * 2];
    const metadataAction = plan.actions[index * 2 + 1];
    const content = decodeContentAction(contentAction, candidateId, storeRoot, plan);
    if (!content) return null;
    const metadata = decodeMetadataAction(metadataAction, candidateId, content, storeRoot, plan);
    if (!metadata) return null;
    decoded.push(content, metadata);
    resourceIds.push(content.resourceId);
    capabilities.push(content.resourceId.split("/")[0] as InventoryCandidate["kind"]);
  }
  if (new Set(resourceIds).size !== resourceIds.length) return null;
  if (expectsCollection) {
    const collection = decodeCollectionAction(
      plan.actions[candidateIds.length * 2],
      inputs.intoCollection as string,
      candidateIds,
      resourceIds,
      storeRoot,
      plan,
    );
    if (!collection) return null;
    decoded.push(collection);
  }
  return Object.freeze({
    candidateIds: Object.freeze([...candidateIds]),
    resourceIds: Object.freeze(resourceIds),
    capabilities: Object.freeze([...new Set(capabilities)].sort()),
    actions: Object.freeze(decoded),
  });
}

function decodeContentAction(
  action: MutationPlanAction | undefined,
  candidateId: string,
  storeRoot: string,
  plan: MutationPlan,
): DecodedInventoryContentAction | null {
  if (
    action?.kind !== "inventory-resource-content" ||
    !hasExactKeys(action.payload, [
      "candidateId",
      "provenance",
      "publication",
      "resourceId",
      "source",
    ]) ||
    action.payload.candidateId !== candidateId ||
    typeof action.payload.resourceId !== "string" ||
    !Array.isArray(action.payload.provenance)
  ) {
    return null;
  }
  const resourceId = action.payload.resourceId;
  const identity = decodeResourceId(resourceId);
  const candidateKind = candidateId.match(/^inventory-candidate:v1:(rules|mcp|skills):/i)?.[1];
  if (!identity || candidateKind !== identity.kind) return null;
  const source = decodeSourceBinding(action.payload.source);
  const publication = decodePublication(action.payload.publication);
  if (!source || !publication) return null;
  try {
    assertPublicationSafe(
      {
        kind: identity.kind,
        name: identity.name,
      } as InventoryCandidate,
      publication,
    );
  } catch {
    return null;
  }
  if (
    action.target !== resourceContentTarget(storeRoot, identity.kind, identity.name) ||
    action.actionId !== actionId(action.kind, action.target, action.payload) ||
    action.postcondition?.state !== "present" ||
    action.postcondition.fingerprint !== publication.fingerprint ||
    plan.targetPreconditions.find(({ actionId: id }) => id === action.actionId)?.expected.state !==
      "absent"
  ) {
    return null;
  }
  return Object.freeze({
    type: "content",
    action,
    candidateId,
    resourceId,
    source,
    publication,
  });
}

function decodeMetadataAction(
  action: MutationPlanAction | undefined,
  candidateId: string,
  content: DecodedInventoryContentAction,
  storeRoot: string,
  plan: MutationPlan,
): DecodedInventoryMetadataAction | null {
  if (
    action?.kind !== "inventory-resource-metadata" ||
    !hasExactKeys(action.payload, [
      "candidateId",
      "data",
      "digest",
      "mode",
      "resourceId",
      "sourceFingerprint",
    ]) ||
    action.payload.candidateId !== candidateId ||
    action.payload.resourceId !== content.resourceId ||
    action.payload.sourceFingerprint !== content.source.fingerprint ||
    typeof action.payload.data !== "string" ||
    typeof action.payload.digest !== "string" ||
    action.payload.mode !== 0o600 ||
    sha256(action.payload.data) !== action.payload.digest
  ) {
    return null;
  }
  const identity = decodeResourceId(content.resourceId);
  if (!identity) return null;
  let record: ReturnType<typeof parseResourceRecord>;
  try {
    assertFinalSerializedSecretBytes(action.payload.data, [], action.target);
    record = parseResourceRecord(JSON.parse(action.payload.data));
  } catch {
    return null;
  }
  if (
    record.resourceId !== content.resourceId ||
    record.kind !== identity.kind ||
    record.name !== identity.name ||
    record.currentRevision.contentFingerprint !== content.publication.fingerprint ||
    record.currentRevision.source.type !== "local-snapshot" ||
    action.target !== resourceMetadataPath(storeRoot, identity.kind, identity.name) ||
    action.actionId !== actionId(action.kind, action.target, action.payload) ||
    action.postcondition?.state !== "present" ||
    action.postcondition.fingerprint !== action.payload.digest ||
    plan.targetPreconditions.find(({ actionId: id }) => id === action.actionId)?.expected.state !==
      "absent"
  ) {
    return null;
  }
  return Object.freeze({
    type: "metadata",
    action,
    candidateId,
    resourceId: content.resourceId,
    sourceFingerprint: content.source.fingerprint,
    data: action.payload.data,
    mode: action.payload.mode,
  });
}

function decodeCollectionAction(
  action: MutationPlanAction | undefined,
  collectionId: string,
  candidateIds: readonly string[],
  resourceIds: readonly string[],
  storeRoot: string,
  plan: MutationPlan,
): DecodedInventoryCollectionAction | null {
  if (
    action?.kind !== "inventory-collection-membership" ||
    !hasExactKeys(action.payload, [
      "collectionId",
      "data",
      "digest",
      "mode",
      "previous",
      "resourceIds",
    ]) ||
    action.payload.collectionId !== collectionId ||
    !Array.isArray(action.payload.resourceIds) ||
    action.payload.resourceIds.join("\0") !== resourceIds.join("\0") ||
    typeof action.payload.data !== "string" ||
    typeof action.payload.digest !== "string" ||
    sha256(action.payload.data) !== action.payload.digest ||
    action.payload.mode !== 0o600 ||
    action.target !== join(storeRoot, CONFIG_FILENAME) ||
    action.actionId !== actionId(action.kind, action.target, action.payload) ||
    action.postcondition?.state !== "present" ||
    action.postcondition.fingerprint !== action.payload.digest
  ) {
    return null;
  }
  const previous = decodePreviousConfiguration(action.payload.previous);
  const precondition = plan.targetPreconditions.find(
    ({ actionId }) => actionId === action.actionId,
  );
  if (!previous || !precondition || !previousMatchesPrecondition(previous, precondition.expected)) {
    return null;
  }
  try {
    assertInventoryConfigPublication(action.payload.data);
    const config = parseConfigValue(JSON.parse(action.payload.data));
    if (
      candidateIds.length !== resourceIds.length ||
      resourceIds.some(
        (resourceId) => !config.artifacts[resourceId]?.collections.includes(collectionId),
      )
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return Object.freeze({
    type: "collection",
    action,
    data: action.payload.data,
    mode: action.payload.mode,
    previous,
  });
}

function decodeSourceBinding(value: unknown): DecodedInventorySourceBinding | null {
  if (
    !hasExactKeys(value, ["fingerprint", "path", "physicalIdentity"]) ||
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    typeof value.fingerprint !== "string" ||
    typeof value.physicalIdentity !== "string"
  ) {
    return null;
  }
  return Object.freeze({
    path: value.path,
    fingerprint: value.fingerprint,
    physicalIdentity: value.physicalIdentity,
  });
}

function decodePublication(value: unknown): CapturedInventoryPublication | null {
  if (!isPlainRecord(value) || value.kind === "file") {
    if (
      !hasExactKeys(value, ["data", "fingerprint", "kind", "mode"]) ||
      value.kind !== "file" ||
      typeof value.data !== "string" ||
      typeof value.fingerprint !== "string" ||
      !Number.isInteger(value.mode) ||
      sha256(value.data) !== value.fingerprint
    ) {
      return null;
    }
    return Object.freeze({
      kind: "file",
      data: value.data,
      mode: value.mode as number,
      fingerprint: value.fingerprint,
    });
  }
  if (
    !hasExactKeys(value, ["fingerprint", "kind", "nodes"]) ||
    value.kind !== "directory" ||
    typeof value.fingerprint !== "string" ||
    !Array.isArray(value.nodes)
  ) {
    return null;
  }
  const nodes: Extract<CapturedInventoryPublication, { kind: "directory" }>["nodes"][number][] = [];
  const paths = new Set<string>();
  for (const node of value.nodes) {
    if (!isPlainRecord(node) || typeof node.path !== "string" || !safeRelativePath(node.path)) {
      return null;
    }
    if (paths.has(node.path) || !Number.isInteger(node.mode)) return null;
    paths.add(node.path);
    if (node.kind === "directory" && hasExactKeys(node, ["kind", "mode", "path"])) {
      nodes.push({ path: node.path, kind: "directory", mode: node.mode as number });
    } else if (
      node.kind === "file" &&
      hasExactKeys(node, ["data", "digest", "kind", "mode", "path"]) &&
      typeof node.data === "string" &&
      typeof node.digest === "string" &&
      sha256(node.data) === node.digest
    ) {
      nodes.push({
        path: node.path,
        kind: "file",
        mode: node.mode as number,
        data: node.data,
        digest: node.digest,
      });
    } else {
      return null;
    }
  }
  if (nodes.filter(({ path, kind }) => path === "" && kind === "directory").length !== 1) {
    return null;
  }
  const fingerprint = sha256(
    JSON.stringify(
      nodes.map((node) =>
        node.kind === "directory"
          ? { path: node.path, kind: node.kind, mode: node.mode }
          : { path: node.path, kind: node.kind, mode: node.mode, digest: node.digest },
      ),
    ),
  );
  if (fingerprint !== value.fingerprint) return null;
  return Object.freeze({
    kind: "directory",
    nodes: Object.freeze(nodes),
    fingerprint,
  });
}

function decodePreviousConfiguration(value: unknown): PreviousConfiguration | null {
  if (hasExactKeys(value, ["state"]) && value.state === "absent") return { state: "absent" };
  if (
    !hasExactKeys(value, ["data", "digest", "mode", "state"]) ||
    value.state !== "present" ||
    typeof value.data !== "string" ||
    typeof value.digest !== "string" ||
    sha256(value.data) !== value.digest ||
    !Number.isInteger(value.mode)
  ) {
    return null;
  }
  return {
    state: "present",
    data: value.data,
    digest: value.digest,
    mode: value.mode as number,
  };
}

function previousMatchesPrecondition(
  previous: PreviousConfiguration,
  precondition: TargetStateReceipt,
): boolean {
  return previous.state === "absent"
    ? precondition.state === "absent"
    : precondition.state === "present" && precondition.fingerprint === previous.digest;
}

function decodeResourceId(
  resourceId: string,
): { kind: InventoryCandidate["kind"]; name: string } | null {
  const match = resourceId.match(/^(rules|mcp|skills)\/(.+)$/);
  if (!match?.[1] || !match[2] || !isSafeArtifactName(match[2])) return null;
  return { kind: match[1] as InventoryCandidate["kind"], name: match[2] };
}

async function validateInventoryImportSources(
  env: Env,
  decoded: DecodedInventoryStoreImport,
): Promise<OperationResult | null> {
  const sources = new Map<string, DecodedInventorySourceBinding>();
  for (const action of decoded.actions) {
    if (action.type !== "content") continue;
    const current = sources.get(action.source.path);
    if (
      current &&
      (current.fingerprint !== action.source.fingerprint ||
        current.physicalIdentity !== action.source.physicalIdentity)
    ) {
      return invalidPlanResult();
    }
    sources.set(action.source.path, action.source);
  }
  for (const source of sources.values()) {
    let actual: TargetStateReceipt = { state: "absent" };
    try {
      const snapshot = await captureSafeRecursiveSource(env, source.path);
      actual = { state: "present", fingerprint: snapshot.fingerprint };
      if (
        snapshot.fingerprint === source.fingerprint &&
        snapshot.identity === source.physicalIdentity
      ) {
        continue;
      }
    } catch {
      // Missing and unsafe sources remain one non-disclosing absent observation.
    }
    return {
      ok: false,
      conflict: {
        code: "TARGET_PRECONDITION_CONFLICT",
        message: "Inventory candidate changed after planning; refresh and replan required",
        planId: "untrusted",
        actionId: "untrusted",
        target: "untrusted",
        expected: { state: "present", fingerprint: source.fingerprint },
        actual,
      },
    };
  }
  return null;
}

async function executeInventoryImportAction(
  env: Env,
  storeRoot: string,
  decoded: DecodedInventoryImportAction,
): Promise<void> {
  await assertSafeAtomicPublicationPath(env, decoded.action.target, storeRoot, "Inventory import");
  if (decoded.type === "content") {
    if (decoded.publication.kind === "file") {
      assertFinalSerializedSecretBytes(decoded.publication.data, [], decoded.action.target);
      await env.fs.mkdir(dirname(decoded.action.target), { recursive: true });
      await env.fs.publishFileAtomically(decoded.action.target, decoded.publication.data, {
        mode: decoded.publication.mode,
      });
      return;
    }
    await installSafeRecursiveSnapshot(
      env,
      publicationSnapshot(decoded.publication, decoded.action.target),
      decoded.action.target,
      false,
    );
    return;
  }
  if (decoded.type === "collection") {
    assertInventoryConfigPublication(decoded.data);
  } else {
    assertFinalSerializedSecretBytes(decoded.data, [], decoded.action.target);
  }
  await env.fs.mkdir(dirname(decoded.action.target), { recursive: true });
  await env.fs.publishFileAtomically(decoded.action.target, decoded.data, { mode: decoded.mode });
}

function assertInventoryConfigPublication(data: string): void {
  parseConfigValue(JSON.parse(data));
  assertFinalSerializedTextBytes(data, []);
}

function publicationSnapshot(
  publication: Extract<CapturedInventoryPublication, { kind: "directory" }>,
  target: string,
): SafeRecursiveSnapshot {
  const encoder = new TextEncoder();
  const tree: FileTreeSnapshot = {
    rootPath: target,
    nodes: publication.nodes.map((node) => ({
      relativePath: node.path,
      kind: node.kind,
      mode: node.mode,
      identity: `inventory-import:${node.path}:${node.kind === "file" ? node.digest : node.mode}`,
      ...(node.kind === "file" ? { data: encoder.encode(node.data) } : {}),
    })),
  };
  return {
    rootPath: target,
    kind: "directory",
    files: publication.nodes.flatMap((node) =>
      node.kind === "file"
        ? [
            {
              absolutePath: join(target, ...node.path.split("/")),
              relativePath: node.path,
              mode: node.mode,
              content: node.data,
              data: encoder.encode(node.data),
            },
          ]
        : [],
    ),
    directories: publication.nodes.flatMap((node) =>
      node.kind === "directory" ? [{ relativePath: node.path, mode: node.mode }] : [],
    ),
    fingerprint: publication.fingerprint,
    identity: sha256(canonicalJson(publication)),
    tree,
  };
}

async function compensateInventoryImport(
  env: Env,
  applied: readonly { action: DecodedInventoryImportAction; before: TargetStateReceipt }[],
): Promise<void> {
  for (const { action, before } of applied) {
    if (action.type === "collection") {
      if (action.previous.state === "absent") {
        await env.fs.rm(action.action.target, { force: true });
      } else {
        await env.fs.publishFileAtomically(action.action.target, action.previous.data, {
          mode: action.previous.mode,
        });
      }
    } else if (before.state === "absent") {
      await env.fs.rm(action.action.target, { recursive: true, force: true });
    }
  }
}

function controlledActionCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return null;
  switch (code) {
    case "EACCES":
    case "EDQUOT":
    case "EFBIG":
    case "EIO":
    case "ENOSPC":
    case "EPERM":
    case "EROFS":
    case "ESTALE":
    case "ACTION_POSTCONDITION_FAILED":
      return code;
    default:
      return null;
  }
}

function sameTargetState(
  expected: TargetStateReceipt | undefined,
  actual: TargetStateReceipt,
): boolean {
  return (
    expected !== undefined &&
    expected.state === actual.state &&
    (expected.state === "absent" ||
      (actual.state === "present" && expected.fingerprint === actual.fingerprint))
  );
}

function safeRelativePath(path: string): boolean {
  if (path === "") return true;
  return (
    !path.startsWith("/") &&
    !path.endsWith("/") &&
    path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    isPlainRecord(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function invalidApplied(mutationPlan: MutationPlan): AppliedInventoryStoreImport {
  return Object.freeze({
    mutationPlan,
    candidateIds: Object.freeze([]),
    resourceIds: Object.freeze([]),
    operation: invalidPlanResult(),
    warnings: Object.freeze([]),
  });
}
