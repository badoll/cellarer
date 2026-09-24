import { basename, join, resolve } from "node:path";
import type { AgentAdapter } from "../adapters/types.js";
import type { Env } from "../env.js";
import { lstatOrNull } from "../fs/probe.js";
import { isWithinRoot } from "../fs/safety.js";
import { serverToRaw } from "../mcp/model.js";
import { canonicalJson } from "../protocol/canonical.js";
import type { InventoryFindingCode } from "../protocol/client-types.js";
import { scanStructuredFileSecretFindings, scanTextForSecrets } from "../secrets/detector.js";
import {
  assertFinalSerializedSecretBytes,
  FinalSecretByteGuardError,
} from "../secrets/final-bytes.js";
import {
  captureAnchoredSafeRecursiveSource,
  captureSafeRecursiveSource,
  type SafeRecursiveSnapshot,
  sliceSafeRecursiveSnapshot,
  UnsafeRecursiveSourceError,
} from "../secrets/safe-tree.js";
import { parseSkillManifest } from "../skills/manifest.js";
import { sha256 } from "../store/checksum.js";
import { inventorySecretAdoptionOffers } from "./adoption-fields.js";
import type { InventorySource } from "./enumerator.js";
import { captureInventorySkillChild, type SkillTargetCaptureCache } from "./linked-skills.js";
import type {
  CapturedInventoryCandidateObservation,
  CapturedInventoryPublication,
  CapturedInventorySourceInspection,
  InventoryCandidateObservation,
  InventorySourceFinding,
  InventorySourceInspection,
} from "./types.js";

const DEFAULT_SKILL_LIMITS = { maxDepth: 16, maxEntries: 10000, maxBytes: 16 * 1024 * 1024 };

export async function inspectInventorySource(
  env: Env,
  source: InventorySource,
  adapter: AgentAdapter,
): Promise<InventorySourceInspection> {
  const captured = await inspectInventorySourceCaptured(env, source, adapter);
  return frozenInspection(captured.candidates.map(stripCapturedPublication), captured.findings);
}

export async function inspectInventorySourceCaptured(
  env: Env,
  source: InventorySource,
  adapter: AgentAdapter,
  skillCaptureCache?: SkillTargetCaptureCache,
): Promise<CapturedInventorySourceInspection> {
  if ((await lstatOrNull(env, source.path)) === null) return frozenInspection([], []);

  if (source.kind === "skills") return inspectSkillSource(env, source, skillCaptureCache);

  let snapshot: SafeRecursiveSnapshot;
  try {
    const captured = source.boundaryRoot
      ? await captureAnchoredSafeRecursiveSource(
          env,
          source.boundaryRoot,
          source.path,
          source.discovery,
        )
      : await captureSafeRecursiveSource(env, source.path);
    if (!captured) return frozenInspection([], []);
    snapshot = captured;
  } catch (error) {
    return frozenInspection([], [{ code: snapshotFindingCode(error), source }]);
  }

  if (source.kind === "rules") return inspectRules(source, snapshot);
  return inspectMcp(source, snapshot, adapter);
}

async function inspectSkillSource(
  env: Env,
  source: InventorySource,
  skillCaptureCache?: SkillTargetCaptureCache,
): Promise<CapturedInventorySourceInspection> {
  const boundaryRoot = source.boundaryRoot ?? env.homedir();
  const limits = source.discovery ?? DEFAULT_SKILL_LIMITS;
  try {
    const root = await env.fs.lstat(source.path);
    if (
      !root.isDirectory() ||
      !isWithinRoot(boundaryRoot, source.path) ||
      (await env.fs.realpath(source.path)) !== resolve(env.cwd(), source.path)
    ) {
      throw new UnsafeRecursiveSourceError(source.path, "symbolic-link");
    }
    if (!env.fs.supportsSafeRecursiveSnapshots()) {
      throw new UnsafeRecursiveSourceError(source.path, "unsupported");
    }
    const names = (await env.fs.readdir(source.path)).sort((left, right) =>
      left.localeCompare(right),
    );
    if (names.length + 1 > limits.maxEntries) {
      throw new UnsafeRecursiveSourceError(source.path, "budget-exceeded");
    }
    const directEntries = await Promise.all(
      names.map(async (name) => ({ name, stat: await env.fs.lstat(join(source.path, name)) })),
    );
    if (directEntries.every(({ stat }) => !stat.isSymbolicLink())) {
      try {
        const whole = await captureAnchoredSafeRecursiveSource(
          env,
          boundaryRoot,
          source.path,
          limits,
        );
        if (whole?.kind === "directory") {
          return frozenInspection(
            directEntries
              .filter(({ stat }) => stat.isDirectory())
              .map(({ name }) =>
                inspectSkillCandidate(source, sliceSafeRecursiveSnapshot(whole, name), name),
              ),
            [],
          );
        }
      } catch {
        // A nested unsafe child must not hide independently readable siblings.
      }
    }
    const candidates: CapturedInventoryCandidateObservation[] = [];
    const findings: InventorySourceFinding[] = [];
    let entries = names.length + 1;
    let bytes = 0;
    for (const { name } of directEntries) {
      const path = join(source.path, name);
      try {
        const stat = await env.fs.lstat(path);
        if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
        if (limits.maxDepth < 1 || entries > limits.maxEntries || bytes > limits.maxBytes) {
          throw new UnsafeRecursiveSourceError(path, "budget-exceeded");
        }
        const childLimits = {
          maxDepth: limits.maxDepth - 1,
          maxEntries: limits.maxEntries - entries + 1,
          maxBytes: limits.maxBytes - bytes,
        };
        const captured = await captureInventorySkillChild(
          env,
          boundaryRoot,
          path,
          childLimits,
          undefined,
          skillCaptureCache,
        );
        entries += captured.snapshot.tree.nodes.length - 1;
        bytes += captured.snapshot.files.reduce((sum, file) => sum + file.data.byteLength, 0);
        candidates.push(
          inspectSkillCandidate(
            source,
            captured.snapshot,
            name,
            captured.linkText === undefined
              ? undefined
              : { text: captured.linkText, boundaryRoot, limits: childLimits },
          ),
        );
      } catch (error) {
        findings.push({ code: snapshotFindingCode(error), source });
      }
    }
    const currentNames = (await env.fs.readdir(source.path)).sort((left, right) =>
      left.localeCompare(right),
    );
    if (
      (await env.fs.realpath(source.path)) !== resolve(env.cwd(), source.path) ||
      JSON.stringify(currentNames) !== JSON.stringify(names)
    ) {
      throw new UnsafeRecursiveSourceError(source.path, "stale");
    }
    return frozenInspection(candidates, findings);
  } catch (error) {
    return frozenInspection([], [{ code: snapshotFindingCode(error), source }]);
  }
}

function inspectRules(
  source: InventorySource,
  snapshot: SafeRecursiveSnapshot,
): CapturedInventorySourceInspection {
  const name = removeKnownExtension(basename(source.path));
  if (snapshot.kind !== "file" || snapshot.files.length !== 1) {
    return frozenInspection(
      [observation(source, snapshot, name, ["INVALID_STRUCTURE"], rawPublication(snapshot))],
      [],
    );
  }
  const content = normalizeRuleContent(snapshot.files[0]?.content ?? "");
  if (content.trim().length === 0) return frozenInspection([], []);
  const findings: InventoryFindingCode[] =
    scanTextForSecrets(content).length > 0 ? ["PROBABLE_SECRET"] : [];
  return frozenInspection(
    [
      observation(
        source,
        snapshot,
        name,
        findings,
        filePublication(snapshot, content),
        undefined,
        sha256(content),
      ),
    ],
    [],
  );
}

function inspectMcp(
  source: InventorySource,
  snapshot: SafeRecursiveSnapshot,
  adapter: AgentAdapter,
): CapturedInventorySourceInspection {
  const fallbackName = removeKnownExtension(basename(source.path));
  if (snapshot.kind !== "file" || snapshot.files.length !== 1 || !adapter.mcp) {
    return frozenInspection(
      [
        observation(
          source,
          snapshot,
          fallbackName,
          ["INVALID_STRUCTURE"],
          rawPublication(snapshot),
        ),
      ],
      [],
    );
  }
  const content = snapshot.files[0]?.content ?? "";
  if (content.trim().length === 0) return frozenInspection([], []);
  const structured = scanStructuredFileSecretFindings(source.path, content);
  const adoptionAmbiguous = structured.some(
    (finding) => finding.rule === "duplicate-key" || finding.rule === "structured-parse-error",
  );
  const hasSecret =
    scanTextForSecrets(content).length > 0 ||
    structured.some((finding) => finding.rule !== "structured-parse-error");
  try {
    const decoded = adapter.mcp.codec.decode(content, adapter.mcp.serversKey);
    const candidates = Object.entries(decoded.servers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, server]) => {
        const secretAdoptions = adoptionAmbiguous
          ? []
          : inventorySecretAdoptionOffers(name, server);
        const canonical = canonicalJson(serverToRaw(server));
        const serialized = `${JSON.stringify(serverToRaw(server), null, 2)}\n`;
        return observation(
          source,
          snapshot,
          name,
          [
            ...(hasSecret ? (["PROBABLE_SECRET"] as const) : []),
            ...(secretAdoptions.length > 0 ? (["secret-adoption-required"] as const) : []),
          ],
          filePublication(snapshot, serialized),
          name,
          sha256(canonical),
          secretAdoptions,
        );
      });
    return frozenInspection(candidates, []);
  } catch {
    return frozenInspection(
      [observation(source, snapshot, fallbackName, ["PARSE_FAILED"], rawPublication(snapshot))],
      [],
    );
  }
}

function inspectSkillCandidate(
  source: InventorySource,
  snapshot: SafeRecursiveSnapshot,
  name: string,
  sourceLink?: CapturedInventoryCandidateObservation["sourceLink"],
): CapturedInventoryCandidateObservation {
  if (snapshot.kind !== "directory") {
    throw new UnsafeRecursiveSourceError(snapshot.rootPath, "non-regular");
  }
  const manifest = snapshot.files.find((file) => file.relativePath === "SKILL.md");
  let manifestValid = false;
  let resourceName = name;
  if (manifest) {
    try {
      resourceName = parseSkillManifest(manifest.content).name;
      manifestValid = true;
    } catch {
      /* Invalid candidates stay visible and cannot publish. */
    }
  }
  const hasSecret = snapshot.files.some(
    (file) =>
      scanTextForSecrets(file.content).length > 0 ||
      scanStructuredFileSecretFindings(file.relativePath, file.content).some(
        (finding) => finding.rule !== "structured-parse-error",
      ),
  );
  const findings: InventoryFindingCode[] = [
    ...(!manifestValid ? ([manifest ? "INVALID_MANIFEST" : "INVALID_STRUCTURE"] as const) : []),
    ...(hasSecret ? (["PROBABLE_SECRET"] as const) : []),
  ];
  return Object.freeze({
    ...observation(source, snapshot, resourceName, findings, directoryPublication(snapshot), name),
    ...(sourceLink ? { sourceLink } : {}),
  });
}

function observation(
  source: InventorySource,
  snapshot: SafeRecursiveSnapshot,
  name: string,
  findings: readonly InventoryFindingCode[],
  publication: CapturedInventoryPublication,
  relativePath?: string,
  contentFingerprint = snapshot.fingerprint,
  secretAdoptions: CapturedInventoryCandidateObservation["secretAdoptions"] = Object.freeze([]),
): CapturedInventoryCandidateObservation {
  return Object.freeze({
    kind: source.kind,
    name,
    normalizedName: normalizeInventoryName(name),
    contentFingerprint,
    physicalIdentity: snapshot.identity,
    source,
    snapshot,
    publication,
    ...(relativePath ? { relativePath } : {}),
    findings: Object.freeze(
      [
        ...new Set([...findings, ...publicationSafetyFindings(source.kind, name, publication)]),
      ].sort(),
    ),
    secretAdoptions: Object.freeze([...secretAdoptions]),
  });
}

function publicationSafetyFindings(
  kind: InventorySource["kind"],
  name: string,
  publication: CapturedInventoryPublication,
): readonly InventoryFindingCode[] {
  const files =
    publication.kind === "file"
      ? [{ path: kind === "mcp" ? `${name}.json` : name, data: publication.data }]
      : publication.nodes.flatMap((node) =>
          node.kind === "file"
            ? [
                {
                  path: node.path,
                  data:
                    node.encoding === "base64"
                      ? Buffer.from(node.data, "base64").toString("utf8")
                      : node.data,
                },
              ]
            : [],
        );
  const findings: InventoryFindingCode[] = [];
  for (const file of files) {
    try {
      assertFinalSerializedSecretBytes(file.data, [], file.path);
    } catch (error) {
      if (!(error instanceof FinalSecretByteGuardError)) throw error;
      const structured = scanStructuredFileSecretFindings(file.path, file.data);
      findings.push(
        structured.some(({ rule }) => rule === "duplicate-key" || rule === "structured-parse-error")
          ? "PARSE_FAILED"
          : "PROBABLE_SECRET",
      );
    }
  }
  return findings;
}

function frozenInspection<Candidate extends InventoryCandidateObservation>(
  candidates: readonly Candidate[],
  findings: readonly InventorySourceFinding[],
): {
  readonly candidates: readonly Candidate[];
  readonly findings: readonly InventorySourceFinding[];
} {
  return Object.freeze({
    candidates: Object.freeze([...candidates]),
    findings: Object.freeze([...findings]),
  });
}

function stripCapturedPublication(
  candidate: CapturedInventoryCandidateObservation,
): InventoryCandidateObservation {
  const {
    snapshot: _snapshot,
    publication: _publication,
    sourceLink: _sourceLink,
    ...observation
  } = candidate;
  return Object.freeze(observation);
}

function filePublication(
  snapshot: SafeRecursiveSnapshot,
  data: string,
): CapturedInventoryPublication {
  const file = snapshot.files[0];
  if (!file) throw new UnsafeRecursiveSourceError(snapshot.rootPath, "non-regular");
  return Object.freeze({
    kind: "file",
    data,
    mode: file.mode,
    fingerprint: sha256(data),
  });
}

function directoryPublication(snapshot: SafeRecursiveSnapshot): CapturedInventoryPublication {
  return Object.freeze({
    kind: "directory",
    nodes: Object.freeze(
      snapshot.tree.nodes.map((node) =>
        node.kind === "directory"
          ? Object.freeze({ path: node.relativePath, kind: "directory" as const, mode: node.mode })
          : Object.freeze({
              path: node.relativePath,
              kind: "file" as const,
              mode: node.mode,
              ...publicationFileData(node.data ?? new Uint8Array()),
              digest: sha256(node.data ?? new Uint8Array()),
            }),
      ),
    ),
    fingerprint: snapshot.fingerprint,
  });
}

function publicationFileData(data: Uint8Array): { data: string; encoding?: "base64" } {
  try {
    return { data: new TextDecoder("utf-8", { fatal: true }).decode(data) };
  } catch {
    return { data: Buffer.from(data).toString("base64"), encoding: "base64" };
  }
}

function rawPublication(snapshot: SafeRecursiveSnapshot): CapturedInventoryPublication {
  return snapshot.kind === "file"
    ? filePublication(snapshot, snapshot.files[0]?.content ?? "")
    : directoryPublication(snapshot);
}

function snapshotFindingCode(error: unknown): InventoryFindingCode {
  if (!(error instanceof UnsafeRecursiveSourceError)) return "SOURCE_UNREADABLE";
  if (error.reason === "budget-exceeded") return "SOURCE_BUDGET_EXCEEDED";
  if (error.reason === "symbolic-link") return "UNSAFE_LINK";
  if (error.reason === "unsupported") return "UNSUPPORTED_SNAPSHOT";
  if (error.reason === "stale") return "SNAPSHOT_STALE";
  return "SOURCE_UNREADABLE";
}

function removeKnownExtension(name: string): string {
  return name.replace(/\.(?:json|jsonc|toml|yaml|yml|md|mdc)$/i, "");
}

export function normalizeInventoryName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeRuleContent(content: string): string {
  const normalized = content.replace(/\r\n?/g, "\n").trimEnd();
  return normalized.length > 0 ? `${normalized}\n` : "";
}
