import { join } from "node:path";
import { z } from "zod";
import type { Env } from "../env.js";
import type { Artifact, ArtifactKind } from "../model/index.js";
import { scanTextForSecrets } from "../secrets/detector.js";
import { captureAnchoredSafeRecursiveSource } from "../secrets/safe-tree.js";
import { sha256 } from "../store/checksum.js";

export const RESOURCE_MODEL_SCHEMA_VERSION = 1 as const;

const fingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const resourceNameSchema = z
  .string()
  .min(1)
  .refine(
    (name) => /^[A-Za-z0-9._-]+$/.test(name) && name !== "." && name !== "..",
    "unsafe resource name",
  );
const resourceIdSchema = z
  .string()
  .regex(/^(rules|mcp|skills)\/[A-Za-z0-9._-]+$/)
  .refine((value) => !value.endsWith("/.") && !value.endsWith("/.."), "unsafe resource ID");
const httpUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => value.startsWith("https://") || value.startsWith("http://"),
    "HTTP(S) URL required",
  )
  .refine((value) => {
    const parsed = new URL(value);
    return parsed.username.length === 0 && parsed.password.length === 0;
  }, "source URL credentials are forbidden")
  .refine(
    (value) => scanTextForSecrets(value).length === 0,
    "source URL contains secret-like content",
  );
const gitCommitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i);

const localSnapshotSourceSchema = z
  .object({
    type: z.literal("local-snapshot"),
    capturedFrom: z
      .string()
      .min(1)
      .refine(
        (value) => scanTextForSecrets(value).length === 0,
        "snapshot source contains secret-like content",
      )
      .optional(),
  })
  .strict();

const gitSourceSchema = z
  .object({
    type: z.literal("git"),
    repositoryUrl: httpUrlSchema,
    ref: z.string().min(1),
    commit: gitCommitSchema,
    subpath: z.string().min(1),
  })
  .strict();

const urlSourceSchema = z
  .object({
    type: z.literal("url"),
    url: httpUrlSchema,
    integrity: fingerprintSchema,
    validators: z
      .object({
        etag: z
          .string()
          .min(1)
          .refine((value) => !/[\r\n]/.test(value))
          .optional(),
        lastModified: z
          .string()
          .min(1)
          .refine((value) => !/[\r\n]/.test(value))
          .optional(),
      })
      .strict()
      .refine((value) => value.etag !== undefined || value.lastModified !== undefined)
      .optional(),
  })
  .strict();

export const resourceSourceDescriptorSchema = z.discriminatedUnion("type", [
  localSnapshotSourceSchema,
  gitSourceSchema,
  urlSourceSchema,
]);

export type ResourceSourceDescriptor = z.infer<typeof resourceSourceDescriptorSchema>;

export const resourceValidationCheckSchema = z.enum([
  "content-fingerprint",
  "manifest",
  "adapter-compatibility",
  "secret-scan",
]);

export type ResourceValidationCheck = z.infer<typeof resourceValidationCheckSchema>;

export const resourceValidationEvidenceSchema = z
  .object({
    status: z.enum(["validated", "backfilled"]),
    checkedAt: z.string().datetime({ offset: true }),
    checks: z.array(resourceValidationCheckSchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.checks).size !== value.checks.length) {
      ctx.addIssue({
        code: "custom",
        message: "validation checks must be unique",
        path: ["checks"],
      });
    }
    if (!value.checks.includes("content-fingerprint")) {
      ctx.addIssue({
        code: "custom",
        message: "validation evidence must include content-fingerprint",
        path: ["checks"],
      });
    }
  });

export type ResourceValidationEvidence = z.infer<typeof resourceValidationEvidenceSchema>;

export const resourceRevisionSchema = z
  .object({
    id: fingerprintSchema,
    contentFingerprint: fingerprintSchema,
    validation: resourceValidationEvidenceSchema,
    source: resourceSourceDescriptorSchema,
  })
  .strict();

export type ResourceRevision = z.infer<typeof resourceRevisionSchema>;

export const resourceRecordSchema = z
  .object({
    schemaVersion: z.literal(RESOURCE_MODEL_SCHEMA_VERSION),
    resourceId: resourceIdSchema,
    kind: z.enum(["rules", "mcp", "skills"]),
    name: resourceNameSchema,
    currentRevision: resourceRevisionSchema,
  })
  .strict();

export type ResourceRecord = z.infer<typeof resourceRecordSchema>;

export interface CreateResourceRecordInput {
  readonly resourceId: string;
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly contentFingerprint: string;
  readonly validation: ResourceValidationEvidence;
  readonly source: ResourceSourceDescriptor;
}

export class InvalidResourceMetadataError extends Error {
  readonly code = "INVALID_RESOURCE_METADATA" as const;

  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`invalid resource metadata at ${path}: ${reason}`);
    this.name = "InvalidResourceMetadataError";
  }
}

export function createResourceRecord(input: CreateResourceRecordInput): ResourceRecord {
  const source = resourceSourceDescriptorSchema.parse(input.source);
  const validation = resourceValidationEvidenceSchema.parse(input.validation);
  return resourceRecordSchema.parse({
    schemaVersion: RESOURCE_MODEL_SCHEMA_VERSION,
    resourceId: input.resourceId,
    kind: input.kind,
    name: input.name,
    currentRevision: {
      id: resourceRevisionId(input.contentFingerprint, source),
      contentFingerprint: input.contentFingerprint,
      validation,
      source,
    },
  });
}

export function parseResourceRecord(value: unknown): ResourceRecord {
  const record = resourceRecordSchema.parse(value);
  const expectedRevision = resourceRevisionId(
    record.currentRevision.contentFingerprint,
    record.currentRevision.source,
  );
  if (record.currentRevision.id !== expectedRevision) {
    throw new TypeError("resource revision ID does not match its immutable evidence");
  }
  return record;
}

export function resourceSourceCanCheckForUpdates(source: unknown): boolean {
  const parsed = resourceSourceDescriptorSchema.safeParse(source);
  return parsed.success && (parsed.data.type === "git" || parsed.data.type === "url");
}

export function resourceMetadataPath(storeRoot: string, kind: ArtifactKind, name: string): string {
  resourceNameSchema.parse(name);
  return join(storeRoot, "store", "metadata", kind, `${name}.json`);
}

export function resourceRevisionContentPath(
  storeRoot: string,
  resourceId: string,
  contentFingerprint: string,
): string {
  const parsedId = resourceIdSchema.parse(resourceId);
  const fingerprint = fingerprintSchema.parse(contentFingerprint).slice("sha256:".length);
  const [kind, identity] = parsedId.split("/") as [ArtifactKind, string];
  const revisionRoot = join(storeRoot, "store", kind, ".cellarer-revisions", identity, fingerprint);
  return kind === "skills"
    ? join(revisionRoot, "content")
    : join(revisionRoot, kind === "rules" ? "content.md" : "content.json");
}

export async function resolveCurrentResourceArtifact(
  env: Env,
  storeRoot: string,
  artifact: Artifact,
): Promise<{ readonly artifact: Artifact; readonly record: ResourceRecord }> {
  const metadataPath = resourceMetadataPath(storeRoot, artifact.kind, artifact.name);
  const metadata = await captureAnchoredSafeRecursiveSource(env, storeRoot, metadataPath);
  if (metadata?.kind === "file" && metadata.files.length === 1) {
    const raw = metadata.files[0]?.content ?? "";
    if (scanTextForSecrets(raw).length > 0) {
      throw new InvalidResourceMetadataError(metadataPath, "plaintext secret-like content");
    }
    try {
      const value = JSON.parse(raw) as unknown;
      if (isVersionedResourceRecord(value)) {
        const parsed = parseResourceRecord(value);
        if (parsed.kind !== artifact.kind || parsed.name !== artifact.name) {
          throw new TypeError("identity does not match managed content");
        }
        const revisionPath = resourceRevisionContentPath(
          storeRoot,
          parsed.resourceId,
          parsed.currentRevision.contentFingerprint,
        );
        const revision = await captureAnchoredSafeRecursiveSource(env, storeRoot, revisionPath);
        const current = revision ? { ...artifact, sourcePath: revisionPath } : artifact;
        return { artifact: current, record: await loadResourceRecord(env, storeRoot, current) };
      }
    } catch (error) {
      throw new InvalidResourceMetadataError(metadataPath, errorMessage(error));
    }
  }
  return { artifact, record: await loadResourceRecord(env, storeRoot, artifact) };
}

export async function loadResourceRecord(
  env: Env,
  storeRoot: string,
  artifact: Artifact,
): Promise<ResourceRecord> {
  const artifactSnapshot = await captureAnchoredSafeRecursiveSource(
    env,
    storeRoot,
    artifact.sourcePath,
  );
  if (!artifactSnapshot) {
    throw new InvalidResourceMetadataError(artifact.sourcePath, "managed content is missing");
  }

  const metadataPath = resourceMetadataPath(storeRoot, artifact.kind, artifact.name);
  const metadataSnapshot = await captureAnchoredSafeRecursiveSource(env, storeRoot, metadataPath);
  if (!metadataSnapshot) {
    return backfilledRecord(env, artifact, artifactSnapshot.fingerprint, {
      type: "local-snapshot",
    });
  }
  if (metadataSnapshot.kind !== "file" || metadataSnapshot.files.length !== 1) {
    throw new InvalidResourceMetadataError(metadataPath, "metadata must be one regular file");
  }
  const raw = metadataSnapshot.files[0]?.content ?? "";
  if (scanTextForSecrets(raw).length > 0) {
    throw new InvalidResourceMetadataError(metadataPath, "plaintext secret-like content");
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new InvalidResourceMetadataError(metadataPath, "invalid JSON");
  }

  if (isVersionedResourceRecord(value)) {
    let record: ResourceRecord;
    try {
      record = parseResourceRecord(value);
    } catch (error) {
      throw new InvalidResourceMetadataError(metadataPath, errorMessage(error));
    }
    if (record.kind !== artifact.kind || record.name !== artifact.name) {
      throw new InvalidResourceMetadataError(
        metadataPath,
        "identity does not match managed content",
      );
    }
    if (record.currentRevision.contentFingerprint !== artifactSnapshot.fingerprint) {
      throw new InvalidResourceMetadataError(metadataPath, "content fingerprint does not match");
    }
    return record;
  }

  if (artifact.kind !== "skills") {
    throw new InvalidResourceMetadataError(metadataPath, "unversioned metadata is unsupported");
  }
  let legacy: LegacySkillProvenance;
  try {
    legacy = legacySkillProvenanceSchema.parse(value);
  } catch (error) {
    throw new InvalidResourceMetadataError(
      metadataPath,
      `invalid legacy provenance: ${errorMessage(error)}`,
    );
  }
  if (legacy.name !== artifact.name || legacy.kind !== artifact.kind) {
    throw new InvalidResourceMetadataError(
      metadataPath,
      "legacy identity does not match managed content",
    );
  }
  return backfilledRecord(
    env,
    artifact,
    artifactSnapshot.fingerprint,
    provableLegacySource(legacy),
  );
}

function resourceRevisionId(contentFingerprint: string, source: ResourceSourceDescriptor): string {
  fingerprintSchema.parse(contentFingerprint);
  return sha256(JSON.stringify({ contentFingerprint, source }));
}

function backfilledRecord(
  env: Env,
  artifact: Artifact,
  contentFingerprint: string,
  source: ResourceSourceDescriptor,
): ResourceRecord {
  return createResourceRecord({
    resourceId: artifact.id,
    kind: artifact.kind,
    name: artifact.name,
    contentFingerprint,
    validation: {
      status: "backfilled",
      checkedAt: env.now().toISOString(),
      checks: ["content-fingerprint"],
    },
    source,
  });
}

function isVersionedResourceRecord(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.hasOwn(value, "schemaVersion");
}

const legacySkillFrontmatterSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    metadata: z.object({ internal: z.boolean().optional() }).strict().optional(),
  })
  .strict();

const legacySkillProvenanceSchema = z
  .object({
    kind: z.literal("skills"),
    name: resourceNameSchema,
    source: z.string().min(1),
    resolvedUrl: z.string().min(1),
    vcs: z.enum(["git", "local"]),
    ref: z.string().min(1).nullable(),
    commit: z.string().min(1).nullable(),
    subpath: z.string().min(1),
    collection: z.string().min(1).nullable(),
    importedAt: z.string().datetime({ offset: true }),
    frontmatter: legacySkillFrontmatterSchema.nullable(),
    internal: z.boolean(),
    warnings: z.array(z.string()),
  })
  .strict();

type LegacySkillProvenance = z.infer<typeof legacySkillProvenanceSchema>;

function provableLegacySource(legacy: LegacySkillProvenance): ResourceSourceDescriptor {
  if (legacy.vcs === "git" && legacy.ref && legacy.commit) {
    const git = gitSourceSchema.safeParse({
      type: "git",
      repositoryUrl: legacy.resolvedUrl,
      ref: legacy.ref,
      commit: legacy.commit,
      subpath: legacy.subpath,
    });
    if (git.success) return git.data;
  }
  return legacy.vcs === "local"
    ? { type: "local-snapshot", capturedFrom: legacy.source }
    : { type: "local-snapshot" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
