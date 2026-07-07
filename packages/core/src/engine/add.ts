// add:从本地或 GitHub source 导入制品到库房。rules/MCP 仍是本地文件导入;
// skills 走 source resolver -> discovery -> selection -> safety guard -> store/provenance。
import { basename, extname, join, relative } from "node:path";
import type { Env } from "../env.js";
import { lstatOrNull, readdirOrEmpty, readFileOrNull, statOrNull } from "../fs/probe.js";
import { type McpServer, serverFromRaw } from "../mcp/model.js";
import type { ArtifactKind } from "../model/index.js";
import { detectSecret, scanTextForSecrets } from "../secrets/detector.js";
import { tagArtifactCollections } from "../store/config.js";
import {
  importSkillArtifact,
  isSafeArtifactName,
  listMcpArtifacts,
  listRuleArtifacts,
  listSkillArtifacts,
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

export interface SkillProvenance {
  kind: "skills";
  name: string;
  source: string;
  resolvedUrl: string;
  vcs: "git" | "local";
  ref: string | null;
  commit: string | null;
  subpath: string;
  collection: string | null;
  importedAt: string;
  frontmatter: SkillFrontmatter | null;
  internal: boolean;
  warnings: string[];
}

export interface AddResult {
  imported: { kind: ArtifactKind; name: string; path: string }[];
  skipped: { kind: ArtifactKind; name: string; reason: string }[];
  rejected: { kind: ArtifactKind; name: string; reason: string }[];
  candidates: SkillCandidate[];
  warnings: string[];
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

// 收集目录下所有文件文本(用于 skills 写前明文护栏);经 Env.fs 遍历。
async function collectDirText(env: Env, dir: string): Promise<string> {
  const parts: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const name of await readdirOrEmpty(env, d)) {
      const full = join(d, name);
      const st = await env.fs.lstat(full);
      if (st.isDirectory()) await walk(full);
      else if (st.isFile()) parts.push(await env.fs.readFile(full));
    }
  };
  await walk(dir);
  return parts.join("\n");
}

// skill 目录内是否含符号链接(任意深度)。含则拒绝导入。
async function findSymlink(env: Env, dir: string): Promise<string | null> {
  for (const name of await readdirOrEmpty(env, dir)) {
    const full = join(dir, name);
    const st = await env.fs.lstat(full);
    if (st.isSymbolicLink()) return full;
    if (st.isDirectory()) {
      const nested = await findSymlink(env, full);
      if (nested) return nested;
    }
  }
  return null;
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
  isDir: boolean,
): Promise<AddResult> {
  const result = emptyResult();
  if (opts.list || opts.all || (opts.skills && opts.skills.length > 0)) {
    throw new Error(
      "--list, --skill, and --all are only supported for skill directory or GitHub sources",
    );
  }

  if (!opts.force && (await nameExists(env, opts.storeRoot, kind, name))) {
    result.skipped.push({ kind, name, reason: "already exists (use --force to overwrite)" });
    return result;
  }

  const reject = (reason: string): AddResult => {
    result.rejected.push({ kind, name, reason });
    return result;
  };

  const payloadText = isDir ? await collectDirText(env, source) : await env.fs.readFile(source);
  const textHits = scanTextForSecrets(payloadText);
  if (textHits.length > 0) {
    return reject(
      `plaintext secret(s) [${textHits.map((h) => h.rule).join(", ")}] — replace with \${ENV} or \${CELLARER_SECRET:name} before importing`,
    );
  }

  let path: string;
  if (kind === "rules") {
    path = await writeRuleArtifact(env, opts.storeRoot, name, payloadText);
  } else if (kind === "mcp") {
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
    path = await writeMcpArtifact(env, opts.storeRoot, name, server);
  } else {
    path = await importSkillArtifact(env, opts.storeRoot, name, source);
  }

  result.imported.push({ kind, name, path });
  if (opts.collection)
    await tagArtifactCollections(env, opts.storeRoot, [`${kind}/${name}`], opts.collection);
  return result;
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
  const warnings: string[] = [];
  const normalized = content.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: null, warnings, error: "SKILL.md frontmatter is missing" };
  }
  const end = lines.findIndex((line, i) => i > 0 && ["---", "..."].includes(line.trim()));
  if (end === -1) {
    return { frontmatter: null, warnings, error: "SKILL.md frontmatter is not closed" };
  }

  const data: { name?: string; description?: string; metadata?: { internal?: boolean } } = {};
  let section: string | null = null;
  for (const raw of lines.slice(1, end)) {
    if (raw.trim().length === 0 || raw.trimStart().startsWith("#")) continue;
    const indent = raw.match(/^ */)?.[0].length ?? 0;
    const trimmed = raw.trim();
    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      warnings.push(`ignored unsupported frontmatter line "${trimmed}"`);
      continue;
    }
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (indent === 0) {
      section = key;
      if (key === "name") data.name = scalar(value);
      else if (key === "description") data.description = scalar(value);
      else if (key === "metadata") data.metadata ??= {};
    } else if (section === "metadata" && key === "internal") {
      data.metadata ??= {};
      data.metadata.internal = ["true", "1", "yes"].includes(scalar(value).toLowerCase());
    }
  }

  if (!data.name || !data.description) {
    return {
      frontmatter: null,
      warnings,
      error: "SKILL.md frontmatter must include name and description",
    };
  }
  return {
    frontmatter: {
      name: data.name,
      description: data.description,
      ...(data.metadata ? { metadata: data.metadata } : {}),
    },
    warnings,
  };
}

function scalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
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
): Promise<void> {
  if (candidate.rejected) {
    result.rejected.push({
      kind: "skills",
      name: candidate.name,
      reason: candidate.rejectionReason ?? "candidate rejected",
    });
    return;
  }
  if (!opts.force && (await nameExists(env, opts.storeRoot, "skills", candidate.name))) {
    result.skipped.push({
      kind: "skills",
      name: candidate.name,
      reason: "already exists (use --force to overwrite)",
    });
    return;
  }

  const link = await findSymlink(env, candidate.path);
  if (link !== null) {
    result.rejected.push({
      kind: "skills",
      name: candidate.name,
      reason: `skill contains a symlink (${link}) — symlinks are not safely importable`,
    });
    return;
  }

  const textHits = scanTextForSecrets(await collectDirText(env, candidate.path));
  if (textHits.length > 0) {
    result.rejected.push({
      kind: "skills",
      name: candidate.name,
      reason: `plaintext secret(s) [${textHits.map((h) => h.rule).join(", ")}] — replace with \${ENV} or \${CELLARER_SECRET:name} before importing`,
    });
    return;
  }

  const path = await importSkillArtifact(env, opts.storeRoot, candidate.name, candidate.path);
  result.imported.push({ kind: "skills", name: candidate.name, path });
  if (opts.collection) {
    await tagArtifactCollections(env, opts.storeRoot, [`skills/${candidate.name}`], opts.collection);
  }
  const provenance: SkillProvenance = {
    kind: "skills",
    name: candidate.name,
    source: candidate.source,
    resolvedUrl: candidate.resolvedUrl,
    vcs: stage.vcs,
    ref: candidate.ref,
    commit: candidate.commit,
    subpath: candidate.subpath,
    collection: opts.collection ?? null,
    importedAt: env.now().toISOString(),
    frontmatter: candidate.frontmatter,
    internal: candidate.internal,
    warnings: candidate.warnings,
  };
  await writeSkillProvenance(env, opts.storeRoot, candidate.name, provenance);
}

export async function add(env: Env, opts: AddOptions): Promise<AddResult> {
  validateSkillSelectionOptions(opts);
  const localStat = await statOrNull(env, opts.source);
  if (localStat !== null && !localStat.isDirectory()) {
    const kind = inferKind(false, opts.source);
    return addLocalFile(env, opts, kind, deriveName(opts.source, false), opts.source, false);
  }

  const stage = await stageSource(env, opts);
  try {
    const stagedStat = await statOrNull(env, stage.path);
    if (stagedStat === null) {
      throw new Error(`source path does not exist: ${stage.path}`);
    }
    if (!stagedStat.isDirectory()) {
      const kind = inferKind(false, stage.path);
      return addLocalFile(env, opts, kind, deriveName(stage.path, false), stage.path, false);
    }

    const result = emptyResult();
    const candidates = await discoverSkillCandidates(env, stage);
    result.candidates = visibleCandidates(candidates, opts.collection === "internal");
    if (opts.list) return result;

    const selected = selectCandidates(candidates, opts, result);
    for (const candidate of selected) {
      await importSkillCandidate(env, opts, stage, candidate, result);
    }
    return result;
  } finally {
    await stage.cleanup?.();
  }
}
