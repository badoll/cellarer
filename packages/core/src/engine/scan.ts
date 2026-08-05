// scan(扫描回写,kickoff §9):下发的逆向 —— 把 agent/目录里已有的 rules/mcp/skills 收进库房。
// 流程:读目标现有配置 → 规范化为 canonical → 脱敏(密钥→占位符)→ 与库房 diff → 冲突策略 → 写库房。
//
// 关键约束:
//   - 零明文(红线):mcp 的 env/headers 真值在「入库前」用 redactFields 换占位符,真值绝不进库房。
//   - 不吸收自身下发物:靠台账 target + 产物指纹(rules 首行 marker / mcp server 名匹配库房制品)双保险,
//     避免把 cellarer 自己写的内容当用户新增重复收编。
//   - plan/apply 分离:scanPlan 只读 + 产出计划;applyScan 才写库房。

import { join } from "node:path";
import { appendActivity } from "../activity.js";
import { loadRegistry } from "../adapters/registry.js";
import type { Env, MutationAuthorityLease } from "../env.js";
import { lstatOrNull, readdirOrEmpty } from "../fs/probe.js";
import { isGenerated } from "../markers.js";
import { type McpServer, serverToRaw } from "../mcp/model.js";
import type { Scope } from "../model/index.js";
import { withCurrentMutationAuthorityLease } from "../protocol/canonical.js";
import type { OperationResult } from "../protocol/models.js";
import { executeStoreActionMutation } from "../protocol/store-mutation.js";
import {
  attachProviderScope,
  containsKnownSecretValue,
  createProviderScope,
  discoverActiveSecretValues,
  inventoryActiveSecretValues,
  type ProviderScope,
  withProviderScope,
} from "../secrets/active-values.js";
import {
  type SecretFinding,
  scanStructuredFileSecretFindings,
  scanTextForSecrets,
} from "../secrets/detector.js";
import { redactFields } from "../secrets/redactor.js";
import {
  assertSafeRecursiveSnapshotCurrent,
  captureSafeRecursiveSource,
  installSafeRecursiveSnapshot,
  type SafeRecursiveSnapshot,
  UnsafeRecursiveSourceError,
} from "../secrets/safe-tree.js";
import { sha256 } from "../store/checksum.js";
import { type CellarerConfig, CONFIG_FILENAME, loadConfig } from "../store/config.js";
import {
  listMcpArtifacts,
  listRuleArtifacts,
  listSkillArtifacts,
  writeMcpArtifact,
  writeRuleArtifact,
} from "../store/store.js";

// 冲突策略:库房已有同名制品时的处理。
//   keep-theirs:用扫描来的覆盖库房(默认,"收编")。
//   keep-mine:保留库房,跳过扫描项。
//   copy:新建副本(带来源后缀)。
export type ConflictStrategy = "keep-theirs" | "keep-mine" | "copy";

export interface ScanSelection {
  kind: "rules" | "mcp" | "skills";
  name: string;
  source?: string;
}

export interface ScanOptions {
  storeRoot: string;
  agent: string;
  scope: Scope;
  dir?: string;
  // 入库目标 collection(写 config.json 的 artifacts 标签)。
  intoCollection?: string;
  conflict?: ConflictStrategy;
  // 仅扫描这些能力(缺省三类全扫)。
  capabilities?: ("rules" | "mcp" | "skills")[];
  // 仅导入这些制品名(按扫描发现的原始 name 匹配;缺省导入全部发现项)。非交互选择入口。
  select?: string[];
  // Web/GUI 使用的精确选择:避免不同 kind/source 下同名制品被 name-only 选择一起导入。
  selectItems?: ScanSelection[];
  // Provider inputs remain operation-scoped; applyScan requires every active reference.
  secretMode?: "env" | "vault" | "keychain";
  vaultPassphrase?: string;
  keychainService?: string;
}

// 扫描发现的单个候选制品(尚未写库房)。
export interface ScanItem {
  kind: "rules" | "mcp" | "skills";
  // 入库后的制品名(冲突 copy 时已带后缀)。
  name: string;
  // 与库房既有制品的关系。
  status: "new" | "conflict";
  // 实际入库动作(经冲突策略裁决后)。
  action: "import" | "skip";
  // 涉及的密钥引用名(脱敏后,不含真值);供审计与提示存 vault。
  secretRefs?: string[];
  // 来源描述(agent 文件路径 / server 名),便于人读。
  source: string;
}

export interface ScanPlan {
  agent: string;
  scope: Scope;
  items: ScanItem[];
  warnings: string[];
}

// 内部:携带写库房所需的载荷(canonical 内容),不暴露到 ScanItem(避免真值/大对象外泄)。
interface ScanCandidate {
  item: ScanItem;
  payload:
    | { kind: "rules"; content: string; snapshot: SafeRecursiveSnapshot }
    | { kind: "mcp"; server: McpServer; snapshot: SafeRecursiveSnapshot }
    | { kind: "skills"; snapshot: SafeRecursiveSnapshot; stagedText: string };
}

class StructuredScanGuardError extends Error {
  constructor() {
    super("structured scan validation failed before protocol publication");
    this.name = "StructuredScanGuardError";
  }
}

function wantCap(opts: ScanOptions, cap: "rules" | "mcp" | "skills"): boolean {
  return !opts.capabilities || opts.capabilities.includes(cap);
}

function selectionKey(item: ScanSelection): string {
  return `${item.kind}\0${item.name}\0${item.source ?? ""}`;
}

// 过滤:selectItems 精确匹配行;旧 select 保持按 name 匹配,兼容 CLI 非交互入口。
function applySelect(
  candidates: ScanCandidate[],
  select: string[] | undefined,
  selectItems: ScanSelection[] | undefined,
): ScanCandidate[] {
  if (selectItems && selectItems.length > 0) {
    const want = new Set(selectItems.map(selectionKey));
    return candidates.filter((c) => want.has(selectionKey(c.item)));
  }
  if (!select || select.length === 0) return candidates;
  const want = new Set(select);
  return candidates.filter((c) => want.has(c.item.name));
}

// —— 扫描(只读)：产出候选 —— //
async function scanCandidates(
  env: Env,
  opts: ScanOptions,
): Promise<{ candidates: ScanCandidate[]; warnings: string[]; structuredBlocked: boolean }> {
  const warnings: string[] = [];
  let structuredBlocked = false;
  const registry = await loadRegistry(env, opts.storeRoot);
  warnings.push(...registry.warnings);
  const adapter = registry.get(opts.agent);
  if (!adapter) {
    warnings.push(`unknown agent "${opts.agent}" — nothing to scan`);
    return { candidates: [], warnings, structuredBlocked };
  }
  const paths = adapter.paths(env, opts.scope, opts.dir);
  const candidates: ScanCandidate[] = [];

  // rules:读 agent 原生 rules 文件;cellarer 生成物(首行 marker)跳过,不回收自身。
  if (wantCap(opts, "rules") && paths.rules) {
    const snapshot = await optionalSourceSnapshot(env, paths.rules, warnings, "rules");
    const content = snapshot?.kind === "file" ? snapshot.files[0]?.content : undefined;
    if (snapshot && content !== undefined && content.trim().length > 0) {
      if (isGenerated(content)) {
        warnings.push(`rules at ${paths.rules} is cellarer-generated — skipped (not re-absorbed)`);
      } else {
        candidates.push({
          item: {
            kind: "rules",
            name: opts.agent,
            status: "new",
            action: "import",
            source: paths.rules,
          },
          payload: { kind: "rules", content, snapshot },
        });
      }
    }
  }

  // mcp:decode agent 原生 mcp 文件 → canonical servers;脱敏 env/headers。
  if (wantCap(opts, "mcp") && paths.mcp && adapter.mcp) {
    const snapshot = await optionalSourceSnapshot(env, paths.mcp, warnings, "mcp");
    const content = snapshot?.kind === "file" ? snapshot.files[0]?.content : undefined;
    if (snapshot && content !== undefined && content.trim().length > 0) {
      const sourceFindings = scanStructuredFileSecretFindings(paths.mcp, content).filter(
        (finding) =>
          finding.rule === "duplicate-key" ||
          finding.rule === "structured-parse-error" ||
          finding.rule === "command-secret-argument",
      );
      if (sourceFindings.length > 0) {
        structuredBlocked = true;
        warnings.push(
          `secret-scan: refusing to import raw structured mcp source [${[
            ...new Set(sourceFindings.map((finding) => finding.rule)),
          ].join(", ")}] (${paths.mcp})`,
        );
      } else {
        try {
          const decoded = adapter.mcp.codec.decode(content, adapter.mcp.serversKey);
          for (const [name, server] of Object.entries(decoded.servers)) {
            const { server: redacted, refs } = redactServerSecrets(server, name);
            candidates.push({
              item: {
                kind: "mcp",
                name,
                status: "new",
                action: "import",
                source: `${paths.mcp} → ${name}`,
                secretRefs: refs.length > 0 ? refs : undefined,
              },
              payload: { kind: "mcp", server: redacted, snapshot },
            });
          }
        } catch (err) {
          warnings.push(
            `failed to parse mcp at ${paths.mcp}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  // skills:列 agent skills 目录;软链(多半是 cellarer/共享池指向真源)跳过,只收真实目录。
  if (wantCap(opts, "skills") && paths.skillsDir && !env.fs.supportsSafeRecursiveSnapshots()) {
    warnings.push(
      `secret-scan: refusing to inspect skills — unsafe recursive source (unsupported) at ${paths.skillsDir}`,
    );
  }
  if (wantCap(opts, "skills") && paths.skillsDir && env.fs.supportsSafeRecursiveSnapshots()) {
    const entries = await readdirOrEmpty(env, paths.skillsDir);
    for (const name of entries.sort()) {
      const abs = `${paths.skillsDir}/${name}`;
      const st = await lstatOrNull(env, abs);
      if (st?.isSymbolicLink()) {
        warnings.push(
          `secret-scan: refusing to import skills/${name} — unsafe recursive source (symbolic-link) at ${abs}`,
        );
        continue;
      }
      if (!st?.isDirectory()) continue;
      try {
        const snapshot = await captureSafeRecursiveSource(env, abs);
        if (snapshot.kind !== "directory") {
          throw new UnsafeRecursiveSourceError(abs, "non-regular");
        }
        candidates.push({
          item: { kind: "skills", name, status: "new", action: "import", source: abs },
          payload: {
            kind: "skills",
            snapshot,
            stagedText: snapshot.files.map((file) => file.content).join("\n"),
          },
        });
      } catch (error) {
        if (!(error instanceof UnsafeRecursiveSourceError)) throw error;
        warnings.push(
          `secret-scan: refusing to import skills/${name} — unsafe recursive source (${error.reason}) at ${error.path}`,
        );
      }
    }
  }

  return { candidates, warnings, structuredBlocked };
}

async function optionalSourceSnapshot(
  env: Env,
  path: string,
  warnings: string[],
  kind: "rules" | "mcp",
): Promise<SafeRecursiveSnapshot | undefined> {
  try {
    return await captureSafeRecursiveSource(env, path);
  } catch (error) {
    if (!(error instanceof UnsafeRecursiveSourceError)) throw error;
    if (error.reason === "unreadable") {
      const stat = await lstatOrNull(env, path);
      if (stat === null) return undefined;
    }
    warnings.push(
      `secret-scan: refusing to import ${kind} — unsafe source (${error.reason}) at ${error.path}`,
    );
    return undefined;
  }
}

// 脱敏单个 server 的密钥承载字段(入库前);真值绝不进库房。
// env/headers(map)+ args(数组)+ url(整值)都过 redact;custom 无固定结构,交写前文本护栏兜底。
function redactServerSecrets(
  server: McpServer,
  serverName: string,
): { server: McpServer; refs: string[] } {
  const scope = `mcp/${serverName}`;
  if (server.kind === "stdio") {
    const refs: string[] = [];
    let out = server;
    if (server.env) {
      const r = redactFields(server.env, scope);
      out = { ...out, env: r.redacted };
      refs.push(...r.refs.map((x) => x.suggestedName));
    }
    if (server.args) {
      const r = redactArray(server.args, scope);
      out = { ...out, args: r.redacted };
      refs.push(...r.refs);
    }
    return { server: out, refs };
  }
  if (server.kind === "remote") {
    const refs: string[] = [];
    let out = server;
    if (server.headers) {
      const r = redactFields(server.headers, scope);
      out = { ...out, headers: r.redacted };
      refs.push(...r.refs.map((x) => x.suggestedName));
    }
    // url 整值可能含查询串密钥;按字段名 "url" 检测,命中则换占位符。
    const u = redactFields({ url: server.url }, scope);
    if (u.refs.length > 0) {
      out = { ...out, url: u.redacted.url as string };
      refs.push(...u.refs.map((x) => x.suggestedName));
    }
    return { server: out, refs };
  }
  return { server, refs: [] };
}

// 脱敏字符串数组(mcp args):逐项当作字段 args[i] 检测,命中换占位符。
function redactArray(arr: string[], scope: string): { redacted: string[]; refs: string[] } {
  const refs: string[] = [];
  const redacted = arr.map((v, i) => {
    const r = redactFields({ [`args_${i}`]: v }, scope);
    if (r.refs.length > 0) {
      refs.push(...r.refs.map((x) => x.suggestedName));
      return r.redacted[`args_${i}`] as string;
    }
    return v;
  });
  return { redacted, refs };
}

// 现有库房制品名集合(用于 new/conflict 判定 + 「不吸收自身」指纹)。
async function existingNames(
  env: Env,
  storeRoot: string,
): Promise<{ rules: Set<string>; mcp: Set<string>; skills: Set<string> }> {
  const [rules, mcp, skills] = await Promise.all([
    listRuleArtifacts(env, storeRoot),
    listMcpArtifacts(env, storeRoot),
    listSkillArtifacts(env, storeRoot),
  ]);
  return {
    rules: new Set(rules.map((a) => a.name)),
    mcp: new Set(mcp.map((a) => a.name)),
    skills: new Set(skills.map((a) => a.name)),
  };
}

// 应用冲突策略:裁决每个候选的最终 name/status/action。
// 副本命名既避开库房既有名,也避开本轮已占用名(防两个候选撞到同一副本路径)。
function resolveConflicts(
  candidates: ScanCandidate[],
  existing: { rules: Set<string>; mcp: Set<string>; skills: Set<string> },
  strategy: ConflictStrategy,
  agent: string,
): ScanCandidate[] {
  // 本轮各 kind 已确定写入的名字(含 new 直接占用的 + copy 生成的),避免运行内重名互相覆盖。
  const claimed = { rules: new Set<string>(), mcp: new Set<string>(), skills: new Set<string>() };
  return candidates.map((c) => {
    const set = existing[c.item.kind];
    const taken = claimed[c.item.kind];
    const collides = (n: string) => set.has(n) || taken.has(n);

    if (!collides(c.item.name)) {
      taken.add(c.item.name);
      return c; // new,原样
    }
    // 冲突。
    if (strategy === "keep-mine") {
      return { ...c, item: { ...c.item, status: "conflict", action: "skip" } };
    }
    if (strategy === "copy") {
      // 新建副本:带来源后缀(agent 名),仍冲突(库房或本轮)则加序号。
      let name = `${c.item.name}-${agent}`;
      let i = 2;
      while (collides(name)) name = `${c.item.name}-${agent}-${i++}`;
      taken.add(name);
      return { ...c, item: { ...c.item, name, status: "conflict", action: "import" } };
    }
    // keep-theirs(默认):覆盖库房。
    taken.add(c.item.name);
    return { ...c, item: { ...c.item, status: "conflict", action: "import" } };
  });
}

// 写前明文护栏(零明文红线的最后兜底):把候选序列化为「即将落库的文本」,高置信扫描。
// 命中(redact 漏掉的:rules 自由文本里的 token、custom server 内嵌密钥、args/url 非常规位)→
// 拒绝该项入库(转 skip + 告警),绝不把明文写进库房。返回 null 表示通过。
function plaintextInStorePayload(c: ScanCandidate): SecretFinding[] {
  let text: string;
  if (c.payload.kind === "rules") {
    text = c.payload.content;
  } else if (c.payload.kind === "mcp") {
    text = JSON.stringify(serverToRaw(c.payload.server));
  } else {
    text = c.payload.stagedText;
  }
  return scanTextForSecrets(text);
}

function structuredFindingsInScanCandidate(c: ScanCandidate) {
  if (c.payload.kind === "skills") {
    return c.payload.snapshot.files.flatMap((file) =>
      scanStructuredFileSecretFindings(file.relativePath, file.content),
    );
  }
  if (c.payload.kind === "mcp") {
    return scanStructuredFileSecretFindings(
      "captured-mcp.json",
      JSON.stringify(serverToRaw(c.payload.server)),
    );
  }
  return [];
}

// 对已裁决的候选施加写前明文护栏:仍含明文者转 skip 并记原因/告警。
// 集中一处,scanPlan 与 applyScan 共用 → 预览与落地裁决一致。
async function guardPlaintext(
  env: Env,
  opts: ScanOptions,
  resolved: ScanCandidate[],
  warnings: string[],
  requireAvailableReferences = false,
  onStructuredFinding?: () => void,
): Promise<ScanCandidate[]> {
  const config = await loadConfig(env, opts.storeRoot);
  return Promise.all(
    resolved.map(async (c) => {
      if (c.item.action !== "import") return c;
      const hits = plaintextInStorePayload(c);
      const text = storePayloadText(c);
      const structuredHits = structuredFindingsInScanCandidate(c);
      if (structuredHits.length > 0) {
        onStructuredFinding?.();
        warnings.push(
          `secret-scan: refusing to import ${c.item.kind}/${c.item.name} — structured sensitive-field finding(s) [${[
            ...new Set(structuredHits.map((finding) => `${finding.source}:${finding.rule}`)),
          ].join(", ")}] (${c.item.source})`,
        );
        return { ...c, item: { ...c.item, action: "skip", status: c.item.status } };
      }
      if (hits.length > 0) {
        warnings.push(
          `secret-scan: refusing to import ${c.item.kind}/${c.item.name} — plaintext secret(s) [${hits
            .map((h) => h.rule)
            .join(", ")}] could not be auto-redacted (${c.item.source})`,
        );
        return { ...c, item: { ...c.item, action: "skip", status: c.item.status } };
      }
      const providerOptions = {
        secretMode: opts.secretMode ?? config.defaults.secretMode,
        vaultPassphrase: opts.vaultPassphrase,
        keychainService: opts.keychainService,
        requireAvailable: requireAvailableReferences,
      };
      await discoverActiveSecretValues(env, opts.storeRoot, [text], providerOptions);
      const active = await inventoryActiveSecretValues(env, opts.storeRoot, providerOptions);
      const knownValue = containsKnownSecretValue(text, active);
      if (!knownValue) return c;
      warnings.push(
        `secret-scan: refusing to import ${c.item.kind}/${c.item.name} — known secret value beside an active reference (${c.item.source})`,
      );
      return { ...c, item: { ...c.item, action: "skip", status: c.item.status } };
    }),
  );
}

function storePayloadText(c: ScanCandidate): string {
  if (c.payload.kind === "rules") return c.payload.content;
  if (c.payload.kind === "mcp") return JSON.stringify(serverToRaw(c.payload.server));
  return c.payload.stagedText;
}

// 扫描计划(只读):读目标 → 脱敏 → 冲突裁决 → 写前护栏 → 候选清单。不写库房。
export async function scanPlan(env: Env, opts: ScanOptions): Promise<ScanPlan> {
  const { scope, operationEnv } = await scanProviderScope(env, opts);
  try {
    const { candidates, warnings } = await scanCandidates(operationEnv, opts);
    const selected = applySelect(candidates, opts.select, opts.selectItems);
    const existing = await existingNames(operationEnv, opts.storeRoot);
    const resolved = await guardPlaintext(
      operationEnv,
      opts,
      resolveConflicts(selected, existing, opts.conflict ?? "keep-theirs", opts.agent),
      warnings,
    );
    return attachProviderScope(
      {
        agent: opts.agent,
        scope: opts.scope,
        items: resolved.map((c) => c.item),
        warnings,
      },
      scope,
    );
  } catch (error) {
    throw attachScopeToError(error, scope);
  }
}

export interface ScanResult {
  plan: ScanPlan;
  imported: ScanItem[];
  operation: OperationResult;
}

// applyScan:执行扫描计划,把 action==="import" 的候选写库房(已脱敏 + 过写前护栏)。
export async function applyScan(env: Env, opts: ScanOptions): Promise<ScanResult> {
  return withCurrentMutationAuthorityLease(env, (authorityLease) =>
    applyScanWithAuthorityLease(env, opts, authorityLease),
  );
}

async function applyScanWithAuthorityLease(
  env: Env,
  opts: ScanOptions,
  authorityLease: MutationAuthorityLease,
): Promise<ScanResult> {
  const { scope, operationEnv } = await scanProviderScope(env, opts);
  try {
    const scanned = await scanCandidates(operationEnv, opts);
    const selected = applySelect(scanned.candidates, opts.select, opts.selectItems);
    let structuredBlocked = scanned.structuredBlocked;
    const preflightCandidates = selected.map((candidate) => {
      const findings = structuredFindingsInScanCandidate(candidate);
      if (findings.length === 0) return candidate;
      structuredBlocked = true;
      scanned.warnings.push(
        `secret-scan: refusing to import ${candidate.item.kind}/${candidate.item.name} — structured sensitive-field finding(s) [${[
          ...new Set(findings.map((finding) => `${finding.source}:${finding.rule}`)),
        ].join(", ")}] (${candidate.item.source})`,
      );
      return { ...candidate, item: { ...candidate.item, action: "skip" as const } };
    });
    const preflightPlan: ScanPlan = {
      agent: opts.agent,
      scope: opts.scope,
      items: preflightCandidates.map((candidate) => candidate.item),
      warnings: scanned.warnings,
    };
    if (structuredBlocked) {
      return attachProviderScope(
        {
          plan: preflightPlan,
          imported: [],
          operation: {
            ok: false,
            conflict: { code: "INVALID_PLAN", message: "mutation plan is invalid" },
          },
        },
        scope,
      );
    }
    const transaction = await executeStoreActionMutation(
      operationEnv,
      opts.storeRoot,
      "store-import",
      "scan-import",
      async () => {
        const current = await scanCandidates(operationEnv, opts);
        if (current.structuredBlocked) throw new StructuredScanGuardError();
        const currentSelected = applySelect(current.candidates, opts.select, opts.selectItems);
        const existing = await existingNames(operationEnv, opts.storeRoot);
        const warnings = current.warnings;
        const resolved = await guardPlaintext(
          operationEnv,
          opts,
          resolveConflicts(currentSelected, existing, opts.conflict ?? "keep-theirs", opts.agent),
          warnings,
          true,
          () => {
            throw new StructuredScanGuardError();
          },
        );
        const imports = resolved
          .filter((candidate) => candidate.item.action === "import")
          .map((candidate, index) => {
            const target = scanImportTarget(opts.storeRoot, candidate.item);
            const actionId = `scan-${index + 1}-${candidate.item.kind}-${candidate.item.name}`;
            return { actionId, candidate, target };
          });
        const publications = await scanCollectionPublication(
          operationEnv,
          opts,
          imports.map(({ candidate }) => candidate.item),
        );
        const importedItems = imports.map(({ candidate }) => candidate.item);
        const actions = await Promise.all(
          imports.map(async ({ actionId, candidate, target }) => ({
            actionId,
            kind: `scan-${candidate.item.kind}`,
            target,
            payload:
              candidate.payload.kind === "skills"
                ? {
                    kind: "skills",
                    sourceFingerprint: candidate.payload.snapshot.fingerprint,
                  }
                : candidate.payload.kind === "rules"
                  ? { kind: "rules", contentDigest: sha256(candidate.payload.content) }
                  : JSON.parse(JSON.stringify({ kind: "mcp", server: candidate.payload.server })),
            postcondition: {
              state: "present" as const,
              fingerprint: await scanImportFingerprint(operationEnv, candidate.payload),
            },
            execute: async () => {
              if (candidate.payload.kind === "rules") {
                await assertSafeRecursiveSnapshotCurrent(operationEnv, candidate.payload.snapshot);
                await writeRuleArtifact(
                  operationEnv,
                  opts.storeRoot,
                  candidate.item.name,
                  candidate.payload.content,
                );
              } else if (candidate.payload.kind === "mcp") {
                await assertSafeRecursiveSnapshotCurrent(operationEnv, candidate.payload.snapshot);
                await writeMcpArtifact(
                  operationEnv,
                  opts.storeRoot,
                  candidate.item.name,
                  candidate.payload.server,
                );
              } else {
                await assertSafeRecursiveSnapshotCurrent(operationEnv, candidate.payload.snapshot);
                await installSafeRecursiveSnapshot(
                  operationEnv,
                  candidate.payload.snapshot,
                  target,
                  true,
                );
              }
            },
          })),
        );
        return {
          value: {
            plan: {
              agent: opts.agent,
              scope: opts.scope,
              items: resolved.map((candidate) => candidate.item),
              warnings,
            },
            imports: imports.map(({ actionId, candidate }) => ({
              actionId,
              item: candidate.item,
            })),
          },
          actions,
          ...(publications.length > 0 ? { publications } : {}),
          afterCommit: async () => {
            try {
              await appendActivity(operationEnv, opts.storeRoot, {
                action: "scan-import",
                scope: opts.scope,
                projectDir: opts.dir,
                agents: [opts.agent],
                capabilities: [...new Set(importedItems.map((item) => item.kind))],
                affectedCount: importedItems.length,
                warningsCount: warnings.length,
                summary: `Imported ${importedItems.length} scanned ${importedItems.length === 1 ? "item" : "items"}`,
                resources: {
                  artifactIds: importedItems.map((item) => `${item.kind}/${item.name}`),
                },
                secretRefs: importedItems.flatMap((item) => item.secretRefs ?? []),
              });
            } catch (err) {
              warnings.push(
                `activity log failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          },
        };
      },
      { authorityLease },
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
    return attachProviderScope(
      {
        plan: transaction.value.plan,
        imported: transaction.value.imports
          .filter(({ actionId }) => successfulActionIds.has(actionId))
          .map(({ item }) => item),
        operation: transaction.operation,
      },
      scope,
    );
  } catch (error) {
    throw attachScopeToError(error, scope);
  }
}

async function scanProviderScope(
  env: Env,
  opts: ScanOptions,
): Promise<{ scope: ProviderScope; operationEnv: Env }> {
  const config = await loadConfig(env, opts.storeRoot);
  const scope = createProviderScope({
    secretMode: opts.secretMode ?? config.defaults.secretMode,
    vaultPassphrase: opts.vaultPassphrase,
    keychainService: opts.keychainService,
  });
  return { scope, operationEnv: withProviderScope(env, scope) };
}

function attachScopeToError(error: unknown, scope: ProviderScope): unknown {
  return typeof error === "object" && error !== null ? attachProviderScope(error, scope) : error;
}

async function scanImportFingerprint(
  _env: Env,
  payload: ScanCandidate["payload"],
): Promise<string> {
  if (payload.kind === "rules") return sha256(payload.content);
  if (payload.kind === "mcp") {
    return sha256(`${JSON.stringify(serverToRaw(payload.server), null, 2)}\n`);
  }
  return payload.snapshot.fingerprint;
}

function scanImportTarget(storeRoot: string, item: ScanItem): string {
  if (item.kind === "rules") return join(storeRoot, "store", "rules", `${item.name}.md`);
  if (item.kind === "mcp") return join(storeRoot, "store", "mcp", `${item.name}.json`);
  return join(storeRoot, "store", "skills", item.name);
}

async function scanCollectionPublication(
  env: Env,
  opts: ScanOptions,
  imported: readonly ScanItem[],
): Promise<{ path: string; data: string; mode: number }[]> {
  if (!opts.intoCollection || imported.length === 0) return [];
  const config = await loadConfig(env, opts.storeRoot);
  const next = JSON.parse(JSON.stringify(config)) as CellarerConfig;
  for (const item of imported) {
    const id = `${item.kind}/${item.name}`;
    const collections = next.artifacts[id]?.collections ?? [];
    if (!collections.includes(opts.intoCollection)) {
      next.artifacts[id] = {
        ...next.artifacts[id],
        collections: [...collections, opts.intoCollection],
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
