import { dirname, join } from "node:path";
import { loadRegistry } from "../adapters/registry.js";
import type { AgentAdapter } from "../adapters/types.js";
import type { Env } from "../env.js";
import { assertSafeAtomicPublicationPath } from "../fs/safety.js";
import { type McpServer, serverFromRaw, serverToRaw } from "../mcp/model.js";
import {
  acquireCurrentMutationAuthorityLease,
  assertStrictMutationPlanRuntime,
  canonicalJson,
  verifyMutationPlanAuthorization,
  verifyMutationPlanDigest,
} from "../protocol/canonical.js";
import { CLIENT_API_MAX_REQUEST_BODY_BYTES } from "../protocol/client.js";
import type {
  CanonicalJsonObject,
  ClientErrorCode,
  InventoryCandidate,
  InventoryRefreshResult,
  InventorySecretAdoptionOffer,
  InventorySecretAdoptionOrphanEvidence,
  InventorySecretAdoptionProvider,
  InventorySecretFieldSelector,
  InventorySecretProviderPrecondition,
  MutationPlan,
  MutationPlanAction,
} from "../protocol/client-types.js";
import {
  type AuthorizeOperationAction,
  executeMutationPlan,
  invalidPlanResult,
  targetState,
} from "../protocol/execute.js";
import { readOperationJournal } from "../protocol/journal.js";
import type { OperationActionReceipt, OperationResult } from "../protocol/models.js";
import { planStoreActionMutation } from "../protocol/store-mutation.js";
import { createResourceRecord, resourceMetadataPath } from "../resources/model.js";
import {
  type InventorySecretReferenceCreateResult,
  inventorySecretAdoptionExternalEffect,
} from "../secrets/adoption-provider.js";
import { isSensitiveSecretFieldName } from "../secrets/detector.js";
import { assertFinalSerializedSecretBytes } from "../secrets/final-bytes.js";
import { createSecretValue } from "../secrets/observable.js";
import { cellarerSecretReference, secretReferenceToken } from "../secrets/reference.js";
import { captureSafeRecursiveSource, type SafeRecursiveSnapshot } from "../secrets/safe-tree.js";
import { sha256 } from "../store/checksum.js";
import { observeStoreConfigSnapshot } from "../store/snapshot.js";
import { isSafeArtifactName } from "../store/store.js";
import { inventorySecretAdoptionTargetName } from "./adoption-fields.js";
import { inventoryCandidateId } from "./grouper.js";
import { captureInventoryRefresh, type InventoryRefreshOptions } from "./projector.js";
import type {
  CapturedInventoryCandidateObservation,
  CapturedInventoryPublication,
} from "./types.js";

export type InventorySecretAdoptionPlanningReason =
  | "CANDIDATE_REQUIRED"
  | "SELECTOR_INVALID"
  | "PROVIDER_UNSUPPORTED"
  | "INVENTORY_INCOMPLETE"
  | "CANDIDATE_NOT_ADOPTABLE"
  | "STORE_SNAPSHOT_UNAVAILABLE"
  | "STORE_COLLISION"
  | "UNSAFE_RESOURCE_NAME"
  | "PLAN_BODY_BUDGET_EXCEEDED";

export class InventorySecretAdoptionPlanningError extends Error {
  constructor(
    readonly code: Extract<
      ClientErrorCode,
      "INPUT_REQUIRED" | "INVALID_INPUT" | "DOMAIN_VALIDATION_FAILED"
    >,
    readonly reason: InventorySecretAdoptionPlanningReason,
  ) {
    super(`Inventory secret-adoption planning failed: ${reason}`);
    this.name = "InventorySecretAdoptionPlanningError";
  }
}

export interface InventorySecretAdoptionRefreshScope {
  readonly projectRoot?: string;
  readonly agentId?: string;
}

export interface PlanInventorySecretAdoptionOptions {
  readonly storeRoot: string;
  readonly candidateId: string;
  readonly selector: InventorySecretFieldSelector;
  readonly provider: "vault" | "keychain";
  readonly refresh?: InventorySecretAdoptionRefreshScope;
}

export interface PlannedInventorySecretAdoption {
  readonly inventory: InventoryRefreshResult;
  readonly candidateId: string;
  readonly selector: InventorySecretFieldSelector;
  readonly provider: InventorySecretAdoptionProvider;
  readonly targetName: string;
  readonly mutationPlan: MutationPlan;
}

export interface ApplyInventorySecretAdoptionPlanOptions {
  readonly storeRoot: string;
}

export type InventorySecretAdoptionApplyStatus =
  | "applied"
  | "rejected"
  | "provider-precondition-conflict"
  | "orphaned-reference";

export interface AppliedInventorySecretAdoption {
  readonly mutationPlan: MutationPlan;
  readonly candidateId: string | null;
  readonly provider: InventorySecretAdoptionProvider | null;
  readonly targetName: string | null;
  readonly status: InventorySecretAdoptionApplyStatus;
  readonly operation: OperationResult;
  readonly orphan?: InventorySecretAdoptionOrphanEvidence;
}

interface SelectedInventorySecretAdoption {
  readonly candidate: InventoryCandidate;
  readonly captured: CapturedInventoryCandidateObservation;
  readonly offer: InventorySecretAdoptionOffer;
}

export interface DecodedInventorySecretAdoptionPlan {
  readonly candidateId: string;
  readonly candidateName: string;
  readonly selector: InventorySecretFieldSelector;
  readonly provider: InventorySecretAdoptionProvider;
  readonly providerPrecondition: InventorySecretProviderPrecondition;
  readonly targetName: string;
  readonly source: {
    readonly adapterId: string;
    readonly path: string;
    readonly fingerprint: string;
    readonly physicalIdentity: string;
  };
  readonly publication: Extract<CapturedInventoryPublication, { readonly kind: "file" }>;
  readonly actions: readonly [MutationPlanAction, MutationPlanAction];
}

export async function planInventorySecretAdoption(
  env: Env,
  options: PlanInventorySecretAdoptionOptions,
): Promise<PlannedInventorySecretAdoption> {
  if (options.candidateId.length === 0) {
    throw new InventorySecretAdoptionPlanningError("INPUT_REQUIRED", "CANDIDATE_REQUIRED");
  }
  const provider = normalizeProvider(options.provider);
  const selector = normalizeSelector(options.selector);
  const initialStore = await observeStoreConfigSnapshot(env, options.storeRoot).catch(() => null);
  if (!initialStore?.ok) {
    throw new InventorySecretAdoptionPlanningError(
      "DOMAIN_VALIDATION_FAILED",
      "STORE_SNAPSHOT_UNAVAILABLE",
    );
  }
  const canonicalStoreRoot = initialStore.snapshot.canonicalStoreRoot;
  let inventory: InventoryRefreshResult | null = null;
  const refreshOptions: InventoryRefreshOptions = {
    storeRoot: canonicalStoreRoot,
    ...(options.refresh?.projectRoot ? { projectRoot: options.refresh.projectRoot } : {}),
    ...(options.refresh?.agentId ? { agentId: options.refresh.agentId } : {}),
  };
  const planned = await planStoreActionMutation(
    env,
    canonicalStoreRoot,
    "store-import",
    "inventory-secret-adoption",
    async () => {
      const captured = await captureInventoryRefresh(env, refreshOptions);
      inventory = captured.result;
      if (
        captured.result.completeness !== "complete" ||
        captured.canonicalStoreRoot === undefined ||
        captured.storeRevision === undefined
      ) {
        throw new InventorySecretAdoptionPlanningError(
          "DOMAIN_VALIDATION_FAILED",
          captured.canonicalStoreRoot === undefined
            ? "STORE_SNAPSHOT_UNAVAILABLE"
            : "INVENTORY_INCOMPLETE",
        );
      }
      const selected = selectExactAdoption(
        captured.result,
        captured.candidates,
        options.candidateId,
        selector,
      );
      const actions = adoptionResourceActions(env, captured.canonicalStoreRoot, selected, provider);
      for (const action of actions) {
        if ((await targetState(env, action.target)).state !== "absent") {
          throw new InventorySecretAdoptionPlanningError(
            "DOMAIN_VALIDATION_FAILED",
            "STORE_COLLISION",
          );
        }
      }
      return {
        value: selected,
        actions: actions.map((action) => {
          if (!action.postcondition) throw new TypeError("adoption action is incomplete");
          return { ...action, postcondition: action.postcondition, execute: async () => undefined };
        }),
      };
    },
    {
      normalizedInputs: {
        candidateId: options.candidateId,
        candidateName: selector.server,
        provider: provider as unknown as CanonicalJsonObject,
        providerPrecondition: { state: "absent" },
        refreshScope: {
          agentId: options.refresh?.agentId ?? null,
          projectRoot: options.refresh?.projectRoot ?? null,
        },
        selector: selector as unknown as CanonicalJsonObject,
        targetName: inventorySecretAdoptionTargetName(selector),
      },
    },
  );
  if (!inventory) {
    throw new InventorySecretAdoptionPlanningError(
      "DOMAIN_VALIDATION_FAILED",
      "INVENTORY_INCOMPLETE",
    );
  }
  const decoded = decodeInventorySecretAdoptionPlan(env, canonicalStoreRoot, planned.plan);
  if (!decoded) {
    throw new InventorySecretAdoptionPlanningError("DOMAIN_VALIDATION_FAILED", "SELECTOR_INVALID");
  }
  const result = Object.freeze({
    inventory,
    candidateId: decoded.candidateId,
    selector: decoded.selector,
    provider: decoded.provider,
    targetName: decoded.targetName,
    mutationPlan: planned.plan,
  });
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength > CLIENT_API_MAX_REQUEST_BODY_BYTES
  ) {
    throw new InventorySecretAdoptionPlanningError(
      "DOMAIN_VALIDATION_FAILED",
      "PLAN_BODY_BUDGET_EXCEEDED",
    );
  }
  return result;
}

export function decodeInventorySecretAdoptionPlan(
  env: Env,
  storeRoot: string,
  plan: MutationPlan,
): DecodedInventorySecretAdoptionPlan | null {
  try {
    assertStrictMutationPlanRuntime(plan, "store-import");
    if (!verifyMutationPlanAuthorization(env, storeRoot, plan) || !verifyMutationPlanDigest(plan)) {
      return null;
    }
    const inputs = plan.normalizedInputs;
    if (
      !hasExactKeys(inputs, [
        "candidateId",
        "candidateName",
        "mutationKind",
        "provider",
        "providerPrecondition",
        "refreshScope",
        "selector",
        "targetName",
      ]) ||
      inputs.mutationKind !== "inventory-secret-adoption" ||
      typeof inputs.candidateId !== "string" ||
      !/^inventory-candidate:v1:mcp:[a-f0-9]{64}$/.test(inputs.candidateId) ||
      typeof inputs.candidateName !== "string" ||
      !isSafeArtifactName(inputs.candidateName) ||
      !hasExactKeys(inputs.refreshScope, ["agentId", "projectRoot"]) ||
      (inputs.refreshScope.agentId !== null && typeof inputs.refreshScope.agentId !== "string") ||
      (inputs.refreshScope.projectRoot !== null &&
        typeof inputs.refreshScope.projectRoot !== "string")
    ) {
      return null;
    }
    const selector = decodeSelector(inputs.selector);
    const provider = decodeProvider(inputs.provider);
    const providerPrecondition = decodeProviderPrecondition(inputs.providerPrecondition);
    if (
      !selector ||
      selector.server !== inputs.candidateName ||
      !provider ||
      !providerPrecondition ||
      typeof inputs.targetName !== "string" ||
      inputs.targetName !== inventorySecretAdoptionTargetName(selector)
    ) {
      return null;
    }
    const content = plan.actions[0];
    const metadata = plan.actions[1];
    if (plan.actions.length !== 2 || !content || !metadata) return null;
    const decodedContent = decodeContentAction(
      content,
      plan,
      storeRoot,
      inputs.candidateId,
      inputs.candidateName,
      selector,
      provider,
      providerPrecondition,
      inputs.targetName,
    );
    if (!decodedContent || !decodeMetadataAction(metadata, plan, storeRoot, decodedContent)) {
      return null;
    }
    return Object.freeze({
      candidateId: inputs.candidateId,
      candidateName: inputs.candidateName,
      selector,
      provider,
      providerPrecondition,
      targetName: inputs.targetName,
      source: decodedContent.source,
      publication: decodedContent.publication,
      actions: Object.freeze([content, metadata] as const),
    });
  } catch {
    return null;
  }
}

export async function applyInventorySecretAdoptionPlan(
  env: Env,
  mutationPlan: MutationPlan,
  options: ApplyInventorySecretAdoptionPlanOptions,
): Promise<AppliedInventorySecretAdoption> {
  const decoded = decodeInventorySecretAdoptionPlan(env, options.storeRoot, mutationPlan);
  if (!decoded) return invalidAppliedAdoption(mutationPlan);
  const providerPort = env.inventorySecretAdoptionProvider;
  if (!providerPort) return invalidAppliedAdoption(mutationPlan);
  const authorityLease = await acquireCurrentMutationAuthorityLease(env).catch(() => null);
  if (!authorityLease || !(await authorityLease.isCurrent().catch(() => false))) {
    await authorityLease?.release().catch(() => undefined);
    return invalidAppliedAdoption(mutationPlan);
  }
  const externalEffect = inventorySecretAdoptionExternalEffect(
    decoded.provider,
    decoded.targetName,
  );
  let validatedSource:
    | { readonly snapshot: SafeRecursiveSnapshot; readonly adapter: AgentAdapter }
    | undefined;
  let providerResult: InventorySecretReferenceCreateResult | undefined;
  let providerCreated = false;
  try {
    const validateSource = async (): Promise<OperationResult | null> => {
      validatedSource = undefined;
      try {
        const snapshot = await captureSafeRecursiveSource(env, decoded.source.path);
        const registry = await loadRegistry(env, options.storeRoot);
        const adapter = registry.get(decoded.source.adapterId);
        if (
          !adapter?.mcp ||
          snapshot.fingerprint !== decoded.source.fingerprint ||
          snapshot.identity !== decoded.source.physicalIdentity
        ) {
          return adoptionSourceConflict(decoded.source.fingerprint, snapshot.fingerprint);
        }
        validatedSource = { snapshot, adapter };
        return null;
      } catch {
        return adoptionSourceConflict(decoded.source.fingerprint, null);
      }
    };
    const operation = await executeMutationPlan(
      env,
      options.storeRoot,
      mutationPlan,
      async (_operationId, _recordAction, authorizeAction, recordExternalEffect) => {
        const authorized = await authorizeAdoptionActions(decoded, authorizeAction);
        if (!authorized.ok) {
          return {
            actionReceipts: authorized.receipts,
            failedActionIds: authorized.failedActionIds,
          };
        }
        const currentSource = validatedSource;
        if (!currentSource) throw new Error("adoption source was not validated under lock");
        try {
          providerResult = await providerPort.createExactAbsentReference(
            {
              provider: decoded.provider,
              providerPrecondition: decoded.providerPrecondition,
              targetName: decoded.targetName,
            },
            async () =>
              createSecretValue(
                readBoundAdoptionValue(currentSource, decoded.candidateName, decoded.selector),
              ),
          );
        } catch {
          providerResult = { created: false, reason: "unavailable" };
        }
        if (!providerResult.created) {
          const code =
            providerResult.reason === "already-exists"
              ? "PROVIDER_PRECONDITION_CONFLICT"
              : "PROVIDER_UNAVAILABLE";
          const receipts = rejectedAdoptionReceipts(env, authorized.actions, code);
          return {
            actionReceipts: receipts,
            failedActionIds: [authorized.actions[0]?.action.actionId ?? "invalid"],
          };
        }
        providerCreated = true;
        await recordExternalEffect(externalEffect.effectId);
        const applied: AuthorizedAdoptionAction[] = [];
        let failure:
          | { readonly action: (typeof authorized.actions)[number]; readonly code: string }
          | undefined;
        for (const item of authorized.actions) {
          try {
            await executeAdoptionStoreAction(env, options.storeRoot, item.action);
            const after = await targetState(env, item.action.target);
            if (!sameAdoptionTargetState(item.action.postcondition, after)) {
              throw new Error("adoption Store postcondition failed");
            }
            applied.push(item);
          } catch {
            failure = { action: item, code: "STORE_PUBLICATION_FAILED" };
            break;
          }
        }
        if (failure) await compensateAdoptionStoreActions(env, [...applied].reverse());
        const receipts = authorized.actions.map((item) => {
          const failed = item.action.actionId === failure?.action.action.actionId;
          return adoptionActionReceipt(
            env,
            item,
            failed,
            failure ? "STORE_PUBLICATION_FAILED" : undefined,
          );
        });
        return {
          actionReceipts: await Promise.all(receipts),
          ...(failure ? { failedActionIds: [failure.action.action.actionId] } : {}),
        };
      },
      {
        authorityLease,
        externalEffects: [externalEffect],
        validatePreflightBeforeObservation: validateSource,
        validateBeforeObservationUnderLock: validateSource,
        validateUnderLock: validateSource,
      },
    );
    if (operation.ok) {
      return adoptionApplied(mutationPlan, decoded, "applied", operation);
    }
    if (providerCreated) {
      return adoptionApplied(mutationPlan, decoded, "orphaned-reference", operation, {
        status: "provider-created-store-unpublished",
        provider: decoded.provider,
        targetName: decoded.targetName,
        cleanupCommand: externalEffect.cleanupCommand,
      });
    }
    return adoptionApplied(
      mutationPlan,
      decoded,
      providerResult?.created === false && providerResult.reason === "already-exists"
        ? "provider-precondition-conflict"
        : "rejected",
      operation,
    );
  } catch {
    if (!providerCreated)
      return adoptionApplied(mutationPlan, decoded, "rejected", invalidPlanResult());
    const journal = await readOperationJournal(env, options.storeRoot).catch(() => null);
    const operation: OperationResult = {
      ok: false,
      conflict: {
        code: "MANUAL_RECOVERY_REQUIRED",
        message: "manual recovery is required",
        operationId: journal?.operationId ?? "untrusted",
        targets: decoded.actions.map(({ target }) => target),
        guidance: "the provider reference was created but Store publication did not complete",
      },
      ...(journal ? { journal } : {}),
    };
    return adoptionApplied(mutationPlan, decoded, "orphaned-reference", operation, {
      status: "provider-created-store-unpublished",
      provider: decoded.provider,
      targetName: decoded.targetName,
      cleanupCommand: externalEffect.cleanupCommand,
    });
  } finally {
    await authorityLease.release().catch(() => undefined);
  }
}

function selectExactAdoption(
  inventory: InventoryRefreshResult,
  observations: readonly CapturedInventoryCandidateObservation[],
  candidateId: string,
  selector: InventorySecretFieldSelector,
): SelectedInventorySecretAdoption {
  const candidate = inventory.candidates.find((item) => item.id === candidateId);
  if (
    candidate?.kind !== "mcp" ||
    candidate.state !== "needs-attention" ||
    !isSafeArtifactName(candidate.name) ||
    candidate.findings.some(
      ({ code }) => code !== "PROBABLE_SECRET" && code !== "secret-adoption-required",
    )
  ) {
    throw new InventorySecretAdoptionPlanningError(
      "DOMAIN_VALIDATION_FAILED",
      candidate && !isSafeArtifactName(candidate.name)
        ? "UNSAFE_RESOURCE_NAME"
        : "CANDIDATE_NOT_ADOPTABLE",
    );
  }
  const matches = observations
    .filter(
      (observation) =>
        observation.kind === "mcp" &&
        inventoryCandidateId(
          observation.kind,
          observation.normalizedName,
          observation.contentFingerprint,
        ) === candidateId,
    )
    .sort((left, right) =>
      `${left.source.id}\0${left.snapshot.rootPath}`.localeCompare(
        `${right.source.id}\0${right.snapshot.rootPath}`,
      ),
    );
  for (const captured of matches) {
    const offer = captured.secretAdoptions.find(
      (item) => canonicalJson(item.selector) === canonicalJson(selector),
    );
    if (offer) return Object.freeze({ candidate, captured, offer });
  }
  throw new InventorySecretAdoptionPlanningError(
    "DOMAIN_VALIDATION_FAILED",
    "CANDIDATE_NOT_ADOPTABLE",
  );
}

function adoptionResourceActions(
  env: Env,
  storeRoot: string,
  selected: SelectedInventorySecretAdoption,
  provider: InventorySecretAdoptionProvider,
): readonly MutationPlanAction[] {
  const { candidate, captured, offer } = selected;
  if (captured.publication.kind !== "file") {
    throw new InventorySecretAdoptionPlanningError(
      "DOMAIN_VALIDATION_FAILED",
      "CANDIDATE_NOT_ADOPTABLE",
    );
  }
  const server = serverFromRaw(JSON.parse(captured.publication.data));
  const replacement = secretReferenceToken(cellarerSecretReference(offer.targetName));
  const adopted = replaceSelectedValue(server, offer.selector, replacement);
  if (!adopted) {
    throw new InventorySecretAdoptionPlanningError("DOMAIN_VALIDATION_FAILED", "SELECTOR_INVALID");
  }
  const data = `${JSON.stringify(serverToRaw(adopted), null, 2)}\n`;
  const publication = Object.freeze({
    kind: "file" as const,
    data,
    mode: captured.publication.mode,
    fingerprint: sha256(data),
  });
  const resourceId = `mcp/${candidate.name}`;
  const contentTarget = resourceContentTarget(storeRoot, candidate.name);
  const metadataTarget = resourceMetadataPath(storeRoot, "mcp", candidate.name);
  assertFinalSerializedSecretBytes(data, [], contentTarget);
  const resource = createResourceRecord({
    resourceId,
    kind: "mcp",
    name: candidate.name,
    contentFingerprint: publication.fingerprint,
    validation: {
      status: "validated",
      checkedAt: env.now().toISOString(),
      checks: ["content-fingerprint", "adapter-compatibility", "secret-scan"],
    },
    source: {
      type: "local-snapshot",
      ...(candidate.sources[0]?.location ? { capturedFrom: candidate.sources[0].location } : {}),
    },
  });
  const metadata = `${JSON.stringify(resource, null, 2)}\n`;
  assertFinalSerializedSecretBytes(metadata, [], metadataTarget);
  const source = {
    adapterId: captured.source.adapterId,
    path: captured.snapshot.rootPath,
    fingerprint: captured.snapshot.fingerprint,
    physicalIdentity: captured.physicalIdentity,
  };
  const providerPrecondition = { state: "absent" as const };
  const contentPayload = {
    candidateId: candidate.id,
    provider,
    providerPrecondition,
    provenance: candidate.sources,
    publication,
    resourceId,
    selector: offer.selector,
    source,
    targetName: offer.targetName,
  } as unknown as CanonicalJsonObject;
  const metadataPayload = {
    candidateId: candidate.id,
    data: metadata,
    digest: sha256(metadata),
    mode: 0o600,
    resourceId,
    sourceFingerprint: captured.snapshot.fingerprint,
  } as unknown as CanonicalJsonObject;
  return Object.freeze([
    Object.freeze({
      actionId: actionId("inventory-resource-content", contentTarget, contentPayload),
      kind: "inventory-resource-content",
      target: contentTarget,
      payload: contentPayload,
      postcondition: { state: "present" as const, fingerprint: publication.fingerprint },
    }),
    Object.freeze({
      actionId: actionId("inventory-resource-metadata", metadataTarget, metadataPayload),
      kind: "inventory-resource-metadata",
      target: metadataTarget,
      payload: metadataPayload,
      postcondition: { state: "present" as const, fingerprint: sha256(metadata) },
    }),
  ]);
}

function replaceSelectedValue(
  server: McpServer,
  selector: InventorySecretFieldSelector,
  replacement: string,
): McpServer | null {
  if (selector.server.length === 0 || server.kind === "custom") return null;
  if (selector.kind === "environment" && server.kind === "stdio") {
    if (server.env?.[selector.name] === undefined) return null;
    return { ...server, env: { ...server.env, [selector.name]: replacement } };
  }
  if (selector.kind === "argument" && server.kind === "stdio") {
    const args = [...(server.args ?? [])];
    const current = args[selector.index];
    if (current === undefined) return null;
    if (selector.style === "assignment") {
      const match = /^(-{1,2})([^=]+)=/.exec(current);
      if (!match || match[2] !== selector.name) return null;
      args[selector.index] = `${match[1]}${selector.name}=${replacement}`;
    } else {
      const flag = args[selector.index - 1];
      if (!flag || !new RegExp(`^--?${escapeRegExp(selector.name)}$`).test(flag)) return null;
      args[selector.index] = replacement;
    }
    return { ...server, args };
  }
  if (selector.kind === "header" && server.kind === "remote") {
    if (server.headers?.[selector.name] === undefined) return null;
    return { ...server, headers: { ...server.headers, [selector.name]: replacement } };
  }
  if (selector.kind === "url-query" && server.kind === "remote") {
    const url = new URL(server.url);
    if (url.searchParams.getAll(selector.name).length !== 1) return null;
    url.searchParams.set(selector.name, replacement);
    return { ...server, url: url.toString() };
  }
  return null;
}

function decodeContentAction(
  action: MutationPlanAction,
  plan: MutationPlan,
  storeRoot: string,
  candidateId: string,
  candidateName: string,
  selector: InventorySecretFieldSelector,
  provider: InventorySecretAdoptionProvider,
  providerPrecondition: InventorySecretProviderPrecondition,
  targetName: string,
): {
  readonly source: DecodedInventorySecretAdoptionPlan["source"];
  readonly publication: DecodedInventorySecretAdoptionPlan["publication"];
  readonly resourceId: string;
} | null {
  if (
    action.kind !== "inventory-resource-content" ||
    !hasExactKeys(action.payload, [
      "candidateId",
      "provider",
      "providerPrecondition",
      "provenance",
      "publication",
      "resourceId",
      "selector",
      "source",
      "targetName",
    ]) ||
    action.payload.candidateId !== candidateId ||
    action.payload.resourceId !== `mcp/${candidateName}` ||
    canonicalJson(action.payload.selector) !== canonicalJson(selector) ||
    canonicalJson(action.payload.provider) !== canonicalJson(provider) ||
    canonicalJson(action.payload.providerPrecondition) !== canonicalJson(providerPrecondition) ||
    action.payload.targetName !== targetName ||
    !Array.isArray(action.payload.provenance) ||
    !hasExactKeys(action.payload.source, [
      "adapterId",
      "fingerprint",
      "path",
      "physicalIdentity",
    ]) ||
    typeof action.payload.source.adapterId !== "string" ||
    typeof action.payload.source.path !== "string" ||
    typeof action.payload.source.fingerprint !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(action.payload.source.fingerprint) ||
    typeof action.payload.source.physicalIdentity !== "string" ||
    !hasExactKeys(action.payload.publication, ["data", "fingerprint", "kind", "mode"]) ||
    action.payload.publication.kind !== "file" ||
    typeof action.payload.publication.data !== "string" ||
    typeof action.payload.publication.mode !== "number" ||
    typeof action.payload.publication.fingerprint !== "string" ||
    sha256(action.payload.publication.data) !== action.payload.publication.fingerprint
  ) {
    return null;
  }
  const publication = action.payload
    .publication as unknown as DecodedInventorySecretAdoptionPlan["publication"];
  const parsed = serverFromRaw(JSON.parse(publication.data));
  if (
    selectedValue(parsed, selector) !== secretReferenceToken(cellarerSecretReference(targetName)) ||
    action.target !== resourceContentTarget(storeRoot, candidateName) ||
    action.actionId !== actionId(action.kind, action.target, action.payload) ||
    action.postcondition?.state !== "present" ||
    action.postcondition.fingerprint !== publication.fingerprint ||
    !matchingAbsentPrecondition(plan, action)
  ) {
    return null;
  }
  assertFinalSerializedSecretBytes(publication.data, [], action.target);
  return {
    source: action.payload.source as unknown as DecodedInventorySecretAdoptionPlan["source"],
    publication,
    resourceId: action.payload.resourceId,
  };
}

function decodeMetadataAction(
  action: MutationPlanAction,
  plan: MutationPlan,
  storeRoot: string,
  content: {
    readonly source: DecodedInventorySecretAdoptionPlan["source"];
    readonly resourceId: string;
  },
): boolean {
  if (
    action.kind !== "inventory-resource-metadata" ||
    !hasExactKeys(action.payload, [
      "candidateId",
      "data",
      "digest",
      "mode",
      "resourceId",
      "sourceFingerprint",
    ]) ||
    action.payload.resourceId !== content.resourceId ||
    action.payload.sourceFingerprint !== content.source.fingerprint ||
    typeof action.payload.data !== "string" ||
    typeof action.payload.digest !== "string" ||
    action.payload.mode !== 0o600 ||
    sha256(action.payload.data) !== action.payload.digest ||
    action.target !== resourceMetadataPath(storeRoot, "mcp", content.resourceId.slice(4)) ||
    action.actionId !== actionId(action.kind, action.target, action.payload) ||
    action.postcondition?.state !== "present" ||
    action.postcondition.fingerprint !== action.payload.digest ||
    !matchingAbsentPrecondition(plan, action)
  ) {
    return false;
  }
  assertFinalSerializedSecretBytes(action.payload.data, [], action.target);
  return true;
}

function normalizeProvider(provider: string): InventorySecretAdoptionProvider {
  if (provider === "vault") return Object.freeze({ kind: "vault" });
  if (provider === "keychain") return Object.freeze({ kind: "keychain", service: "cellarer" });
  throw new InventorySecretAdoptionPlanningError("INVALID_INPUT", "PROVIDER_UNSUPPORTED");
}

function decodeProvider(value: unknown): InventorySecretAdoptionProvider | null {
  if (hasExactKeys(value, ["kind"]) && value.kind === "vault") return { kind: "vault" };
  if (
    hasExactKeys(value, ["kind", "service"]) &&
    value.kind === "keychain" &&
    value.service === "cellarer"
  ) {
    return { kind: "keychain", service: "cellarer" };
  }
  return null;
}

function decodeProviderPrecondition(value: unknown): InventorySecretProviderPrecondition | null {
  return hasExactKeys(value, ["state"]) && value.state === "absent" ? { state: "absent" } : null;
}

function normalizeSelector(selector: InventorySecretFieldSelector): InventorySecretFieldSelector {
  const decoded = decodeSelector(selector);
  if (!decoded) {
    throw new InventorySecretAdoptionPlanningError("INVALID_INPUT", "SELECTOR_INVALID");
  }
  return Object.freeze(decoded);
}

function decodeSelector(value: unknown): InventorySecretFieldSelector | null {
  const argument =
    typeof value === "object" && value !== null && "kind" in value && value.kind === "argument";
  if (
    !hasExactKeys(
      value,
      argument ? ["index", "kind", "name", "server", "style"] : ["kind", "name", "server"],
    ) ||
    typeof value.server !== "string" ||
    !isSafeArtifactName(value.server) ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    !isSensitiveSecretFieldName(value.name)
  ) {
    return null;
  }
  if (["environment", "header", "url-query"].includes(value.kind as string)) {
    return {
      kind: value.kind as "environment" | "header" | "url-query",
      server: value.server,
      name: value.name,
    };
  }
  if (
    value.kind === "argument" &&
    typeof value.index === "number" &&
    Number.isSafeInteger(value.index) &&
    value.index >= 0 &&
    (value.style === "assignment" || value.style === "value")
  ) {
    return {
      kind: "argument",
      server: value.server,
      name: value.name,
      index: value.index,
      style: value.style,
    };
  }
  return null;
}

function selectedValue(server: McpServer, selector: InventorySecretFieldSelector): string | null {
  if (server.kind === "stdio" && selector.kind === "environment") {
    return server.env?.[selector.name] ?? null;
  }
  if (server.kind === "stdio" && selector.kind === "argument") {
    const value = server.args?.[selector.index];
    if (value === undefined) return null;
    if (selector.style === "value") return value;
    return /^--?[^=]+=(.*)$/.exec(value)?.[1] ?? null;
  }
  if (server.kind === "remote" && selector.kind === "header") {
    return server.headers?.[selector.name] ?? null;
  }
  if (server.kind === "remote" && selector.kind === "url-query") {
    const values = new URL(server.url).searchParams.getAll(selector.name);
    return values.length === 1 ? (values[0] ?? null) : null;
  }
  return null;
}

function matchingAbsentPrecondition(plan: MutationPlan, action: MutationPlanAction): boolean {
  const precondition = plan.targetPreconditions.find(
    ({ actionId }) => actionId === action.actionId,
  );
  return Boolean(
    precondition &&
      precondition.target === action.target &&
      precondition.expected.state === "absent",
  );
}

type AuthorizedAdoptionAction = {
  readonly action: MutationPlanAction;
  readonly before: import("../protocol/client-types.js").TargetStateReceipt;
};

async function authorizeAdoptionActions(
  decoded: DecodedInventorySecretAdoptionPlan,
  authorize: AuthorizeOperationAction,
): Promise<
  | { readonly ok: true; readonly actions: readonly AuthorizedAdoptionAction[] }
  | {
      readonly ok: false;
      readonly receipts: readonly OperationActionReceipt[];
      readonly failedActionIds: readonly string[];
    }
> {
  const actions: AuthorizedAdoptionAction[] = [];
  const failures: OperationActionReceipt[] = [];
  for (const action of decoded.actions) {
    const result = await authorize(action.actionId);
    if (result.ok) actions.push({ action, before: result.before });
    else failures.push(result.receipt);
  }
  if (failures.length === 0) return { ok: true, actions };
  const unchanged = actions.map(({ action, before }) => ({
    actionId: action.actionId,
    target: action.target,
    outcome: "compensated" as const,
    before,
    after: before,
    recordedAt: failures[0]?.recordedAt ?? new Date(0).toISOString(),
  }));
  return {
    ok: false,
    receipts: [...failures, ...unchanged],
    failedActionIds: failures.map(({ actionId }) => actionId),
  };
}

function rejectedAdoptionReceipts(
  env: Env,
  actions: readonly AuthorizedAdoptionAction[],
  code: "PROVIDER_PRECONDITION_CONFLICT" | "PROVIDER_UNAVAILABLE",
): readonly OperationActionReceipt[] {
  return actions.map(({ action, before }, index) => ({
    actionId: action.actionId,
    target: action.target,
    outcome: index === 0 ? "failed" : "compensated",
    before,
    after: before,
    recordedAt: env.now().toISOString(),
    ...(index === 0
      ? {
          error: {
            code,
            message:
              code === "PROVIDER_PRECONDITION_CONFLICT"
                ? "the exact provider reference is not absent"
                : "the exact provider reference could not be created",
          },
        }
      : {}),
  }));
}

function readBoundAdoptionValue(
  source: { readonly snapshot: SafeRecursiveSnapshot; readonly adapter: AgentAdapter },
  candidateName: string,
  selector: InventorySecretFieldSelector,
): string {
  if (
    source.snapshot.kind !== "file" ||
    source.snapshot.files.length !== 1 ||
    !source.adapter.mcp
  ) {
    throw new TypeError("the authorized adoption source is not a supported MCP file");
  }
  const decoded = source.adapter.mcp.codec.decode(
    source.snapshot.files[0]?.content ?? "",
    source.adapter.mcp.serversKey,
  );
  const server = decoded.servers[candidateName];
  const value = server ? selectedValue(server, selector) : null;
  if (value === null || value.length === 0 || value.includes("${CELLARER_SECRET:")) {
    throw new TypeError("the plan-bound MCP field is no longer adoptable");
  }
  return value;
}

async function executeAdoptionStoreAction(
  env: Env,
  storeRoot: string,
  action: MutationPlanAction,
): Promise<void> {
  await assertSafeAtomicPublicationPath(env, action.target, storeRoot, "Inventory secret adoption");
  const payload = action.payload;
  let data: string;
  let mode: number;
  if (action.kind === "inventory-resource-content") {
    const publication = payload.publication as {
      readonly kind?: unknown;
      readonly data?: unknown;
      readonly mode?: unknown;
    };
    if (
      publication?.kind !== "file" ||
      typeof publication.data !== "string" ||
      typeof publication.mode !== "number"
    ) {
      throw new TypeError("invalid adoption content publication");
    }
    data = publication.data;
    mode = publication.mode;
  } else if (
    action.kind === "inventory-resource-metadata" &&
    typeof payload.data === "string" &&
    typeof payload.mode === "number"
  ) {
    data = payload.data;
    mode = payload.mode;
  } else {
    throw new TypeError("invalid adoption Store action");
  }
  assertFinalSerializedSecretBytes(data, [], action.target);
  await env.fs.mkdir(dirname(action.target), { recursive: true });
  await env.fs.publishFileAtomically(action.target, data, { mode });
}

async function compensateAdoptionStoreActions(
  env: Env,
  actions: readonly AuthorizedAdoptionAction[],
): Promise<void> {
  for (const { action, before } of actions) {
    if (before.state === "absent") {
      await env.fs.rm(action.target, { recursive: true, force: true });
    }
  }
}

async function adoptionActionReceipt(
  env: Env,
  item: AuthorizedAdoptionAction,
  failed: boolean,
  errorCode: string | undefined,
): Promise<OperationActionReceipt> {
  const after = await targetState(env, item.action.target);
  const unchanged = sameAdoptionTargetState(item.before, after);
  return {
    actionId: item.action.actionId,
    target: item.action.target,
    outcome: failed ? "failed" : unchanged ? "compensated" : "applied",
    before: item.before,
    after,
    recordedAt: env.now().toISOString(),
    ...(failed
      ? {
          error: {
            code: errorCode ?? "STORE_PUBLICATION_FAILED",
            message: "reference-bearing Store publication failed",
          },
        }
      : {}),
  };
}

function sameAdoptionTargetState(
  expected: import("../protocol/client-types.js").TargetStateReceipt | undefined,
  actual: import("../protocol/client-types.js").TargetStateReceipt,
): boolean {
  return (
    expected !== undefined &&
    expected.state === actual.state &&
    (expected.state === "absent" ||
      (actual.state === "present" && expected.fingerprint === actual.fingerprint))
  );
}

function adoptionSourceConflict(expectedFingerprint: string, actualFingerprint: string | null) {
  return {
    ok: false as const,
    conflict: {
      code: "TARGET_PRECONDITION_CONFLICT" as const,
      message: "Inventory candidate changed after planning; refresh and replan required",
      planId: "untrusted",
      actionId: "untrusted",
      target: "untrusted",
      expected: { state: "present" as const, fingerprint: expectedFingerprint },
      actual:
        actualFingerprint === null
          ? ({ state: "absent" as const } as const)
          : ({ state: "present" as const, fingerprint: actualFingerprint } as const),
    },
  };
}

function adoptionApplied(
  mutationPlan: MutationPlan,
  decoded: DecodedInventorySecretAdoptionPlan,
  status: InventorySecretAdoptionApplyStatus,
  operation: OperationResult,
  orphan?: InventorySecretAdoptionOrphanEvidence,
): AppliedInventorySecretAdoption {
  return Object.freeze({
    mutationPlan,
    candidateId: decoded.candidateId,
    provider: decoded.provider,
    targetName: decoded.targetName,
    status,
    operation,
    ...(orphan ? { orphan } : {}),
  });
}

function invalidAppliedAdoption(mutationPlan: MutationPlan): AppliedInventorySecretAdoption {
  return Object.freeze({
    mutationPlan,
    candidateId: null,
    provider: null,
    targetName: null,
    status: "rejected",
    operation: invalidPlanResult(),
  });
}

function resourceContentTarget(storeRoot: string, name: string): string {
  return join(storeRoot, "store", "mcp", `${name}.json`);
}

function actionId(kind: string, target: string, payload: CanonicalJsonObject): string {
  return sha256(canonicalJson({ kind, target, payloadDigest: sha256(canonicalJson(payload)) }));
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
