// add:从本地或 GitHub source 导入制品到库房。rules/MCP 仍是本地文件导入;
// skills 走 source resolver -> discovery -> selection -> safety guard -> store/provenance。
import { basename, extname, join, relative } from "node:path";
import type { Env, MutationAuthorityLease } from "../env.js";
import { lstatOrNull, readdirOrEmpty, readFileOrNull, statOrNull } from "../fs/probe.js";
import { type McpServer, serverFromRaw, serverToRaw } from "../mcp/model.js";
import type { ArtifactKind } from "../model/index.js";
import { withCurrentMutationAuthorityLease } from "../protocol/canonical.js";
import type { CanonicalJsonObject, OperationResult } from "../protocol/models.js";
import {
  executeStoreActionMutation,
  type PreparedStoreMutationAction,
} from "../protocol/store-mutation.js";
import {
  createResourceRecord,
  type ResourceRecord,
  type ResourceSourceDescriptor,
  resourceSourceDescriptorSchema,
} from "../resources/model.js";
import {
  attachProviderScope,
  containsKnownSecretValue,
  createProviderScope,
  type ProviderScope,
  withProviderScope,
} from "../secrets/active-values.js";
import {
  detectSecret,
  scanStructuredFileSecretFindings,
  scanTextForSecrets,
} from "../secrets/detector.js";
import {
  discoverActiveSecretValues,
  inventoryActiveSecretValues,
} from "../secrets/provider-runtime.js";
import { activeSecretPublicationGuard } from "../secrets/publication-guard.js";
import {
  assertSafeRecursiveSnapshotCurrent,
  captureSafeRecursiveSource,
  installSafeRecursiveSnapshot,
  type SafeRecursiveSnapshot,
  UnsafeRecursiveSourceError,
} from "../secrets/safe-tree.js";
import { parseSkillManifest } from "../skills/manifest.js";
import { sha256 } from "../store/checksum.js";
import { type CellarerConfig, CONFIG_FILENAME, loadConfig } from "../store/config.js";
import {
  isSafeArtifactName,
  listMcpArtifacts,
  listRuleArtifacts,
  listSkillArtifacts,
  skillProvenancePath,
  writeMcpArtifact,
  writeRuleArtifact,
  writeSkillProvenance,
} from "../store/store.js";

export interface GitHubSource {
  source: string;
  owner: string;
  repo: string;
  cloneUrl: string;
  resolvedUrl: string;
  ref: string | null;
  subpath: string | null;
}

export interface GitStageResult {
  path: string;
  resolvedUrl: string;
  ref: string | null;
  commit: string | null;
  subpath: string | null;
  cleanup?: () => Promise<void>;
}

export interface GitClient {
  stageGitHub(source: GitHubSource, ctx: { env: Env; storeRoot: string }): Promise<GitStageResult>;
}

export interface AddOptions {
  storeRoot: string;
  source: string;
  // 同名制品已存在时:false(默认)跳过并告警;true 覆盖。
  force?: boolean;
  // 只列 skill candidates,不写 store。
  list?: boolean;
  // 重复 --skill 的值。与 --all 互斥。
  skills?: string[];
  all?: boolean;
  // 导入后写 config.artifacts collections;collection internal 也作为显式包含 internal skill 的策略信号。
  collection?: string;
  // M2 只保留命令面兼容;当前没有交互确认。
  yes?: boolean;
  gitClient?: GitClient;
  // Provider inputs are operation-scoped and never persisted in Store/protocol evidence.
  secretMode?: "env" | "vault" | "keychain";
  vaultPassphrase?: string;
  keychainService?: string;
}

export interface SkillCandidate {
  name: string;
  description: string;
  source: string;
  resolvedUrl: string;
  ref: string | null;
  commit: string | null;
  subpath: string;
  path: string;
  internal: boolean;
  warnings: string[];
  rejected: boolean;
  rejectionReason?: string;
  frontmatter: SkillFrontmatter | null;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  metadata?: { internal?: boolean };
}

export type SkillProvenance = ResourceRecord;

export interface AddResult {
  imported: { kind: ArtifactKind; name: string; path: string }[];
  skipped: { kind: ArtifactKind; name: string; reason: string }[];
  rejected: { kind: ArtifactKind; name: string; reason: string }[];
  candidates: SkillCandidate[];
  warnings: string[];
  operation?: OperationResult;
}

export type StructuredSkillRejectionResult =
  | { readonly kind: "allow" }
  | { readonly kind: "reject"; readonly displayText: string };

export function recordStructuredSkillRejection(
  result: AddResult,
  name: string,
  decision: StructuredSkillRejectionResult,
): void {
  switch (decision.kind) {
    case "allow":
      return;
    case "reject":
      result.rejected.push({ kind: "skills", name, reason: decision.displayText });
  }
}

interface PreparedAddAction extends PreparedStoreMutationAction {
  imported?: { kind: ArtifactKind; name: string; path: string };
}

interface PreparedAdd {
  result: AddResult;
  actions: PreparedAddAction[];
  policy: PreparedAddPolicy;
}

type PreparedAddPolicy =
  | { readonly kind: "allowed" }
  | { readonly kind: "structured-secret-guard" };

class StructuredAddGuardError extends Error {
  constructor() {
    super("structured import validation failed before protocol publication");
    this.name = "StructuredAddGuardError";
  }
}

function enforcePreparedAddPolicy(policy: PreparedAddPolicy): void {
  switch (policy.kind) {
    case "allowed":
      return;
    case "structured-secret-guard":
      throw new StructuredAddGuardError();
  }
}

interface SourceStage {
  path: string;
  source: string;
  resolvedUrl: string;
  vcs: "git" | "local";
  ref: string | null;
  commit: string | null;
  subpath: string | null;
  cleanup?: () => Promise<void>;
}

const SKILL_CONTAINERS = [
  "skills",
  "skills/.curated",
  "skills/.experimental",
  "skills/.system",
  ".agents/skills",
  ".claude/skills",
  ".aider-desk/skills",
  ".augment/skills",
  ".cursor/skills",
  ".codex/skills",
  ".continue/skills",
  ".gemini/skills",
  ".goose/skills",
  ".kiro/skills",
  ".qwen/skills",
  ".windsurf/skills",
];

// 按扩展名/目录推断制品类型:.md→rules;.json→mcp;目录→skills。
function inferKind(isDir: boolean, source: string): ArtifactKind {
  if (isDir) return "skills";
  const ext = extname(source).toLowerCase();
  if (ext === ".md") return "rules";
  if (ext === ".json") return "mcp";
  throw new Error(
    `unsupported source file type "${ext || "(none)"}" — supported: .md (rules), .json (mcp), directory (skills)`,
  );
}

// 制品名:取 basename 去扩展名。
function deriveName(source: string, isDir: boolean): string {
  return isDir ? basename(source) : basename(source, extname(source));
}

function emptyResult(): AddResult {
  return { imported: [], skipped: [], rejected: [], candidates: [], warnings: [] };
}

// 已存在同名制品?(dedup 判定,列库房制品比对 name)
async function nameExists(
  env: Env,
  storeRoot: string,
  kind: ArtifactKind,
  name: string,
): Promise<boolean> {
  const list =
    kind === "rules"
      ? await listRuleArtifacts(env, storeRoot)
      : kind === "mcp"
        ? await listMcpArtifacts(env, storeRoot)
        : await listSkillArtifacts(env, storeRoot);
  return list.some((a) => a.name === name);
}

async function safeSourceSnapshot(env: Env, source: string): Promise<SafeRecursiveSnapshot> {
  return captureSafeRecursiveSource(env, source);
}

async function structuredLocalFileRejection(
  env: Env,
  kind: ArtifactKind,
  name: string,
  source: string,
): Promise<AddResult | null> {
  if (kind !== "mcp") return null;
  const snapshot = await safeSourceSnapshot(env, source);
  if (snapshot.kind !== "file" || snapshot.files.length !== 1) return null;
  const findings = scanStructuredFileSecretFindings(source, snapshot.files[0]?.content ?? "");
  if (findings.some((finding) => finding.rule === "structured-parse-error")) {
    throw new Error(`invalid mcp source ${source}: structured parse failed`);
  }
  if (findings.length === 0) return null;
  const result = emptyResult();
  result.rejected.push({
    kind,
    name,
    reason: `structured mcp field finding(s) [${[
      ...new Set(findings.map((finding) => finding.rule)),
    ].join(", ")}] — replace plaintext with a supported reference before importing`,
  });
  return result;
}

async function structuredSkillRejection(
  env: Env,
  candidate: SkillCandidate,
): Promise<StructuredSkillRejectionResult> {
  if (candidate.rejected) return { kind: "allow" };
  let snapshot: SafeRecursiveSnapshot;
  try {
    snapshot = await safeSourceSnapshot(env, candidate.path);
  } catch (error) {
    if (error instanceof UnsafeRecursiveSourceError) return { kind: "allow" };
    throw error;
  }
  if (snapshot.kind !== "directory") return { kind: "allow" };
  const findings = snapshot.files.flatMap((file) =>
    scanStructuredFileSecretFindings(file.relativePath, file.content),
  );
  if (findings.length === 0) return { kind: "allow" };
  return {
    kind: "reject",
    displayText: `structured sensitive-field finding(s) [${[
      ...new Set(findings.map((finding) => `${finding.source}:${finding.rule}`)),
    ].join(", ")}] — replace plaintext with a supported reference before importing`,
  };
}

// mcp 结构化密钥检测(名字启发 + 高熵,强于纯文本的 high-value 前缀扫描)。
function mcpSecretFields(server: McpServer): string[] {
  const hits: string[] = [];
  const walk = (value: unknown, path: string, leaf: string): void => {
    if (typeof value === "string") {
      if (detectSecret(value, leaf)) hits.push(path);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => {
        walk(v, `${path}[${i}]`, leaf);
      });
    } else if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, k);
    }
  };

  if (server.kind === "stdio") {
    walk(server.env, "env", "env");
    walk(server.args, "args", "args");
    walk(server.extra, "", "");
  } else if (server.kind === "remote") {
    if (detectSecret(server.url, "url")) hits.push("url");
    walk(server.headers, "headers", "headers");
    walk(server.extra, "", "");
  } else {
    walk(server.config, "", "");
  }
  return hits;
}

async function addLocalFile(
  env: Env,
  opts: AddOptions,
  kind: ArtifactKind,
  name: string,
  source: string,
  _isDir: boolean,
): Promise<PreparedAdd> {
  const result = emptyResult();
  if (opts.list || opts.all || (opts.skills && opts.skills.length > 0)) {
    throw new Error(
      "--list, --skill, and --all are only supported for skill directory or GitHub sources",
    );
  }

  if (!opts.force && (await nameExists(env, opts.storeRoot, kind, name))) {
    result.skipped.push({ kind, name, reason: "already exists (use --force to overwrite)" });
    return { result, actions: [], policy: { kind: "allowed" } };
  }

  const reject = (reason: string, policy: PreparedAddPolicy = { kind: "allowed" }): PreparedAdd => {
    result.rejected.push({ kind, name, reason });
    return { result, actions: [], policy };
  };

  let snapshot: SafeRecursiveSnapshot;
  try {
    snapshot = await safeSourceSnapshot(env, source);
  } catch (error) {
    if (!(error instanceof UnsafeRecursiveSourceError)) throw error;
    return reject(unsafeRecursiveReason(error));
  }
  if (snapshot.kind !== "file" || snapshot.files.length !== 1) {
    return reject(`unsafe recursive source (non-regular) at ${source}`);
  }
  const payloadText = snapshot.files[0]?.content ?? "";
  const textHits = scanTextForSecrets(payloadText);
  if (textHits.length > 0) {
    return reject(
      `plaintext secret(s) [${textHits.map((h) => h.rule).join(", ")}] — replace with \${ENV} or \${CELLARER_SECRET:name} before importing`,
    );
  }
  let action: PreparedAddAction;
  if (kind === "rules") {
    if (await containsActiveKnownValue(env, opts, payloadText)) {
      return reject(
        "known secret value is present beside an active reference — remove plaintext before importing",
      );
    }
    const path = join(opts.storeRoot, "store", "rules", `${name}.md`);
    action = {
      actionId: addActionId(kind, name, path),
      kind: "add-rules",
      target: path,
      payload: { contentDigest: sha256(payloadText) },
      postcondition: { state: "present", fingerprint: sha256(payloadText) },
      execute: async () => {
        await assertSafeRecursiveSnapshotCurrent(env, snapshot);
        await writeRuleArtifact(env, opts.storeRoot, name, payloadText);
      },
      imported: { kind, name, path },
    };
  } else if (kind === "mcp") {
    const structuredHits = scanStructuredFileSecretFindings(source, payloadText);
    if (structuredHits.some((finding) => finding.rule === "structured-parse-error")) {
      throw new Error(`invalid mcp source ${source}: structured parse failed`);
    }
    if (structuredHits.length > 0) {
      return reject(
        `structured mcp field finding(s) [${[
          ...new Set(structuredHits.map((finding) => finding.rule)),
        ].join(", ")}] — replace plaintext with a supported reference before importing`,
        { kind: "structured-secret-guard" },
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(payloadText);
    } catch (err) {
      throw new Error(
        `invalid mcp source ${source}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const server = serverFromRaw(raw);
    const fieldHits = mcpSecretFields(server);
    if (fieldHits.length > 0) {
      return reject(
        `plaintext secret in mcp field(s) [${fieldHits.join(", ")}] — replace with \${ENV} or \${CELLARER_SECRET:name} before importing`,
      );
    }
    if (await containsActiveKnownValue(env, opts, payloadText)) {
      return reject(
        "known secret value is present beside an active reference — remove plaintext before importing",
      );
    }
    const path = join(opts.storeRoot, "store", "mcp", `${name}.json`);
    const serializedServer = `${JSON.stringify(serverToRaw(server), null, 2)}\n`;
    action = {
      actionId: addActionId(kind, name, path),
      kind: "add-mcp",
      target: path,
      payload: jsonObject({ server }),
      postcondition: { state: "present", fingerprint: sha256(serializedServer) },
      execute: async () => {
        await assertSafeRecursiveSnapshotCurrent(env, snapshot);
        await writeMcpArtifact(env, opts.storeRoot, name, server);
      },
      imported: { kind, name, path },
    };
  } else {
    const path = join(opts.storeRoot, "store", "skills", name);
    const sourceFingerprint = snapshot.fingerprint;
    action = {
      actionId: addActionId(kind, name, path),
      kind: "add-skills",
      target: path,
      payload: { sourceFingerprint },
      postcondition: { state: "present", fingerprint: sourceFingerprint },
      execute: async () => {
        await assertSafeRecursiveSnapshotCurrent(env, snapshot);
        await installSafeRecursiveSnapshot(env, snapshot, path, true);
      },
      imported: { kind, name, path },
    };
  }

  return { result, actions: [action], policy: { kind: "allowed" } };
}

function parseGitHubSource(source: string): GitHubSource | null {
  const shorthand = source.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (shorthand) {
    const [, owner, repoMatch] = shorthand;
    if (!owner || !repoMatch) return null;
    const repo = repoMatch.replace(/\.git$/i, "");
    return {
      source,
      owner,
      repo,
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      resolvedUrl: `https://github.com/${owner}/${repo}`,
      ref: null,
      subpath: null,
    };
  }

  if (!/^https?:\/\//i.test(source)) return null;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (url.hostname !== "github.com") return null;

  const parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));
  if (parts.length < 2 || hasUnsafePathSegments(parts)) return null;
  const owner = parts.at(0);
  const rawRepo = parts.at(1);
  if (!owner || !rawRepo) return null;
  const marker = parts[2];
  const repo = rawRepo.replace(/\.git$/i, "");
  if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    return null;
  }
  if (parts.length === 2) {
    return {
      source,
      owner,
      repo,
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      resolvedUrl: `https://github.com/${owner}/${repo}`,
      ref: null,
      subpath: null,
    };
  }
  if (marker !== "tree") return null;
  const split = splitGitHubTreePath(parts.slice(3));
  if (!split) return null;
  const { ref, subpath } = split;
  return {
    source,
    owner,
    repo,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
    resolvedUrl: `https://github.com/${owner}/${repo}/tree/${ref}/${subpath}`,
    ref,
    subpath,
  };
}

function splitGitHubTreePath(parts: string[]): { ref: string; subpath: string } | null {
  if (parts.length < 2 || hasUnsafePathSegments(parts)) return null;
  for (let i = 1; i < parts.length; i += 1) {
    const suffix = parts.slice(i);
    if (isSkillContainerSubpath(suffix)) {
      return { ref: parts.slice(0, i).join("/"), subpath: suffix.join("/") };
    }
  }
  const ref = parts[0];
  if (!ref) return null;
  return { ref, subpath: parts.slice(1).join("/") };
}

function isSkillContainerSubpath(parts: string[]): boolean {
  const subpath = parts.join("/");
  return SKILL_CONTAINERS.some(
    (container) => subpath === container || subpath.startsWith(`${container}/`),
  );
}

function hasUnsafePathSegments(parts: string[]): boolean {
  return parts.some((p) => p.length === 0 || p === "." || p === ".." || p.includes("\\"));
}

async function stageSource(env: Env, opts: AddOptions): Promise<SourceStage> {
  const localStat = await statOrNull(env, opts.source);
  if (localStat !== null) {
    return {
      path: opts.source,
      source: opts.source,
      resolvedUrl: opts.source,
      vcs: "local",
      ref: null,
      commit: null,
      subpath: null,
    };
  }

  const github = parseGitHubSource(opts.source);
  if (!github) {
    throw new Error(
      "Unsupported source format. M2 supports local paths, GitHub owner/repo, GitHub URLs, and unambiguous GitHub repo subpaths.",
    );
  }
  if (!opts.gitClient) {
    throw new Error("GitHub source import requires a GitClient effect");
  }
  const staged = await opts.gitClient.stageGitHub(github, { env, storeRoot: opts.storeRoot });
  return {
    path: staged.path,
    source: opts.source,
    resolvedUrl: staged.resolvedUrl,
    vcs: "git",
    ref: staged.ref,
    commit: staged.commit,
    subpath: staged.subpath,
    cleanup: staged.cleanup,
  };
}

async function discoverSkillCandidates(env: Env, stage: SourceStage): Promise<SkillCandidate[]> {
  const root = stage.subpath ? join(stage.path, stage.subpath) : stage.path;
  const rootStat = await lstatOrNull(env, root);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`skill source path is not a directory: ${root}`);
  }

  const rootCandidate = await candidateIfSkillDir(env, stage, root);
  if (rootCandidate) return [rootCandidate];

  const candidates: SkillCandidate[] = [];
  const seen = new Set<string>();
  const addCandidate = async (dir: string): Promise<void> => {
    if (seen.has(dir)) return;
    const candidate = await candidateIfSkillDir(env, stage, dir);
    if (!candidate) return;
    seen.add(dir);
    candidates.push(candidate);
  };

  for (const dir of await pluginManifestSkillDirs(env, root)) {
    await addCandidate(dir);
  }

  for (const rel of SKILL_CONTAINERS) {
    const container = join(root, rel);
    const st = await lstatOrNull(env, container);
    if (!st?.isDirectory() || st.isSymbolicLink()) continue;
    const entries = (await readdirOrEmpty(env, container)).sort((a, b) => a.localeCompare(b));
    for (const entry of entries) {
      const first = join(container, entry);
      const firstStat = await lstatOrNull(env, first);
      if (!firstStat?.isDirectory() || firstStat.isSymbolicLink()) continue;
      if (await hasSkillMd(env, first)) {
        await addCandidate(first);
        continue;
      }
      const nested = (await readdirOrEmpty(env, first)).sort((a, b) => a.localeCompare(b));
      for (const child of nested) {
        const second = join(first, child);
        const secondStat = await lstatOrNull(env, second);
        if (secondStat?.isDirectory() && !secondStat.isSymbolicLink()) await addCandidate(second);
      }
    }
  }

  return candidates.sort((a, b) => a.name.localeCompare(b.name));
}

async function candidateIfSkillDir(
  env: Env,
  stage: SourceStage,
  dir: string,
): Promise<SkillCandidate | null> {
  const skillMd = join(dir, "SKILL.md");
  const skillMdStat = await lstatOrNull(env, skillMd);
  if (!skillMdStat?.isFile() && !skillMdStat?.isSymbolicLink()) return null;
  const fallbackName = basename(dir);
  if (skillMdStat.isSymbolicLink()) {
    return rejectedSkillCandidate(
      stage,
      dir,
      fallbackName,
      `SKILL.md is a symlink (${skillMd}) — symlinks are not safely importable`,
    );
  }

  const content = await env.fs.readFile(skillMd);
  const parsed = parseSkillFrontmatter(content);
  const warnings = [...parsed.warnings];
  const name = parsed.frontmatter?.name ?? fallbackName;
  const description = parsed.frontmatter?.description ?? "";
  let rejected = false;
  let rejectionReason: string | undefined;
  const reject = (reason: string): void => {
    rejected = true;
    rejectionReason = rejectionReason ?? reason;
    warnings.push(reason);
  };

  if (!parsed.frontmatter)
    reject(parsed.error ?? "SKILL.md frontmatter must include name and description");
  if (!name || !description) reject("SKILL.md frontmatter must include name and description");
  if (!isSafeArtifactName(name))
    reject(`unsafe skill name "${name}" (allowed: letters, digits, . _ -)`);

  return {
    name,
    description,
    source: stage.source,
    resolvedUrl: stage.resolvedUrl,
    ref: stage.ref,
    commit: stage.commit,
    subpath: normalizeRelative(stage.path, dir),
    path: dir,
    internal: parsed.frontmatter?.metadata?.internal === true,
    warnings,
    rejected,
    rejectionReason,
    frontmatter: parsed.frontmatter,
  };
}

function rejectedSkillCandidate(
  stage: SourceStage,
  dir: string,
  name: string,
  reason: string,
): SkillCandidate {
  return {
    name,
    description: "",
    source: stage.source,
    resolvedUrl: stage.resolvedUrl,
    ref: stage.ref,
    commit: stage.commit,
    subpath: normalizeRelative(stage.path, dir),
    path: dir,
    internal: false,
    warnings: [reason],
    rejected: true,
    rejectionReason: reason,
    frontmatter: null,
  };
}

async function hasSkillMd(env: Env, dir: string): Promise<boolean> {
  const st = await lstatOrNull(env, join(dir, "SKILL.md"));
  return st?.isFile() === true || st?.isSymbolicLink() === true;
}

async function pluginManifestSkillDirs(env: Env, root: string): Promise<string[]> {
  const out: string[] = [];
  for (const rel of [".claude-plugin/marketplace.json", ".claude-plugin/plugin.json"]) {
    const text = await readFileOrNull(env, join(root, rel));
    if (text === null) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(raw)) continue;
    const metadata = isRecord(raw.metadata) ? raw.metadata : {};
    const pluginRoot = typeof metadata.pluginRoot === "string" ? metadata.pluginRoot : ".";
    if (Array.isArray(raw.skills)) {
      for (const skill of raw.skills) {
        if (typeof skill === "string" && !hasUnsafePathSegments(skill.split("/"))) {
          out.push(join(root, skill));
        }
      }
    }
    if (!Array.isArray(raw.plugins)) continue;
    for (const plugin of raw.plugins) {
      if (!isRecord(plugin) || !Array.isArray(plugin.skills)) continue;
      const source =
        typeof plugin.source === "string"
          ? plugin.source
          : typeof plugin.name === "string"
            ? plugin.name
            : ".";
      if (hasUnsafePathSegments(pluginRoot.split("/")) || hasUnsafePathSegments(source.split("/")))
        continue;
      for (const skill of plugin.skills) {
        if (typeof skill !== "string" || hasUnsafePathSegments(skill.split("/"))) continue;
        out.push(join(root, pluginRoot, source, skill));
      }
    }
  }
  return out;
}

function parseSkillFrontmatter(content: string): {
  frontmatter: SkillFrontmatter | null;
  warnings: string[];
  error?: string;
} {
  try {
    const manifest = parseSkillManifest(content);
    return {
      frontmatter: {
        name: manifest.name,
        description: manifest.description,
        ...(manifest.metadata
          ? { metadata: { internal: manifest.metadata.internal === true } }
          : {}),
      },
      warnings: [],
    };
  } catch {
    return { frontmatter: null, warnings: [], error: "unsupported: INVALID_MANIFEST" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRelative(root: string, child: string): string {
  const rel = relative(root, child);
  return rel.length === 0 ? "." : rel.split(/[\\/]+/).join("/");
}

function validateSkillSelectionOptions(opts: AddOptions): void {
  const hasSkills = (opts.skills?.length ?? 0) > 0;
  if (opts.all && hasSkills) throw new Error("--skill and --all are mutually exclusive");
  if (opts.list && (opts.all || hasSkills || opts.force)) {
    throw new Error("--list cannot be combined with --skill, --all, or --force");
  }
}

function visibleCandidates(
  candidates: SkillCandidate[],
  includeInternal: boolean,
): SkillCandidate[] {
  return includeInternal ? candidates : candidates.filter((c) => !c.internal);
}

function selectCandidates(
  candidates: SkillCandidate[],
  opts: AddOptions,
  result: AddResult,
): SkillCandidate[] {
  const includeInternal = opts.collection === "internal";
  if (opts.list) return [];

  if (opts.all) {
    const selected = includeInternal ? candidates : candidates.filter((c) => !c.internal);
    if (!includeInternal) {
      for (const c of candidates.filter((candidate) => candidate.internal)) {
        result.skipped.push({
          kind: "skills",
          name: c.name,
          reason: "internal skill skipped (use --collection internal to include)",
        });
      }
    }
    return selected;
  }

  if (opts.skills && opts.skills.length > 0) {
    const selected: SkillCandidate[] = [];
    const byName = new Map(candidates.map((c) => [c.name, c]));
    for (const name of Array.from(new Set(opts.skills))) {
      const candidate = byName.get(name);
      if (!candidate) {
        result.rejected.push({ kind: "skills", name, reason: "skill not found in source" });
        continue;
      }
      if (candidate.internal && !includeInternal) {
        result.rejected.push({
          kind: "skills",
          name,
          reason: "internal skill requires --collection internal",
        });
        continue;
      }
      selected.push(candidate);
    }
    return selected;
  }

  const visible = visibleCandidates(candidates, includeInternal);
  if (visible.length === 1) return visible;
  if (visible.length === 0 && candidates.length > 0) {
    throw new Error(
      "Source contains only internal skills. Use --collection internal to include them.",
    );
  }
  if (visible.length > 1) {
    throw new Error(
      `Source contains ${visible.length} skills. Choose one with --skill <name>, import all eligible skills with --all, or preview candidates with --list.`,
    );
  }
  throw new Error("No skills found. Ensure the source contains valid SKILL.md files.");
}

async function importSkillCandidate(
  env: Env,
  opts: AddOptions,
  stage: SourceStage,
  candidate: SkillCandidate,
  result: AddResult,
  actions: PreparedAddAction[],
): Promise<PreparedAddPolicy> {
  if (candidate.rejected) {
    result.rejected.push({
      kind: "skills",
      name: candidate.name,
      reason: candidate.rejectionReason ?? "candidate rejected",
    });
    return { kind: "allowed" };
  }
  if (!opts.force && (await nameExists(env, opts.storeRoot, "skills", candidate.name))) {
    result.skipped.push({
      kind: "skills",
      name: candidate.name,
      reason: "already exists (use --force to overwrite)",
    });
    return { kind: "allowed" };
  }

  let snapshot: SafeRecursiveSnapshot;
  try {
    snapshot = await safeSourceSnapshot(env, candidate.path);
  } catch (error) {
    if (!(error instanceof UnsafeRecursiveSourceError)) throw error;
    result.rejected.push({
      kind: "skills",
      name: candidate.name,
      reason: unsafeRecursiveReason(error),
    });
    return { kind: "allowed" };
  }
  if (snapshot.kind !== "directory") {
    result.rejected.push({
      kind: "skills",
      name: candidate.name,
      reason: `unsafe recursive source (non-regular) at ${candidate.path}`,
    });
    return { kind: "allowed" };
  }
  const payloadText = snapshot.files.map((file) => file.content).join("\n");

  const structuredHits = snapshot.files.flatMap((file) =>
    scanStructuredFileSecretFindings(file.relativePath, file.content),
  );
  if (structuredHits.length > 0) {
    result.rejected.push({
      kind: "skills",
      name: candidate.name,
      reason: `structured sensitive-field finding(s) [${[
        ...new Set(structuredHits.map((finding) => `${finding.source}:${finding.rule}`)),
      ].join(", ")}] — replace plaintext with a supported reference before importing`,
    });
    return { kind: "structured-secret-guard" };
  }

  const textHits = scanTextForSecrets(payloadText);
  if (textHits.length > 0) {
    result.rejected.push({
      kind: "skills",
      name: candidate.name,
      reason: `plaintext secret(s) [${textHits.map((h) => h.rule).join(", ")}] — replace with \${ENV} or \${CELLARER_SECRET:name} before importing`,
    });
    return { kind: "allowed" };
  }
  if (await containsActiveKnownValue(env, opts, payloadText)) {
    result.rejected.push({
      kind: "skills",
      name: candidate.name,
      reason:
        "known secret value is present beside an active reference — remove plaintext before importing",
    });
    return { kind: "allowed" };
  }

  const path = join(opts.storeRoot, "store", "skills", candidate.name);
  const sourceFingerprint = snapshot.fingerprint;
  const provenance: SkillProvenance = createResourceRecord({
    resourceId: `skills/${candidate.name}`,
    kind: "skills",
    name: candidate.name,
    contentFingerprint: sourceFingerprint,
    validation: {
      status: "validated",
      checkedAt: env.now().toISOString(),
      checks: ["content-fingerprint", "manifest", "secret-scan"],
    },
    source: skillSourceDescriptor(stage, candidate),
  });
  const provenancePath = skillProvenancePath(opts.storeRoot, candidate.name);
  actions.push(
    {
      actionId: addActionId("skills", candidate.name, path),
      kind: "add-skills",
      target: path,
      payload: { sourceFingerprint },
      postcondition: { state: "present", fingerprint: sourceFingerprint },
      execute: async () => {
        await assertSafeRecursiveSnapshotCurrent(env, snapshot);
        await installSafeRecursiveSnapshot(env, snapshot, path, true);
      },
      imported: { kind: "skills", name: candidate.name, path },
    },
    {
      actionId: addActionId("skills-provenance", candidate.name, provenancePath),
      kind: "add-skill-provenance",
      target: provenancePath,
      payload: jsonObject({ provenance }),
      postcondition: {
        state: "present",
        fingerprint: sha256(`${JSON.stringify(provenance, null, 2)}\n`),
      },
      execute: async () => {
        await writeSkillProvenance(env, opts.storeRoot, candidate.name, provenance);
      },
    },
  );
  return { kind: "allowed" };
}

function skillSourceDescriptor(
  stage: SourceStage,
  candidate: SkillCandidate,
): ResourceSourceDescriptor {
  if (stage.vcs === "git" && candidate.ref && candidate.commit) {
    const git = resourceSourceDescriptorSchema.safeParse({
      type: "git",
      repositoryUrl: candidate.resolvedUrl,
      ref: candidate.ref,
      commit: candidate.commit,
      subpath: candidate.subpath,
    });
    if (git.success) return git.data;
  }
  return { type: "local-snapshot", capturedFrom: candidate.source };
}

function unsafeRecursiveReason(error: UnsafeRecursiveSourceError): string {
  const reason = error.reason === "symbolic-link" ? "symlink" : error.reason;
  return `unsafe recursive source (${reason}) at ${error.path}`;
}

async function executeAddTransaction(
  env: Env,
  opts: AddOptions,
  prepare: () => Promise<PreparedAdd>,
  authorityLease: MutationAuthorityLease,
): Promise<AddResult> {
  const transaction = await executeStoreActionMutation(
    env,
    opts.storeRoot,
    "store-import",
    "add",
    async () => {
      const prepared = await prepare();
      enforcePreparedAddPolicy(prepared.policy);
      const imported = prepared.actions.flatMap((action) =>
        action.imported ? [action.imported] : [],
      );
      const publications = await addCollectionPublication(env, opts, imported);
      return {
        value: prepared,
        actions: prepared.actions,
        ...(publications.length > 0 ? { publications } : {}),
      };
    },
    { authorityLease, secretPublicationGuard: activeSecretPublicationGuard },
  );
  const successfulActionIds = new Set(
    transaction.operation.ok
      ? transaction.operation.receipt.actionReceipts
          .filter((receipt) => receipt.outcome !== "failed")
          .map((receipt) => receipt.actionId)
      : (transaction.operation.journal?.actions ?? [])
          .filter((action) => action.status === "succeeded")
          .map((action) => action.actionId),
  );
  return {
    ...transaction.value.result,
    imported: transaction.value.actions.flatMap((action) =>
      action.imported && successfulActionIds.has(action.actionId) ? [action.imported] : [],
    ),
    operation: transaction.operation,
  };
}

async function addCollectionPublication(
  env: Env,
  opts: AddOptions,
  imported: readonly { kind: ArtifactKind; name: string }[],
): Promise<{ path: string; data: string; mode: number }[]> {
  if (!opts.collection || imported.length === 0) return [];
  const config = await loadConfig(env, opts.storeRoot);
  const next = JSON.parse(JSON.stringify(config)) as CellarerConfig;
  for (const item of imported) {
    const id = `${item.kind}/${item.name}`;
    const collections = next.artifacts[id]?.collections ?? [];
    if (!collections.includes(opts.collection)) {
      next.artifacts[id] = {
        ...next.artifacts[id],
        collections: [...collections, opts.collection],
      };
    }
  }
  return [
    {
      path: join(opts.storeRoot, CONFIG_FILENAME),
      data: `${JSON.stringify(next, null, 2)}\n`,
      mode: 0o600,
    },
  ];
}

function addActionId(kind: string, name: string, target: string): string {
  return sha256(JSON.stringify({ kind, name, target }));
}

function jsonObject(value: unknown): CanonicalJsonObject {
  return JSON.parse(JSON.stringify(value)) as CanonicalJsonObject;
}

async function containsActiveKnownValue(
  env: Env,
  opts: AddOptions,
  content: string,
): Promise<boolean> {
  const config = await loadConfig(env, opts.storeRoot);
  const providerOptions = {
    secretMode: opts.secretMode ?? config.defaults.secretMode,
    vaultPassphrase: opts.vaultPassphrase,
    keychainService: opts.keychainService,
    requireAvailable: true,
  };
  await discoverActiveSecretValues(env, opts.storeRoot, [content], providerOptions);
  const active = await inventoryActiveSecretValues(env, opts.storeRoot, providerOptions);
  return containsKnownSecretValue(content, active);
}

export async function add(env: Env, opts: AddOptions): Promise<AddResult> {
  if (opts.list) return addWithAuthorityLease(env, opts);
  return withCurrentMutationAuthorityLease(env, (authorityLease) =>
    addWithAuthorityLease(env, opts, authorityLease),
  );
}

async function addWithAuthorityLease(
  env: Env,
  opts: AddOptions,
  authorityLease?: MutationAuthorityLease,
): Promise<AddResult> {
  const { scope, operationEnv } = await addProviderScope(env, opts);
  try {
    validateSkillSelectionOptions(opts);
    const localStat = await statOrNull(operationEnv, opts.source);
    if (localStat !== null && !localStat.isDirectory()) {
      const kind = inferKind(false, opts.source);
      const name = deriveName(opts.source, false);
      const rejection = await structuredLocalFileRejection(operationEnv, kind, name, opts.source);
      if (rejection) return attachProviderScope(rejection, scope);
      const result = await executeAddTransaction(
        operationEnv,
        opts,
        () => addLocalFile(operationEnv, opts, kind, name, opts.source, false),
        requireAddMutationLease(authorityLease),
      );
      return attachProviderScope(result, scope);
    }

    const stage = await stageSource(operationEnv, opts);
    try {
      const stagedStat = await statOrNull(operationEnv, stage.path);
      if (stagedStat === null) {
        throw new Error(`source path does not exist: ${stage.path}`);
      }
      if (!stagedStat.isDirectory()) {
        const kind = inferKind(false, stage.path);
        const name = deriveName(stage.path, false);
        const rejection = await structuredLocalFileRejection(operationEnv, kind, name, stage.path);
        if (rejection) return attachProviderScope(rejection, scope);
        const result = await executeAddTransaction(
          operationEnv,
          opts,
          () => addLocalFile(operationEnv, opts, kind, name, stage.path, false),
          requireAddMutationLease(authorityLease),
        );
        return attachProviderScope(result, scope);
      }

      if (!operationEnv.fs.supportsSafeRecursiveSnapshots()) {
        throw new UnsafeRecursiveSourceError(stage.path, "unsupported");
      }

      const candidates = await discoverSkillCandidates(operationEnv, stage);
      if (opts.list) {
        const result = emptyResult();
        result.candidates = visibleCandidates(candidates, opts.collection === "internal");
        return attachProviderScope(result, scope);
      }
      const preflight = emptyResult();
      preflight.candidates = visibleCandidates(candidates, opts.collection === "internal");
      const selected = selectCandidates(candidates, opts, preflight);
      for (const candidate of selected) {
        const decision = await structuredSkillRejection(operationEnv, candidate);
        recordStructuredSkillRejection(preflight, candidate.name, decision);
      }
      if (preflight.rejected.length > 0) return attachProviderScope(preflight, scope);
      const result = await executeAddTransaction(
        operationEnv,
        opts,
        async () => {
          const prepared = emptyResult();
          prepared.candidates = visibleCandidates(candidates, opts.collection === "internal");
          const selectedCandidates = selectCandidates(candidates, opts, prepared);
          const actions: PreparedAddAction[] = [];
          let policy: PreparedAddPolicy = { kind: "allowed" };
          for (const candidate of selectedCandidates) {
            const candidatePolicy = await importSkillCandidate(
              operationEnv,
              opts,
              stage,
              candidate,
              prepared,
              actions,
            );
            if (candidatePolicy.kind === "structured-secret-guard") policy = candidatePolicy;
          }
          return { result: prepared, actions, policy };
        },
        requireAddMutationLease(authorityLease),
      );
      return attachProviderScope(result, scope);
    } finally {
      await stage.cleanup?.();
    }
  } catch (error) {
    throw attachAddScopeToError(error, scope);
  }
}

function requireAddMutationLease(
  authorityLease: MutationAuthorityLease | undefined,
): MutationAuthorityLease {
  if (!authorityLease) throw new TypeError("mutation authority is not current");
  return authorityLease;
}

async function addProviderScope(
  env: Env,
  opts: AddOptions,
): Promise<{ scope: ProviderScope; operationEnv: Env }> {
  const config = await loadConfig(env, opts.storeRoot);
  const scope = createProviderScope({
    secretMode: opts.secretMode ?? config.defaults.secretMode,
    vaultPassphrase: opts.vaultPassphrase,
    keychainService: opts.keychainService,
  });
  return { scope, operationEnv: withProviderScope(env, scope) };
}

function attachAddScopeToError(error: unknown, scope: ProviderScope): unknown {
  return typeof error === "object" && error !== null ? attachProviderScope(error, scope) : error;
}
