import { basename, dirname, join, normalize } from "node:path";
import { loadRegistry } from "../adapters/registry.js";
import type {
  Env,
  FileTreeSnapshot,
  FileTreeSnapshotNode,
  RemoteResourceSourceEvidence,
} from "../env.js";
import { serverFromRaw } from "../mcp/model.js";
import type { Artifact, ArtifactKind } from "../model/index.js";
import {
  assertCurrentMutationAuthorityScope,
  assertStrictMutationPlanRuntime,
  type CurrentMutationAuthorityScope,
  canonicalJson,
  verifyMutationPlanAuthorization,
  verifyMutationPlanDigest,
  withCurrentMutationAuthorityScope,
} from "../protocol/canonical.js";
import {
  assertMutationPlanActionAlignment,
  executeMutationPlan,
  invalidPlanResult,
  targetState,
} from "../protocol/execute.js";
import type {
  CanonicalJsonObject,
  MutationPlan,
  OperationActionReceipt,
  OperationResult,
} from "../protocol/models.js";
import {
  decodeStoreProvenance,
  type PreparedStoreMutationAction,
  planStoreActionMutation,
  validateStoreProvenance,
} from "../protocol/store-mutation.js";
import { discoverSecretReferences } from "../secrets/active-values.js";
import {
  isSensitiveSecretFieldName,
  scanStructuredFileSecretFindings,
  scanTextForSecrets,
} from "../secrets/detector.js";
import { containsObservableKnownValue, observableKnownValues } from "../secrets/observable.js";
import {
  captureAnchoredSafeRecursiveSource,
  captureSafeRecursiveSource,
  installSafeRecursiveSnapshot,
  type SafeRecursiveSnapshot,
} from "../secrets/safe-tree.js";
import { sha256 } from "../store/checksum.js";
import { loadLedger } from "../store/ledger.js";
import { listMcpArtifacts, listRuleArtifacts, listSkillArtifacts } from "../store/store.js";
import {
  createResourceRecord,
  loadResourceRecord,
  parseResourceRecord,
  type ResourceRecord,
  type ResourceSourceDescriptor,
  type ResourceValidationEvidence,
  resourceMetadataPath,
  resourceRevisionContentPath,
  resourceSourceCanCheckForUpdates,
  resourceSourceDescriptorSchema,
} from "./model.js";

const UPDATE_MUTATION_KIND = "resource-update";
const STAGE_SCHEMA_VERSION = 1;

export type ResourceUpdateCheck =
  | {
      readonly status: "uncheckable";
      readonly resourceId: string;
      readonly currentRevisionId: string;
      readonly reason: "no-verifiable-remote-source";
    }
  | {
      readonly status: "current" | "update-available";
      readonly resourceId: string;
      readonly currentRevisionId: string;
      readonly currentContentFingerprint: string;
      readonly checkedAt: string;
      readonly evidence: RemoteResourceSourceEvidence;
    };

export interface ResourceUpdateDiffFile {
  readonly path: string;
  readonly change: "added" | "removed" | "modified";
  readonly beforeFingerprint?: string;
  readonly afterFingerprint?: string;
}

export interface ResourceUpdateDiff {
  readonly type: "resource-content";
  readonly resourceId: string;
  readonly redacted: true;
  readonly files: readonly ResourceUpdateDiffFile[];
}

export interface StagedResourceUpdate {
  readonly schemaVersion: 1;
  readonly resourceId: string;
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly currentRevisionId: string;
  readonly currentContentFingerprint: string;
  readonly sourceEvidence: RemoteResourceSourceEvidence;
  readonly stagedContentDigest: string;
  readonly stagedBytes: number;
  readonly stagePath: string;
  readonly stageFileDigest: string;
  readonly validation: ResourceValidationEvidence;
  readonly diff: ResourceUpdateDiff;
}

export interface PlannedResourceUpdate {
  readonly plan: MutationPlan;
  readonly resource: ResourceRecord;
  readonly diff: ResourceUpdateDiff;
}

export interface PlannedAvailableResourceUpdate extends PlannedResourceUpdate {
  readonly check: ResourceUpdateCheck;
  readonly candidate: StagedResourceUpdate;
}

export interface AppliedResourceUpdate {
  readonly plan: MutationPlan;
  readonly resource: ResourceRecord | null;
  readonly operation: OperationResult;
}

interface EncodedCandidateNode {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly mode: number;
  readonly dataHex?: string;
  readonly digest?: string;
}

interface EncodedCandidateContent {
  readonly kind: "file" | "directory";
  readonly nodes: readonly EncodedCandidateNode[];
  readonly fingerprint: string;
  readonly byteLength: number;
  readonly digest: string;
}

interface ResourceUpdateStageFile {
  readonly schemaVersion: 1;
  readonly resourceId: string;
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly currentRevisionId: string;
  readonly currentContentFingerprint: string;
  readonly currentSourceEvidence: ResourceSourceDescriptor;
  readonly sourceEvidence: RemoteResourceSourceEvidence;
  readonly content: EncodedCandidateContent;
  readonly stagedContentDigest: string;
  readonly stagedBytes: number;
  readonly validation: ResourceValidationEvidence;
  readonly diff: ResourceUpdateDiff;
}

export class ResourceUpdateError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly findings?: readonly { readonly path: string; readonly rule: string }[],
  ) {
    super(message);
    this.name = "ResourceUpdateError";
  }
}

export async function checkResourceUpdate(
  env: Env,
  opts: { readonly storeRoot: string; readonly resourceId: string },
): Promise<ResourceUpdateCheck> {
  const current = await exactResource(env, opts.storeRoot, opts.resourceId);
  const source = current.record.currentRevision.source;
  if (!resourceSourceCanCheckForUpdates(source)) {
    return Object.freeze({
      status: "uncheckable",
      resourceId: current.record.resourceId,
      currentRevisionId: current.record.currentRevision.id,
      reason: "no-verifiable-remote-source",
    });
  }
  const transport = env.resourceSourceTransport;
  if (!transport) {
    throw new ResourceUpdateError(
      "SOURCE_TRANSPORT_UNAVAILABLE",
      "resource source transport is unavailable",
    );
  }
  const expected = remoteEvidence(source);
  const checked = remoteEvidence(await transport.check(expected));
  assertSameSourceLocator(expected, checked);
  return Object.freeze({
    status: sameEvidence(expected, checked) ? "current" : "update-available",
    resourceId: current.record.resourceId,
    currentRevisionId: current.record.currentRevision.id,
    currentContentFingerprint: current.record.currentRevision.contentFingerprint,
    checkedAt: env.now().toISOString(),
    evidence: Object.freeze({ ...checked }),
  });
}

export async function stageResourceUpdate(
  env: Env,
  opts: { readonly storeRoot: string; readonly check: ResourceUpdateCheck },
): Promise<StagedResourceUpdate> {
  return withCurrentMutationAuthorityScope(env, (authorityScope) =>
    stageResourceUpdateWithinAuthorityScope(env, opts, authorityScope),
  );
}

async function stageResourceUpdateWithinAuthorityScope(
  env: Env,
  opts: { readonly storeRoot: string; readonly check: ResourceUpdateCheck },
  authorityScope: CurrentMutationAuthorityScope,
): Promise<StagedResourceUpdate> {
  await assertCurrentMutationAuthorityScope(env, authorityScope);
  if (opts.check.status !== "update-available") {
    throw new ResourceUpdateError("UPDATE_NOT_AVAILABLE", "resource update is not available");
  }
  const current = await exactResource(env, opts.storeRoot, opts.check.resourceId);
  assertCurrentCheck(current.record, opts.check);
  const transport = env.resourceSourceTransport;
  if (!transport) {
    throw new ResourceUpdateError(
      "SOURCE_TRANSPORT_UNAVAILABLE",
      "resource source transport is unavailable",
    );
  }

  const fetched = await transport.fetch(opts.check.evidence);
  try {
    const evidence = remoteEvidence(fetched.evidence);
    if (!sameEvidence(evidence, opts.check.evidence)) {
      throw new ResourceUpdateError(
        "SOURCE_EVIDENCE_CHANGED",
        "source evidence changed between check and staging",
      );
    }
    const content = encodeCandidateContent(fetched.nodes);
    if (evidence.type === "url" && evidence.integrity !== content.fingerprint) {
      throw new ResourceUpdateError(
        "CANDIDATE_INTEGRITY_FAILED",
        "URL candidate does not match its immutable integrity evidence",
      );
    }
    await validateCandidate(env, opts.storeRoot, current, content);
    const validation: ResourceValidationEvidence = {
      status: "validated",
      checkedAt: env.now().toISOString(),
      checks: ["content-fingerprint", "manifest", "adapter-compatibility", "secret-scan"],
    };
    const before = await captureSafeRecursiveSource(env, current.artifact.sourcePath);
    const diff = redactedDiff(current.record.resourceId, before, content);
    const stageFile: ResourceUpdateStageFile = {
      schemaVersion: STAGE_SCHEMA_VERSION,
      resourceId: current.record.resourceId,
      kind: current.record.kind,
      name: current.record.name,
      currentRevisionId: current.record.currentRevision.id,
      currentContentFingerprint: current.record.currentRevision.contentFingerprint,
      currentSourceEvidence: current.record.currentRevision.source,
      sourceEvidence: evidence,
      content,
      stagedContentDigest: content.digest,
      stagedBytes: content.byteLength,
      validation,
      diff,
    };
    const serialized = `${JSON.stringify(stageFile, null, 2)}\n`;
    const stagePath = resourceUpdateStagePath(opts.storeRoot, env.randomId());
    await env.fs.mkdir(dirname(stagePath), { recursive: true, mode: 0o700 });
    await env.fs.publishFileAtomically(stagePath, serialized, { mode: 0o600 });
    return deepFreeze({
      schemaVersion: 1 as const,
      resourceId: stageFile.resourceId,
      kind: stageFile.kind,
      name: stageFile.name,
      currentRevisionId: stageFile.currentRevisionId,
      currentContentFingerprint: stageFile.currentContentFingerprint,
      sourceEvidence: stageFile.sourceEvidence,
      stagedContentDigest: stageFile.stagedContentDigest,
      stagedBytes: stageFile.stagedBytes,
      stagePath,
      stageFileDigest: sha256(serialized),
      validation,
      diff,
    });
  } finally {
    await fetched.cleanup?.().catch(() => undefined);
  }
}

export async function discardResourceUpdateStage(
  env: Env,
  opts: {
    readonly storeRoot: string;
    readonly candidate: Pick<StagedResourceUpdate, "stagePath">;
  },
): Promise<void> {
  await readStageFile(env, opts.storeRoot, opts.candidate.stagePath);
  await env.fs.rm(opts.candidate.stagePath, { force: true });
}

export async function planResourceUpdate(
  env: Env,
  opts: { readonly storeRoot: string; readonly candidate: StagedResourceUpdate },
): Promise<PlannedResourceUpdate> {
  return withCurrentMutationAuthorityScope(env, (authorityScope) =>
    planResourceUpdateWithinAuthorityScope(env, opts, authorityScope),
  );
}

async function planResourceUpdateWithinAuthorityScope(
  env: Env,
  opts: { readonly storeRoot: string; readonly candidate: StagedResourceUpdate },
  authorityScope: CurrentMutationAuthorityScope,
): Promise<PlannedResourceUpdate> {
  const authorityLease = await assertCurrentMutationAuthorityScope(env, authorityScope);
  const stage = await loadBoundStage(env, opts.storeRoot, opts.candidate);
  const current = await exactResource(env, opts.storeRoot, stage.resourceId);
  assertStageCurrent(current.record, stage);
  await validateCandidate(env, opts.storeRoot, current, stage.content);
  const resource = createResourceRecord({
    resourceId: stage.resourceId,
    kind: stage.kind,
    name: stage.name,
    contentFingerprint: stage.content.fingerprint,
    validation: stage.validation,
    source: stage.sourceEvidence,
  });
  const revisionPath = resourceRevisionContentPath(
    opts.storeRoot,
    resource.resourceId,
    resource.currentRevision.contentFingerprint,
  );
  const metadataPath = resourceMetadataPath(opts.storeRoot, resource.kind, resource.name);
  const metadataData = `${JSON.stringify(resource, null, 2)}\n`;
  const existingRevision = await targetState(env, revisionPath);
  if (
    existingRevision.state === "present" &&
    existingRevision.fingerprint !== resource.currentRevision.contentFingerprint
  ) {
    throw new ResourceUpdateError(
      "REVISION_INTEGRITY_CONFLICT",
      "immutable resource revision path contains different content",
    );
  }
  const contentAction = candidateAction(stage, revisionPath);
  const metadataAction = metadataMutationAction(metadataPath, metadataData);
  const normalizedInputs: CanonicalJsonObject = {
    changedFields: ["currentRevision"],
    resourceId: resource.resourceId,
    kind: resource.kind,
    name: resource.name,
    currentRevisionId: stage.currentRevisionId,
    currentContentFingerprint: stage.currentContentFingerprint,
    currentSourceEvidence: stage.currentSourceEvidence as unknown as CanonicalJsonObject,
    sourceEvidence: stage.sourceEvidence as unknown as CanonicalJsonObject,
    stagedContentDigest: stage.stagedContentDigest,
    stagedBytes: stage.stagedBytes,
    redactedDiff: stage.diff as unknown as CanonicalJsonObject,
    stagePath: opts.candidate.stagePath,
    stageFileDigest: opts.candidate.stageFileDigest,
    desiredStateEffect: "diverged-until-distributed",
  };
  const planned = await planStoreActionMutation(
    env,
    opts.storeRoot,
    "store-import",
    UPDATE_MUTATION_KIND,
    async () => ({
      value: undefined,
      actions: [contentAction, metadataAction],
    }),
    {
      provenancePaths: [current.artifact.sourcePath, metadataPath, opts.candidate.stagePath],
      normalizedInputs,
    },
    { authorityLease },
  );
  return { plan: planned.plan, resource, diff: stage.diff };
}

export async function planAvailableResourceUpdate(
  env: Env,
  opts: { readonly storeRoot: string; readonly resourceId: string },
): Promise<PlannedAvailableResourceUpdate> {
  return withCurrentMutationAuthorityScope(env, async (authorityScope) => {
    await assertCurrentMutationAuthorityScope(env, authorityScope);
    const check = await checkResourceUpdate(env, opts);
    const candidate = await stageResourceUpdateWithinAuthorityScope(
      env,
      { storeRoot: opts.storeRoot, check },
      authorityScope,
    );
    const planned = await planResourceUpdateWithinAuthorityScope(
      env,
      { storeRoot: opts.storeRoot, candidate },
      authorityScope,
    );
    return { check, candidate, ...planned };
  });
}

export async function applyResourceUpdatePlan(
  env: Env,
  plan: MutationPlan,
  opts: { readonly storeRoot: string },
): Promise<AppliedResourceUpdate> {
  try {
    assertStrictMutationPlanRuntime(plan, "store-import");
  } catch {
    return invalidApplied(plan);
  }
  if (!verifyMutationPlanAuthorization(env, opts.storeRoot, plan)) return invalidApplied(plan);
  if (!verifyMutationPlanDigest(plan)) return invalidApplied(plan);
  let decoded: DecodedResourceUpdate;
  try {
    assertMutationPlanActionAlignment(plan);
    decoded = decodeResourceUpdatePlan(plan, opts.storeRoot);
  } catch {
    return invalidApplied(plan);
  }

  const validate = async (): Promise<OperationResult | null> => {
    const provenance = await validateStoreProvenance(env, opts.storeRoot, plan);
    if (provenance) return provenance;
    const stage = await readStageFile(env, opts.storeRoot, decoded.stagePath).catch(() => null);
    if (
      !stage ||
      stage.serializedDigest !== decoded.stageFileDigest ||
      canonicalJson(stage.value) !== canonicalJson(decoded.stage)
    ) {
      return invalidPlanResult();
    }
    const current = await exactResource(env, opts.storeRoot, decoded.resource.resourceId).catch(
      () => null,
    );
    if (
      !current ||
      current.record.currentRevision.id !== decoded.stage.currentRevisionId ||
      current.record.currentRevision.contentFingerprint !==
        decoded.stage.currentContentFingerprint ||
      !sameEvidence(
        remoteEvidence(current.record.currentRevision.source),
        remoteEvidence(decoded.stage.currentSourceEvidence),
      )
    ) {
      return invalidPlanResult();
    }
    try {
      await validateCandidate(env, opts.storeRoot, current, decoded.stage.content);
    } catch {
      return invalidPlanResult();
    }
    return validateStoreProvenance(env, opts.storeRoot, plan);
  };

  const operation = await executeMutationPlan(
    env,
    opts.storeRoot,
    plan,
    async (_operationId, record, authorize) => {
      const receipts: OperationActionReceipt[] = [];
      const failedActionIds: string[] = [];
      for (const action of plan.actions) {
        const authorized = await authorize(action.actionId);
        if (!authorized.ok) {
          receipts.push(authorized.receipt);
          failedActionIds.push(action.actionId);
          break;
        }
        let failure: { code: string; message: string } | undefined;
        try {
          if (action.kind === "install-resource-revision") {
            const actual = await targetState(env, action.target);
            if (
              actual.state !== "present" ||
              actual.fingerprint !== decoded.stage.content.fingerprint
            ) {
              await installCandidateContent(env, decoded.stage.content, action.target);
            }
          } else if (action.kind === "publish-resource-metadata") {
            await env.fs.publishFileAtomically(action.target, decoded.metadataData, {
              mode: 0o600,
            });
          } else {
            throw new TypeError("resource update plan contains an unsupported action");
          }
          const after = await targetState(env, action.target);
          if (
            !action.postcondition ||
            after.state !== action.postcondition.state ||
            (after.state === "present" &&
              action.postcondition.state === "present" &&
              after.fingerprint !== action.postcondition.fingerprint)
          ) {
            throw Object.assign(new Error("resource update postcondition failed"), {
              code: "ACTION_POSTCONDITION_FAILED",
            });
          }
        } catch (error) {
          const code = controlledIoCode(error);
          if (!code) throw error;
          failure = { code, message: `filesystem action failed (${code})` };
          failedActionIds.push(action.actionId);
        }
        const after = await targetState(env, action.target);
        const receipt: OperationActionReceipt = {
          actionId: action.actionId,
          target: action.target,
          outcome: failure
            ? "failed"
            : sameTargetReceipt(authorized.before, after)
              ? "unchanged"
              : "applied",
          before: authorized.before,
          after,
          recordedAt: env.now().toISOString(),
          ...(failure ? { error: failure } : {}),
        };
        await record(receipt);
        receipts.push(receipt);
        if (failure) break;
      }
      return {
        actionReceipts: receipts,
        ...(failedActionIds.length > 0 ? { failedActionIds } : {}),
      };
    },
    {
      validatePreflightBeforeObservation: validate,
      validateBeforeObservationUnderLock: validate,
      validateUnderLock: validate,
    },
  );
  if (operation.ok) await env.fs.rm(decoded.stagePath, { force: true }).catch(() => undefined);
  return { plan, resource: decoded.resource, operation };
}

interface ExactResource {
  readonly artifact: Artifact;
  readonly record: ResourceRecord;
}

async function exactResource(
  env: Env,
  storeRoot: string,
  resourceId: string,
): Promise<ExactResource> {
  const artifacts = (
    await Promise.all([
      listRuleArtifacts(env, storeRoot),
      listMcpArtifacts(env, storeRoot),
      listSkillArtifacts(env, storeRoot),
    ])
  ).flat();
  const matches = artifacts.filter((artifact) => artifact.id === resourceId);
  if (matches.length !== 1 || !matches[0]) {
    throw new ResourceUpdateError("RESOURCE_NOT_FOUND", "exact resource ID was not found");
  }
  return {
    artifact: matches[0],
    record: await loadResourceRecord(env, storeRoot, matches[0]),
  };
}

function remoteEvidence(source: unknown): RemoteResourceSourceEvidence {
  const parsed = resourceSourceDescriptorSchema.parse(source);
  if (parsed.type === "local-snapshot") {
    throw new ResourceUpdateError(
      "SOURCE_NOT_CHECKABLE",
      "resource has no verifiable remote source",
    );
  }
  return parsed;
}

function assertSameSourceLocator(
  expected: ResourceSourceDescriptor,
  actual: ResourceSourceDescriptor,
): void {
  const same =
    expected.type === actual.type &&
    (expected.type === "git" && actual.type === "git"
      ? expected.repositoryUrl === actual.repositoryUrl &&
        expected.ref === actual.ref &&
        expected.subpath === actual.subpath
      : expected.type === "url" && actual.type === "url" && expected.url === actual.url);
  if (!same) {
    throw new ResourceUpdateError(
      "SOURCE_LOCATOR_CHANGED",
      "source transport changed the configured source locator",
    );
  }
}

function sameEvidence(
  left: RemoteResourceSourceEvidence,
  right: RemoteResourceSourceEvidence,
): boolean {
  return (
    canonicalJson(left as unknown as CanonicalJsonObject) ===
    canonicalJson(right as unknown as CanonicalJsonObject)
  );
}

function assertCurrentCheck(
  record: ResourceRecord,
  check: Extract<ResourceUpdateCheck, { evidence: unknown }>,
): void {
  if (
    record.resourceId !== check.resourceId ||
    record.currentRevision.id !== check.currentRevisionId ||
    record.currentRevision.contentFingerprint !== check.currentContentFingerprint
  ) {
    throw new ResourceUpdateError(
      "CURRENT_REVISION_CHANGED",
      "resource revision changed after update check",
    );
  }
  assertSameSourceLocator(record.currentRevision.source, remoteEvidence(check.evidence));
}

function assertStageCurrent(record: ResourceRecord, stage: ResourceUpdateStageFile): void {
  if (
    record.resourceId !== stage.resourceId ||
    record.kind !== stage.kind ||
    record.name !== stage.name ||
    record.currentRevision.id !== stage.currentRevisionId ||
    record.currentRevision.contentFingerprint !== stage.currentContentFingerprint ||
    canonicalJson(record.currentRevision.source as unknown as CanonicalJsonObject) !==
      canonicalJson(stage.currentSourceEvidence as unknown as CanonicalJsonObject)
  ) {
    throw new ResourceUpdateError(
      "CURRENT_REVISION_CHANGED",
      "resource revision changed after candidate staging",
    );
  }
}

function encodeCandidateContent(nodes: readonly FileTreeSnapshotNode[]): EncodedCandidateContent {
  if (nodes.length === 0 || nodes.length > 100_000) {
    throw new TypeError("candidate node budget exceeded");
  }
  const paths = new Set<string>();
  const encoded = nodes.map((node) => {
    assertCandidatePath(node.relativePath);
    if (paths.has(node.relativePath)) throw new TypeError("candidate paths must be unique");
    paths.add(node.relativePath);
    if (!Number.isInteger(node.mode) || node.mode < 0 || node.mode > 0o7777) {
      throw new TypeError("candidate mode is invalid");
    }
    if (node.kind === "directory") {
      if (node.data !== undefined) throw new TypeError("candidate directory contains bytes");
      return { path: node.relativePath, kind: node.kind, mode: node.mode } as const;
    }
    if (!node.data) throw new TypeError("candidate file bytes are missing");
    return {
      path: node.relativePath,
      kind: node.kind,
      mode: node.mode,
      dataHex: bytesToHex(node.data),
      digest: sha256(node.data),
    } as const;
  });
  encoded.sort((left, right) => left.path.localeCompare(right.path));
  const root = encoded.find((node) => node.path === "");
  if (!root) throw new TypeError("candidate root is missing");
  for (const node of encoded) {
    if (!node.path) continue;
    const parent = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";
    if (!encoded.some((candidate) => candidate.path === parent && candidate.kind === "directory")) {
      throw new TypeError("candidate parent directory is missing");
    }
  }
  const fingerprint =
    root.kind === "file"
      ? (root.digest ?? sha256(new Uint8Array()))
      : sha256(
          JSON.stringify(
            encoded.map((node) =>
              node.kind === "directory"
                ? { path: node.path, kind: node.kind, mode: node.mode }
                : { path: node.path, kind: node.kind, mode: node.mode, digest: node.digest },
            ),
          ),
        );
  const byteLength = encoded.reduce(
    (total, node) => total + (node.dataHex ? node.dataHex.length / 2 : 0),
    0,
  );
  if (byteLength > 224 * 1024 * 1024) {
    throw new TypeError("candidate byte budget exceeded");
  }
  const content = { kind: root.kind, nodes: encoded, fingerprint, byteLength };
  return { ...content, digest: sha256(JSON.stringify(content)) };
}

function assertCandidatePath(path: string): void {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.endsWith("/") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError("candidate path is unsafe");
  }
}

async function validateCandidate(
  env: Env,
  storeRoot: string,
  current: ExactResource,
  content: EncodedCandidateContent,
): Promise<void> {
  validateEncodedContent(content);
  const files = content.nodes.filter(
    (node): node is EncodedCandidateNode & { dataHex: string; digest: string } =>
      node.kind === "file" && typeof node.dataHex === "string" && typeof node.digest === "string",
  );
  if (current.record.kind === "skills") {
    if (content.kind !== "directory") throw new TypeError("Skill update must be a directory");
    const manifest = files.find((file) => file.path === "SKILL.md");
    if (!manifest) throw new TypeError("Skill update is missing SKILL.md");
    const text = decodeUtf8(manifest.dataHex);
    const name = text.match(/^---\r?\n[\s\S]*?^name:\s*["']?([^"'\r\n]+)["']?\s*$/m)?.[1]?.trim();
    const description = text
      .match(/^---\r?\n[\s\S]*?^description:\s*["']?([^"'\r\n]+)["']?\s*$/m)?.[1]
      ?.trim();
    if (name !== current.record.name || !description) {
      throw new TypeError("Skill manifest identity or description is invalid");
    }
  } else {
    if (content.kind !== "file" || files.length !== 1 || files[0]?.path !== "") {
      throw new TypeError("Rule and MCP updates must be one regular file");
    }
    const text = decodeUtf8(files[0].dataHex);
    if (current.record.kind === "rules" && text.trim().length === 0) {
      throw new TypeError("Rule update is empty");
    }
    if (current.record.kind === "mcp") serverFromRaw(JSON.parse(text));
  }

  const findings = files.flatMap((file) => {
    const text = decodeUtf8(file.dataHex);
    return [
      ...scanStructuredFileSecretFindings(file.path || current.record.name, text).map(
        (finding) => ({
          path: file.path,
          rule: finding.rule,
        }),
      ),
      ...scanTextForSecrets(text).map((finding) => ({ path: file.path, rule: finding.rule })),
    ];
  });
  const known = Object.entries(env.env).flatMap(([name, value]) =>
    value && isSensitiveSecretFieldName(name) ? [value] : [],
  );
  for (const file of files) {
    const text = decodeUtf8(file.dataHex);
    if (
      containsObservableKnownValue(text, observableKnownValues(env)) ||
      known.some((value) => value.length > 0 && text.includes(value))
    ) {
      findings.push({ path: file.path, rule: "known-secret-value" });
    }
  }
  if (findings.length > 0) {
    throw new ResourceUpdateError(
      "CANDIDATE_SECRET_BLOCKED",
      "candidate contains blocked secret-like content",
      findings.map((finding) => ({ path: finding.path, rule: finding.rule })),
    );
  }

  const [registry, ledger] = await Promise.all([
    loadRegistry(env, storeRoot),
    loadLedger(env, storeRoot),
  ]);
  const owners = ledger.owners.filter((owner) =>
    owner.artifactIds.includes(current.record.resourceId),
  );
  const references = discoverSecretReferences(files.map((file) => decodeUtf8(file.dataHex)));
  for (const owner of owners) {
    const adapter = registry.get(owner.agent);
    const paths = adapter?.paths(
      env,
      owner.scope,
      owner.scope === "project" ? owner.projectRoot : undefined,
    );
    const target =
      current.record.kind === "rules"
        ? paths?.rules
        : current.record.kind === "mcp"
          ? paths?.mcp
          : paths?.skillsDir;
    if (
      !adapter ||
      !target ||
      (current.record.kind === "mcp" && !adapter.mcp) ||
      !(adapter.capabilities[current.record.kind] ?? []).includes(owner.scope)
    ) {
      throw new ResourceUpdateError(
        "ADAPTER_INCOMPATIBLE",
        "candidate is incompatible with an existing applied adapter target",
      );
    }
    if (current.record.kind === "mcp" && adapter.mcp) {
      const unsupported = references.find(
        (reference) => !adapter.mcp?.supportedSecretReferences.includes(reference.kind),
      );
      if (unsupported) {
        throw new ResourceUpdateError(
          "ADAPTER_INCOMPATIBLE",
          "candidate uses a reference unsupported by an existing applied adapter target",
        );
      }
    }
  }
}

function validateEncodedContent(content: EncodedCandidateContent): void {
  const reconstructed = encodeCandidateContent(
    content.nodes.map((node) => ({
      relativePath: node.path,
      kind: node.kind,
      mode: node.mode,
      identity: `staged:${node.path}`,
      ...(node.kind === "file" && node.dataHex ? { data: hexToBytes(node.dataHex) } : {}),
    })),
  );
  if (
    canonicalJson(reconstructed as unknown as CanonicalJsonObject) !==
    canonicalJson(content as unknown as CanonicalJsonObject)
  ) {
    throw new TypeError("staged candidate content evidence is invalid");
  }
}

function redactedDiff(
  resourceId: string,
  before: SafeRecursiveSnapshot,
  after: EncodedCandidateContent,
): ResourceUpdateDiff {
  const oldFiles = new Map(before.files.map((file) => [file.relativePath, sha256(file.data)]));
  const newFiles = new Map(
    after.nodes.flatMap((node) =>
      node.kind === "file" && node.digest ? [[node.path, node.digest] as const] : [],
    ),
  );
  const files: ResourceUpdateDiffFile[] = [];
  for (const path of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
    const oldDigest = oldFiles.get(path);
    const newDigest = newFiles.get(path);
    if (oldDigest === newDigest) continue;
    files.push({
      path,
      change: oldDigest ? (newDigest ? "modified" : "removed") : "added",
      ...(oldDigest ? { beforeFingerprint: oldDigest } : {}),
      ...(newDigest ? { afterFingerprint: newDigest } : {}),
    });
  }
  return { type: "resource-content", resourceId, redacted: true, files };
}

function resourceUpdateStagePath(storeRoot: string, randomId: string): string {
  return join(storeRoot, "resource-update-staging", `${sha256(randomId).slice(7)}.json`);
}

async function loadBoundStage(
  env: Env,
  storeRoot: string,
  candidate: StagedResourceUpdate,
): Promise<ResourceUpdateStageFile> {
  const loaded = await readStageFile(env, storeRoot, candidate.stagePath);
  if (
    loaded.serializedDigest !== candidate.stageFileDigest ||
    loaded.value.resourceId !== candidate.resourceId ||
    loaded.value.currentRevisionId !== candidate.currentRevisionId ||
    loaded.value.stagedContentDigest !== candidate.stagedContentDigest ||
    loaded.value.stagedBytes !== candidate.stagedBytes ||
    canonicalJson(loaded.value.sourceEvidence as unknown as CanonicalJsonObject) !==
      canonicalJson(candidate.sourceEvidence as unknown as CanonicalJsonObject)
  ) {
    throw new ResourceUpdateError("STAGED_CANDIDATE_CHANGED", "staged candidate evidence changed");
  }
  return loaded.value;
}

async function readStageFile(
  env: Env,
  storeRoot: string,
  path: string,
): Promise<{ readonly value: ResourceUpdateStageFile; readonly serializedDigest: string }> {
  const expectedRoot = join(storeRoot, "resource-update-staging");
  if (
    dirname(normalize(path)) !== normalize(expectedRoot) ||
    !/^[0-9a-f]{64}\.json$/.test(basename(path))
  ) {
    throw new TypeError("resource update stage path is invalid");
  }
  const snapshot = await captureAnchoredSafeRecursiveSource(env, expectedRoot, path);
  if (snapshot?.kind !== "file" || snapshot.files.length !== 1) {
    throw new TypeError("resource update stage is unavailable");
  }
  const serialized = snapshot.files[0]?.content ?? "";
  const value = parseStageFile(JSON.parse(serialized));
  return { value, serializedDigest: sha256(serialized) };
}

function parseStageFile(value: unknown): ResourceUpdateStageFile {
  if (
    !hasExactKeys(value, [
      "content",
      "currentContentFingerprint",
      "currentRevisionId",
      "currentSourceEvidence",
      "diff",
      "kind",
      "name",
      "resourceId",
      "schemaVersion",
      "sourceEvidence",
      "stagedBytes",
      "stagedContentDigest",
      "validation",
    ])
  ) {
    throw new TypeError("resource update stage is invalid");
  }
  const sourceEvidence = remoteEvidence(value.sourceEvidence);
  const currentSourceEvidence = resourceSourceDescriptorSchema.parse(value.currentSourceEvidence);
  const resource = createResourceRecord({
    resourceId: String(value.resourceId),
    kind: value.kind as ArtifactKind,
    name: String(value.name),
    contentFingerprint: String(value.currentContentFingerprint),
    validation: {
      status: "backfilled",
      checkedAt: "2026-01-01T00:00:00.000Z",
      checks: ["content-fingerprint"],
    },
    source: currentSourceEvidence,
  });
  if (
    value.schemaVersion !== STAGE_SCHEMA_VERSION ||
    resource.currentRevision.id !== value.currentRevisionId ||
    !isRecord(value.content) ||
    !Array.isArray(value.content.nodes) ||
    !isRecord(value.validation) ||
    !isRecord(value.diff)
  ) {
    throw new TypeError("resource update stage is invalid");
  }
  const content = value.content as unknown as EncodedCandidateContent;
  validateEncodedContent(content);
  if (content.digest !== value.stagedContentDigest || content.byteLength !== value.stagedBytes) {
    throw new TypeError("resource update stage content binding is invalid");
  }
  const validation = value.validation as unknown as ResourceValidationEvidence;
  const checked = createResourceRecord({
    resourceId: resource.resourceId,
    kind: resource.kind,
    name: resource.name,
    contentFingerprint: content.fingerprint,
    validation,
    source: sourceEvidence,
  });
  void checked;
  validateResourceUpdateDiff(value.diff, resource.resourceId);
  return value as unknown as ResourceUpdateStageFile;
}

function validateResourceUpdateDiff(value: unknown, resourceId: string): void {
  if (
    !hasExactKeys(value, ["files", "redacted", "resourceId", "type"]) ||
    value.type !== "resource-content" ||
    value.resourceId !== resourceId ||
    value.redacted !== true ||
    !Array.isArray(value.files)
  ) {
    throw new TypeError("resource update diff is invalid");
  }
  let previousPath: string | undefined;
  for (const file of value.files) {
    if (!isRecord(file) || typeof file.path !== "string") {
      throw new TypeError("resource update diff is invalid");
    }
    assertCandidatePath(file.path);
    const expectedKeys =
      file.change === "added"
        ? ["afterFingerprint", "change", "path"]
        : file.change === "removed"
          ? ["beforeFingerprint", "change", "path"]
          : file.change === "modified"
            ? ["afterFingerprint", "beforeFingerprint", "change", "path"]
            : [];
    if (
      expectedKeys.length === 0 ||
      !hasExactKeys(file, expectedKeys) ||
      ("beforeFingerprint" in file && !isSha256(file.beforeFingerprint)) ||
      ("afterFingerprint" in file && !isSha256(file.afterFingerprint)) ||
      (previousPath !== undefined && previousPath >= file.path)
    ) {
      throw new TypeError("resource update diff is invalid");
    }
    previousPath = file.path;
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function candidateAction(
  stage: ResourceUpdateStageFile,
  target: string,
): PreparedStoreMutationAction {
  return {
    actionId: sha256(
      JSON.stringify({
        mutationKind: UPDATE_MUTATION_KIND,
        kind: "install-resource-revision",
        target,
        digest: stage.content.digest,
      }),
    ),
    kind: "install-resource-revision",
    target,
    payload: {
      resourceId: stage.resourceId,
      contentDigest: stage.content.digest,
      contentFingerprint: stage.content.fingerprint,
      content: stage.content as unknown as CanonicalJsonObject,
    },
    postcondition: { state: "present", fingerprint: stage.content.fingerprint },
    execute: async () => undefined,
  };
}

function metadataMutationAction(target: string, data: string): PreparedStoreMutationAction {
  return {
    actionId: sha256(
      JSON.stringify({
        mutationKind: UPDATE_MUTATION_KIND,
        kind: "publish-resource-metadata",
        target,
        digest: sha256(data),
      }),
    ),
    kind: "publish-resource-metadata",
    target,
    payload: { data, digest: sha256(data), mode: 0o600, path: target },
    postcondition: { state: "present", fingerprint: sha256(data) },
    execute: async () => undefined,
  };
}

interface DecodedResourceUpdate {
  readonly stage: ResourceUpdateStageFile;
  readonly stagePath: string;
  readonly stageFileDigest: string;
  readonly metadataData: string;
  readonly resource: ResourceRecord;
}

function decodeResourceUpdatePlan(plan: MutationPlan, storeRoot: string): DecodedResourceUpdate {
  const input = plan.normalizedInputs;
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
    !hasExactKeys(input, expectedKeys) ||
    input.mutationKind !== UPDATE_MUTATION_KIND ||
    input.desiredStateEffect !== "diverged-until-distributed" ||
    !Array.isArray(input.changedFields) ||
    canonicalJson(input.changedFields) !== canonicalJson(["currentRevision"]) ||
    typeof input.stagePath !== "string" ||
    typeof input.stageFileDigest !== "string" ||
    typeof input.stagedContentDigest !== "string" ||
    typeof input.stagedBytes !== "number"
  ) {
    throw new TypeError("resource update plan normalized inputs are invalid");
  }
  const contentAction = plan.actions[0];
  const metadataAction = plan.actions[1];
  if (
    plan.actions.length !== 2 ||
    !contentAction ||
    !metadataAction ||
    contentAction.kind !== "install-resource-revision" ||
    metadataAction.kind !== "publish-resource-metadata" ||
    !hasExactKeys(contentAction.payload, [
      "content",
      "contentDigest",
      "contentFingerprint",
      "resourceId",
    ]) ||
    !hasExactKeys(metadataAction.payload, ["data", "digest", "mode", "path"]) ||
    typeof metadataAction.payload.data !== "string"
  ) {
    throw new TypeError("resource update actions are invalid");
  }
  const content = contentAction.payload.content as unknown as EncodedCandidateContent;
  validateEncodedContent(content);
  const resource = parseResourceRecord(JSON.parse(metadataAction.payload.data));
  const stage = parseStageFile({
    schemaVersion: STAGE_SCHEMA_VERSION,
    resourceId: input.resourceId,
    kind: input.kind,
    name: input.name,
    currentRevisionId: input.currentRevisionId,
    currentContentFingerprint: input.currentContentFingerprint,
    currentSourceEvidence: input.currentSourceEvidence,
    sourceEvidence: input.sourceEvidence,
    content,
    stagedContentDigest: input.stagedContentDigest,
    stagedBytes: input.stagedBytes,
    validation: resource.currentRevision.validation,
    diff: input.redactedDiff,
  });
  const expectedRevisionPath = resourceRevisionContentPath(
    storeRoot,
    resource.resourceId,
    resource.currentRevision.contentFingerprint,
  );
  const expectedMetadataPath = resourceMetadataPath(storeRoot, resource.kind, resource.name);
  const provenance = decodeStoreProvenance(plan);
  const baseContentPath = join(
    storeRoot,
    "store",
    resource.kind,
    resource.kind === "rules"
      ? `${resource.name}.md`
      : resource.kind === "mcp"
        ? `${resource.name}.json`
        : resource.name,
  );
  const priorRevisionPath = resourceRevisionContentPath(
    storeRoot,
    resource.resourceId,
    stage.currentContentFingerprint,
  );
  const provenancePaths = provenance?.map((entry) => entry.path) ?? [];
  const expectedFixedPaths = [input.stagePath, expectedMetadataPath];
  const currentPaths = provenancePaths.filter((path) => !expectedFixedPaths.includes(path));
  const expectedContentAction = candidateAction(stage, expectedRevisionPath);
  const expectedMetadataAction = metadataMutationAction(
    expectedMetadataPath,
    metadataAction.payload.data,
  );
  if (
    canonicalJson(contentAction as unknown as CanonicalJsonObject) !==
      canonicalJson(stripExecute(expectedContentAction) as unknown as CanonicalJsonObject) ||
    canonicalJson(metadataAction as unknown as CanonicalJsonObject) !==
      canonicalJson(stripExecute(expectedMetadataAction) as unknown as CanonicalJsonObject) ||
    !provenance ||
    provenancePaths.length !== 3 ||
    !expectedFixedPaths.every((path) => provenancePaths.includes(path)) ||
    currentPaths.length !== 1 ||
    ![baseContentPath, priorRevisionPath].includes(currentPaths[0] ?? "") ||
    resource.resourceId !== input.resourceId ||
    resource.kind !== input.kind ||
    resource.name !== input.name ||
    resource.currentRevision.source.type !== stage.sourceEvidence.type ||
    canonicalJson(resource.currentRevision.source as unknown as CanonicalJsonObject) !==
      canonicalJson(stage.sourceEvidence as unknown as CanonicalJsonObject)
  ) {
    throw new TypeError("resource update plan is not bound to its candidate");
  }
  return {
    stage,
    stagePath: input.stagePath,
    stageFileDigest: input.stageFileDigest,
    metadataData: metadataAction.payload.data,
    resource,
  };
}

function stripExecute(action: PreparedStoreMutationAction) {
  const { execute: _execute, ...signed } = action;
  return signed;
}

async function installCandidateContent(
  env: Env,
  content: EncodedCandidateContent,
  target: string,
): Promise<void> {
  if (content.kind === "file") {
    const root = content.nodes.find((node) => node.path === "");
    if (!root?.dataHex) throw new TypeError("candidate file bytes are missing");
    await env.fs.mkdir(dirname(target), { recursive: true });
    await env.fs.publishFileAtomically(target, decodeUtf8(root.dataHex), { mode: root.mode });
    return;
  }
  const tree: FileTreeSnapshot = {
    rootPath: target,
    nodes: content.nodes.map((node) => ({
      relativePath: node.path,
      kind: node.kind,
      mode: node.mode,
      identity: `staged:${node.path}:${node.digest ?? "directory"}`,
      ...(node.dataHex ? { data: hexToBytes(node.dataHex) } : {}),
    })),
  };
  const snapshot: SafeRecursiveSnapshot = {
    rootPath: target,
    kind: "directory",
    files: content.nodes.flatMap((node) =>
      node.kind === "file" && node.dataHex
        ? [
            {
              absolutePath: join(target, ...node.path.split("/")),
              relativePath: node.path,
              mode: node.mode,
              data: hexToBytes(node.dataHex),
              content: decodeUtf8(node.dataHex),
            },
          ]
        : [],
    ),
    directories: content.nodes.flatMap((node) =>
      node.kind === "directory" ? [{ relativePath: node.path, mode: node.mode }] : [],
    ),
    fingerprint: content.fingerprint,
    identity: sha256(content.digest),
    tree,
  };
  await installSafeRecursiveSnapshot(env, snapshot, target, false);
}

function controlledIoCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" &&
    [
      "EACCES",
      "EDQUOT",
      "EFBIG",
      "EIO",
      "ENOSPC",
      "EPERM",
      "EROFS",
      "ESTALE",
      "ACTION_POSTCONDITION_FAILED",
    ].includes(code)
    ? code
    : null;
}

function sameTargetReceipt(
  before: OperationActionReceipt["before"],
  after: OperationActionReceipt["after"],
): boolean {
  return (
    before.state === after.state &&
    (before.state === "absent" ||
      (after.state === "present" && before.fingerprint === after.fingerprint))
  );
}

function invalidApplied(plan: MutationPlan): AppliedResourceUpdate {
  return {
    plan,
    resource: null,
    operation: invalidPlanResult(),
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/.test(value)) {
    throw new TypeError("candidate bytes are invalid");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function decodeUtf8(dataHex: string): string {
  const bytes = hexToBytes(dataHex);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const roundTrip = new TextEncoder().encode(text);
  if (bytesToHex(roundTrip) !== dataHex) throw new TypeError("candidate is not canonical UTF-8");
  return text;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
