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
import { assertSafeAtomicPublicationPath } from "../fs/safety.js";
import { isGenerated } from "../markers.js";
import { type McpServer, serverFromRaw, serverToRaw } from "../mcp/model.js";
import type { Scope } from "../model/index.js";
import {
  assertStrictMutationPlanRuntime,
  verifyMutationPlanAuthorization,
  verifyMutationPlanDigest,
  withCurrentMutationAuthorityLease,
} from "../protocol/canonical.js";
import { CLIENT_API_MAX_REQUEST_BODY_BYTES } from "../protocol/client.js";
import type { AssertExact, ExactContract, ScanItem, ScanPlan } from "../protocol/client-types.js";
import { executeMutationPlan, invalidPlanResult, targetState } from "../protocol/execute.js";
import type {
  CanonicalJsonObject,
  CanonicalJsonValue,
  MutationPlan,
  MutationPlanAction,
  OperationActionReceipt,
  OperationResult,
  TargetStateReceipt,
} from "../protocol/models.js";
import { planStoreActionMutation } from "../protocol/store-mutation.js";
import {
  attachProviderScope,
  containsKnownSecretValue,
  createProviderScope,
  discoverActiveSecretValues,
  inventoryActiveSecretValues,
  type ProviderScope,
  providerScopeForEnv,
  withProviderScope,
} from "../secrets/active-values.js";
import {
  type SecretFinding,
  scanStructuredFileSecretFindings,
  scanTextForSecrets,
} from "../secrets/detector.js";
import { assertFinalSerializedSecretBytes } from "../secrets/final-bytes.js";
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

export type { ScanItem, ScanPlan } from "../protocol/client-types.js";

// 冲突策略:库房已有同名制品时的处理。
//   keep-theirs:用扫描来的覆盖库房(默认,"收编")。
//   keep-mine:保留库房,跳过扫描项。
//   copy:新建副本(带来源后缀)。
export type ConflictStrategy = "keep-theirs" | "keep-mine" | "copy";

export interface ScanSelection {
  kind: "rules" | "mcp" | "skills";
  name: string;
  source: string;
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
  // 精确选择完整 kind/name/source tuple；缺省导入全部发现项。
  selectItems?: ScanSelection[];
  // Provider inputs remain operation-scoped; applyScan requires every active reference.
  secretMode?: "env" | "vault" | "keychain";
  vaultPassphrase?: string;
  keychainService?: string;
}

// 内部:携带写库房所需的载荷(canonical 内容),不暴露到 ScanItem(避免真值/大对象外泄)。
interface ScanCandidate {
  item: ReturnType<typeof scanItem>;
  payload:
    | { kind: "rules"; content: string; snapshot: SafeRecursiveSnapshot }
    | { kind: "mcp"; server: McpServer; snapshot: SafeRecursiveSnapshot }
    | { kind: "skills"; snapshot: SafeRecursiveSnapshot; stagedText: string };
}

function scanItem(input: {
  kind: "rules" | "mcp" | "skills";
  name: string;
  status: "new" | "conflict";
  action: "import" | "skip";
  secretRefs?: string[];
  source: string;
}) {
  return { ...input };
}

class StructuredScanGuardError extends Error {
  constructor(readonly plan: ScanPlan) {
    super("structured scan validation failed before protocol publication");
    this.name = "StructuredScanGuardError";
  }
}

function wantCap(opts: ScanOptions, cap: "rules" | "mcp" | "skills"): boolean {
  return !opts.capabilities || opts.capabilities.includes(cap);
}

function selectionKey(item: ScanSelection): string {
  return `${item.kind}\0${item.name}\0${item.source}`;
}

function applySelect(
  candidates: ScanCandidate[],
  selectItems: ScanSelection[] | undefined,
): ScanCandidate[] {
  if (selectItems === undefined) return candidates;
  const want = new Set(selectItems.map(selectionKey));
  return candidates.filter((candidate) => want.has(selectionKey(candidate.item)));
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
          item: scanItem({
            kind: "rules",
            name: opts.agent,
            status: "new",
            action: "import",
            source: paths.rules,
          }),
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
              item: scanItem({
                kind: "mcp",
                name,
                status: "new",
                action: "import",
                source: `${paths.mcp} → ${name}`,
                secretRefs: refs.length > 0 ? refs : undefined,
              }),
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
          item: scanItem({
            kind: "skills",
            name,
            status: "new",
            action: "import",
            source: abs,
          }),
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
async function scanPlanImplementation(env: Env, opts: ScanOptions) {
  const { scope, operationEnv } = await scanProviderScope(env, opts);
  try {
    const { candidates, warnings } = await scanCandidates(operationEnv, opts);
    const selected = applySelect(candidates, opts.selectItems);
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

export async function scanPlan(env: Env, opts: ScanOptions): Promise<ScanPlan> {
  return scanPlanImplementation(env, opts);
}

export type ScanPlanProducerContract = AssertExact<
  ExactContract<Awaited<ReturnType<typeof scanPlanImplementation>>, ScanPlan>
>;
export type ScanItemProducerContract = AssertExact<
  ExactContract<ReturnType<typeof scanItem>, ScanItem>
>;

export interface ScanResult {
  plan: ScanPlan;
  imported: ScanItem[];
  operation: OperationResult;
}

export interface PlannedScanMutation {
  readonly plan: ScanPlan;
  readonly mutationPlan: MutationPlan;
}

export interface ApplyScanMutationPlanOptions {
  readonly storeRoot: string;
  readonly secretMode?: "env" | "vault" | "keychain";
  readonly vaultPassphrase?: string;
  readonly keychainService?: string;
}

interface DecodedScanAction {
  readonly action: MutationPlanAction;
  readonly item?: ScanItem;
  readonly sourcePath?: string;
  readonly sourceFingerprint?: string;
  readonly data?: string;
  readonly server?: CanonicalJsonObject;
}

interface DecodedScanMutation {
  readonly plan: ScanPlan;
  readonly projectDir?: string;
  readonly intoCollection?: string;
  readonly actions: readonly DecodedScanAction[];
}

export async function planScanMutation(env: Env, opts: ScanOptions): Promise<PlannedScanMutation> {
  return withCurrentMutationAuthorityLease(env, (authorityLease) =>
    planScanMutationWithAuthorityLease(env, opts, authorityLease),
  );
}

async function planScanMutationWithAuthorityLease(
  env: Env,
  opts: ScanOptions,
  authorityLease: MutationAuthorityLease,
  provider?: { readonly scope: ProviderScope; readonly operationEnv: Env },
): Promise<PlannedScanMutation> {
  const { scope, operationEnv } = provider ?? (await scanProviderScope(env, opts));
  const normalizedInputs: {
    scanPlan: CanonicalJsonValue;
    projectDir: CanonicalJsonValue;
    intoCollection: CanonicalJsonValue;
  } = {
    scanPlan: null,
    projectDir: opts.dir ?? null,
    intoCollection: opts.intoCollection ?? null,
  };
  try {
    const planned = await planStoreActionMutation(
      operationEnv,
      opts.storeRoot,
      "store-import",
      "scan-import",
      async () => {
        const scanned = await scanCandidates(operationEnv, opts);
        const selected = applySelect(scanned.candidates, opts.selectItems);
        if (scanned.structuredBlocked) {
          const blocked = selected.map((candidate) => ({
            ...candidate,
            item: { ...candidate.item, action: "skip" as const },
          }));
          throw new StructuredScanGuardError({
            agent: opts.agent,
            scope: opts.scope,
            items: blocked.map(({ item }) => item),
            warnings: scanned.warnings,
          });
        }
        const existing = await existingNames(operationEnv, opts.storeRoot);
        let structuredBlocked = false;
        const resolved = await guardPlaintext(
          operationEnv,
          opts,
          resolveConflicts(selected, existing, opts.conflict ?? "keep-theirs", opts.agent),
          scanned.warnings,
          true,
          () => {
            structuredBlocked = true;
          },
        );
        const scan: ScanPlan = {
          agent: opts.agent,
          scope: opts.scope,
          items: resolved.map(({ item }) => item),
          warnings: scanned.warnings,
        };
        if (structuredBlocked) throw new StructuredScanGuardError(scan);
        const imports = resolved
          .filter((candidate) => candidate.item.action === "import")
          .map((candidate, index) => ({
            actionId: `scan-${index + 1}-${candidate.item.kind}-${candidate.item.name}`,
            candidate,
            target: scanImportTarget(opts.storeRoot, candidate.item),
          }));
        const publications = await scanCollectionPublication(
          operationEnv,
          opts,
          imports.map(({ candidate }) => candidate.item),
        );
        normalizedInputs.scanPlan = jsonCanonical(scan);
        return {
          value: {
            plan: scan,
            imports: imports.map(({ actionId, candidate }) => ({
              actionId,
              item: candidate.item,
            })),
          },
          actions: await Promise.all(
            imports.map(async ({ actionId, candidate, target }) => ({
              actionId,
              kind: `scan-${candidate.item.kind}`,
              target,
              payload: scanMutationActionPayload(candidate),
              postcondition: {
                state: "present" as const,
                fingerprint: await scanImportFingerprint(operationEnv, candidate.payload),
              },
              execute: async () => executePlannedCandidate(operationEnv, opts, candidate, target),
            })),
          ),
          ...(publications.length > 0 ? { publications } : {}),
        };
      },
      {
        normalizedInputs: normalizedInputs as unknown as CanonicalJsonObject,
        selfContainedPublications: true,
      },
      { authorityLease },
    );
    if (
      new TextEncoder().encode(JSON.stringify({ mutationPlan: planned.plan })).byteLength >
      CLIENT_API_MAX_REQUEST_BODY_BYTES
    ) {
      throw new TypeError("scan mutation plan exceeds the client request body budget");
    }
    return attachProviderScope({ plan: planned.value.plan, mutationPlan: planned.plan }, scope);
  } catch (error) {
    throw attachScopeToError(error, scope);
  }
}

export async function applyScanMutationPlan(
  env: Env,
  mutationPlan: MutationPlan,
  opts: ApplyScanMutationPlanOptions,
): Promise<ScanResult> {
  try {
    assertStrictMutationPlanRuntime(mutationPlan, "store-import");
  } catch {
    return invalidScanResult();
  }
  if (
    !verifyMutationPlanAuthorization(env, opts.storeRoot, mutationPlan) ||
    !verifyMutationPlanDigest(mutationPlan)
  ) {
    return invalidScanResult();
  }
  const decoded = decodeScanMutationPlan(mutationPlan, opts.storeRoot);
  if (!decoded) return invalidScanResult();
  return withCurrentMutationAuthorityLease(env, (authorityLease) =>
    applyScanMutationPlanWithAuthorityLease(env, mutationPlan, opts, decoded, authorityLease),
  );
}

async function applyScanMutationPlanWithAuthorityLease(
  env: Env,
  mutationPlan: MutationPlan,
  opts: ApplyScanMutationPlanOptions,
  decoded: DecodedScanMutation,
  authorityLease: MutationAuthorityLease,
  provider?: { readonly scope: ProviderScope; readonly operationEnv: Env },
): Promise<ScanResult> {
  const scanOpts: ScanOptions = {
    storeRoot: opts.storeRoot,
    agent: decoded.plan.agent,
    scope: decoded.plan.scope,
    ...(decoded.projectDir ? { dir: decoded.projectDir } : {}),
    ...(opts.secretMode ? { secretMode: opts.secretMode } : {}),
    ...(opts.vaultPassphrase ? { vaultPassphrase: opts.vaultPassphrase } : {}),
    ...(opts.keychainService ? { keychainService: opts.keychainService } : {}),
  };
  const { scope, operationEnv } = provider ?? (await scanProviderScope(env, scanOpts));
  try {
    const responsePlan: ScanPlan = {
      agent: decoded.plan.agent,
      scope: decoded.plan.scope,
      items: decoded.plan.items.map((item) => ({ ...item })),
      warnings: [...decoded.plan.warnings],
    };
    const providerOptions = {
      secretMode: scanOpts.secretMode ?? scope.mode,
      vaultPassphrase: scanOpts.vaultPassphrase,
      keychainService: scanOpts.keychainService ?? scope.service,
      requireAvailable: true,
    };
    const observableTexts = decoded.actions.flatMap(({ data, server }) => [
      ...(data === undefined ? [] : [data]),
      ...(server === undefined ? [] : [JSON.stringify(server)]),
    ]);
    await discoverActiveSecretValues(
      operationEnv,
      opts.storeRoot,
      observableTexts,
      providerOptions,
    );
    await inventoryActiveSecretValues(operationEnv, opts.storeRoot, providerOptions);
    const validateSources = () => validateScanMutationSources(operationEnv, decoded.actions);
    const operation = await executeMutationPlan(
      operationEnv,
      opts.storeRoot,
      mutationPlan,
      async (_operationId, record, authorizeAction) => {
        const actionReceipts: OperationActionReceipt[] = [];
        const failedActionIds: string[] = [];
        for (const decodedAction of decoded.actions) {
          const { action } = decodedAction;
          const authorized = await authorizeAction(action.actionId);
          if (!authorized.ok) {
            actionReceipts.push(authorized.receipt);
            failedActionIds.push(action.actionId);
            break;
          }
          let failure: { readonly code: string; readonly message: string } | undefined;
          try {
            await executeDecodedScanAction(operationEnv, opts.storeRoot, decodedAction);
            await assertScanActionPostcondition(operationEnv, action);
          } catch (error) {
            const code = actionFailureCode(error);
            if (!CONTROLLED_SCAN_ACTION_CODES.has(code)) throw error;
            failure = { code, message: `filesystem action failed (${code})` };
            failedActionIds.push(action.actionId);
          }
          const after = await targetState(operationEnv, action.target);
          const receipt: OperationActionReceipt = {
            actionId: action.actionId,
            target: action.target,
            outcome: failure
              ? "failed"
              : sameTargetState(authorized.before, after)
                ? "unchanged"
                : "applied",
            before: authorized.before,
            after,
            recordedAt: operationEnv.now().toISOString(),
            ...(failure ? { error: failure } : {}),
          };
          await record(receipt);
          actionReceipts.push(receipt);
          if (failure) break;
        }
        return {
          actionReceipts,
          ...(failedActionIds.length > 0 ? { failedActionIds } : {}),
          afterCommit: async () => {
            const imported = decoded.actions.flatMap(({ item }) => (item ? [item] : []));
            await appendActivity(operationEnv, opts.storeRoot, {
              action: "scan-import",
              scope: decoded.plan.scope,
              projectDir: decoded.projectDir,
              agents: [decoded.plan.agent],
              capabilities: [...new Set(imported.map(({ kind }) => kind))],
              affectedCount: imported.length,
              warningsCount: responsePlan.warnings.length,
              summary: `Imported ${imported.length} scanned ${imported.length === 1 ? "item" : "items"}`,
              resources: { artifactIds: imported.map((item) => `${item.kind}/${item.name}`) },
              secretRefs: imported.flatMap((item) => item.secretRefs ?? []),
            }).catch((error) => {
              responsePlan.warnings.push(
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
        validateUnderLock: async () =>
          (await validateSources()) ??
          validateScanCollectionPublication(operationEnv, opts.storeRoot, decoded),
      },
    );
    const successfulActionIds = new Set(
      operation.ok
        ? operation.receipt.actionReceipts
            .filter(({ outcome }) => outcome !== "failed")
            .map(({ actionId }) => actionId)
        : (operation.journal?.actions ?? [])
            .filter(({ status }) => status === "succeeded")
            .map(({ actionId }) => actionId),
    );
    return attachProviderScope(
      {
        plan: responsePlan,
        imported: decoded.actions
          .filter(
            ({ action, item }) => item !== undefined && successfulActionIds.has(action.actionId),
          )
          .flatMap(({ item }) => (item ? [item] : [])),
        operation,
      },
      scope,
    );
  } catch (error) {
    throw attachScopeToError(error, scope);
  }
}

// applyScan remains the CLI-friendly one-shot operation, but now it composes the same exact
// serializable plan/apply boundary used by HTTP instead of scanning again during apply.
export async function applyScan(env: Env, opts: ScanOptions): Promise<ScanResult> {
  return withCurrentMutationAuthorityLease(env, async (authorityLease) => {
    try {
      const provider = await scanProviderScope(env, opts);
      const planned = await planScanMutationWithAuthorityLease(env, opts, authorityLease, provider);
      const decoded = decodeScanMutationPlan(planned.mutationPlan, opts.storeRoot);
      if (!decoded) return invalidScanResult(planned.plan);
      return await applyScanMutationPlanWithAuthorityLease(
        env,
        planned.mutationPlan,
        opts,
        decoded,
        authorityLease,
        provider,
      );
    } catch (error) {
      if (error instanceof StructuredScanGuardError) {
        return { plan: error.plan, imported: [], operation: invalidPlanResult() };
      }
      throw error;
    }
  });
}

async function executePlannedCandidate(
  env: Env,
  opts: ScanOptions,
  candidate: ScanCandidate,
  target: string,
): Promise<void> {
  if (candidate.payload.kind === "rules") {
    await assertSafeRecursiveSnapshotCurrent(env, candidate.payload.snapshot);
    await writeRuleArtifact(env, opts.storeRoot, candidate.item.name, candidate.payload.content);
  } else if (candidate.payload.kind === "mcp") {
    await assertSafeRecursiveSnapshotCurrent(env, candidate.payload.snapshot);
    await writeMcpArtifact(env, opts.storeRoot, candidate.item.name, candidate.payload.server);
  } else {
    await assertSafeRecursiveSnapshotCurrent(env, candidate.payload.snapshot);
    await installSafeRecursiveSnapshot(env, candidate.payload.snapshot, target, true);
  }
}

function scanMutationActionPayload(candidate: ScanCandidate): CanonicalJsonObject {
  const common = {
    item: jsonCanonical(candidate.item),
    kind: candidate.payload.kind,
    sourcePath: candidate.payload.snapshot.rootPath,
    sourceFingerprint: candidate.payload.snapshot.fingerprint,
  };
  if (candidate.payload.kind === "rules") {
    return {
      ...common,
      data: candidate.payload.content,
      dataDigest: sha256(candidate.payload.content),
    } as CanonicalJsonObject;
  }
  if (candidate.payload.kind === "mcp") {
    return {
      ...common,
      server: jsonCanonical(serverToRaw(candidate.payload.server)),
    } as CanonicalJsonObject;
  }
  return common as CanonicalJsonObject;
}

function decodeScanMutationPlan(
  mutationPlan: MutationPlan,
  storeRoot: string,
): DecodedScanMutation | null {
  const inputs = mutationPlan.normalizedInputs;
  if (!hasExactKeys(inputs, ["intoCollection", "mutationKind", "projectDir", "scanPlan"])) {
    return null;
  }
  if (inputs.mutationKind !== "scan-import" || !isScanPlan(inputs.scanPlan)) return null;
  if (inputs.projectDir !== null && typeof inputs.projectDir !== "string") return null;
  if (inputs.intoCollection !== null && typeof inputs.intoCollection !== "string") return null;
  const scan = inputs.scanPlan;
  const importedItems = scan.items.filter(({ action }) => action === "import");
  const expectsCollectionPublication =
    typeof inputs.intoCollection === "string" && importedItems.length > 0;
  if (
    mutationPlan.actions.length !==
    importedItems.length + (expectsCollectionPublication ? 1 : 0)
  ) {
    return null;
  }
  const actions: DecodedScanAction[] = [];
  for (const [index, item] of importedItems.entries()) {
    const action = mutationPlan.actions[index];
    if (!action || action.actionId !== `scan-${index + 1}-${item.kind}-${item.name}`) return null;
    if (
      action.kind !== `scan-${item.kind}` ||
      action.target !== scanImportTarget(storeRoot, item)
    ) {
      return null;
    }
    if (action.postcondition?.state !== "present") return null;
    const payload = action.payload;
    const commonKeys = ["item", "kind", "sourceFingerprint", "sourcePath"];
    if (
      typeof payload.sourcePath !== "string" ||
      payload.sourcePath.length === 0 ||
      typeof payload.sourceFingerprint !== "string" ||
      payload.kind !== item.kind ||
      JSON.stringify(payload.item) !== JSON.stringify(item)
    ) {
      return null;
    }
    if (item.kind === "rules") {
      if (
        !hasExactKeys(payload, [...commonKeys, "data", "dataDigest"]) ||
        typeof payload.data !== "string" ||
        typeof payload.dataDigest !== "string" ||
        sha256(payload.data) !== payload.dataDigest ||
        action.postcondition.fingerprint !== payload.dataDigest
      ) {
        return null;
      }
      actions.push({
        action,
        item,
        sourcePath: payload.sourcePath,
        sourceFingerprint: payload.sourceFingerprint,
        data: payload.data,
      });
    } else if (item.kind === "mcp") {
      if (!hasExactKeys(payload, [...commonKeys, "server"]) || !isPlainRecord(payload.server)) {
        return null;
      }
      const rendered = `${JSON.stringify(serverToRaw(serverFromRaw(payload.server)), null, 2)}\n`;
      if (action.postcondition.fingerprint !== sha256(rendered)) return null;
      actions.push({
        action,
        item,
        sourcePath: payload.sourcePath,
        sourceFingerprint: payload.sourceFingerprint,
        server: payload.server as CanonicalJsonObject,
      });
    } else {
      if (
        !hasExactKeys(payload, commonKeys) ||
        action.postcondition.fingerprint !== payload.sourceFingerprint
      ) {
        return null;
      }
      actions.push({
        action,
        item,
        sourcePath: payload.sourcePath,
        sourceFingerprint: payload.sourceFingerprint,
      });
    }
  }
  if (expectsCollectionPublication) {
    const action = mutationPlan.actions[importedItems.length];
    const target = join(storeRoot, CONFIG_FILENAME);
    if (
      action?.kind !== "publish-file" ||
      action.target !== target ||
      !action.postcondition ||
      action.postcondition.state !== "present" ||
      !hasExactKeys(action.payload, ["data", "digest", "mode", "path"]) ||
      typeof action.payload.data !== "string" ||
      typeof action.payload.digest !== "string" ||
      action.payload.path !== target ||
      action.payload.mode !== 0o600 ||
      sha256(action.payload.data) !== action.payload.digest ||
      action.postcondition.fingerprint !== action.payload.digest ||
      !collectionPublicationContains(
        action.payload.data,
        inputs.intoCollection as string,
        importedItems,
      )
    ) {
      return null;
    }
    actions.push({ action, data: action.payload.data });
  }
  return {
    plan: scan,
    ...(typeof inputs.projectDir === "string" ? { projectDir: inputs.projectDir } : {}),
    ...(typeof inputs.intoCollection === "string" ? { intoCollection: inputs.intoCollection } : {}),
    actions,
  };
}

async function validateScanMutationSources(
  env: Env,
  actions: readonly DecodedScanAction[],
): Promise<OperationResult | null> {
  const seen = new Set<string>();
  for (const { sourcePath, sourceFingerprint } of actions) {
    if (!sourcePath || !sourceFingerprint || seen.has(sourcePath)) continue;
    seen.add(sourcePath);
    let actual: TargetStateReceipt = { state: "absent" };
    try {
      const snapshot = await captureSafeRecursiveSource(env, sourcePath);
      actual = { state: "present", fingerprint: snapshot.fingerprint };
    } catch {
      // Missing or unsafe sources remain an absent observation for non-disclosing drift evidence.
    }
    if (actual.state === "present" && actual.fingerprint === sourceFingerprint) continue;
    return {
      ok: false,
      conflict: {
        code: "TARGET_PRECONDITION_CONFLICT",
        message: "source changed after planning",
        planId: "untrusted",
        actionId: "untrusted",
        target: "untrusted",
        expected: { state: "present", fingerprint: sourceFingerprint },
        actual,
      },
    };
  }
  return null;
}

async function validateScanCollectionPublication(
  env: Env,
  storeRoot: string,
  decoded: DecodedScanMutation,
): Promise<OperationResult | null> {
  if (!decoded.intoCollection) return null;
  const imported = decoded.actions.flatMap(({ item }) => (item ? [item] : []));
  if (imported.length === 0) return null;
  const publication = decoded.actions.find(({ action }) => action.kind === "publish-file");
  if (!publication?.data) return invalidPlanResult();
  const expected = await scanCollectionPublication(
    env,
    {
      storeRoot,
      agent: decoded.plan.agent,
      scope: decoded.plan.scope,
      ...(decoded.projectDir ? { dir: decoded.projectDir } : {}),
      intoCollection: decoded.intoCollection,
    },
    imported,
  );
  const exact = expected[0];
  if (
    expected.length !== 1 ||
    !exact ||
    exact.path !== publication.action.target ||
    exact.mode !== publication.action.payload.mode ||
    exact.data !== publication.data
  ) {
    return invalidPlanResult();
  }
  return null;
}

async function executeDecodedScanAction(
  env: Env,
  storeRoot: string,
  decoded: DecodedScanAction,
): Promise<void> {
  const { action, item, sourcePath, sourceFingerprint } = decoded;
  if (action.kind === "publish-file") {
    const digest = action.payload.digest;
    const mode = action.payload.mode;
    if (
      typeof decoded.data !== "string" ||
      typeof digest !== "string" ||
      typeof mode !== "number" ||
      sha256(decoded.data) !== digest
    ) {
      throw new TypeError("scan collection publication is invalid");
    }
    await assertSafeAtomicPublicationPath(env, action.target, storeRoot, "scan publication");
    assertFinalSerializedSecretBytes(
      decoded.data,
      providerScopeForEnv(env)?.knownValues ?? [],
      action.target,
    );
    await env.fs.publishFileAtomically(action.target, decoded.data, { mode });
    return;
  }
  if (!item) throw new TypeError("scan action item is invalid");
  if (!sourcePath || !sourceFingerprint) throw new TypeError("scan source is invalid");
  const snapshot = await captureSafeRecursiveSource(env, sourcePath);
  if (snapshot.fingerprint !== sourceFingerprint) throw staleScanSourceError();
  if (action.kind === "scan-rules" && decoded.data !== undefined) {
    await writeRuleArtifact(env, storeRoot, item.name, decoded.data);
    return;
  }
  if (action.kind === "scan-mcp" && decoded.server !== undefined) {
    await writeMcpArtifact(env, storeRoot, item.name, serverFromRaw(decoded.server));
    return;
  }
  if (action.kind === "scan-skills") {
    await installSafeRecursiveSnapshot(env, snapshot, action.target, true);
    return;
  }
  throw new TypeError(`unsupported scan action ${action.kind}`);
}

async function assertScanActionPostcondition(env: Env, action: MutationPlanAction): Promise<void> {
  if (!action.postcondition) throw new TypeError("scan action has no postcondition");
  const actual = await targetState(env, action.target);
  if (sameTargetState(action.postcondition, actual)) return;
  const error = new Error("scan action does not match its signed postcondition") as Error & {
    code: string;
  };
  error.code =
    action.kind === "publish-file"
      ? "PUBLICATION_POSTCONDITION_FAILED"
      : "ACTION_POSTCONDITION_FAILED";
  throw error;
}

function collectionPublicationContains(
  data: string,
  collection: string,
  items: readonly ScanItem[],
): boolean {
  try {
    const parsed = JSON.parse(data) as {
      artifacts?: Record<string, { collections?: unknown }>;
    };
    return items.every(({ kind, name }) => {
      const collections = parsed.artifacts?.[`${kind}/${name}`]?.collections;
      return Array.isArray(collections) && collections.includes(collection);
    });
  } catch {
    return false;
  }
}

function isScanPlan(value: unknown): value is ScanPlan {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["agent", "items", "scope", "warnings"])) {
    return false;
  }
  if (
    typeof value.agent !== "string" ||
    (value.scope !== "global" && value.scope !== "project") ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every((warning) => typeof warning === "string")
  ) {
    return false;
  }
  return value.items.every(isScanItem);
}

function isScanItem(value: unknown): value is ScanItem {
  if (!isPlainRecord(value)) return false;
  const keys =
    value.secretRefs === undefined
      ? ["action", "kind", "name", "source", "status"]
      : ["action", "kind", "name", "secretRefs", "source", "status"];
  return (
    hasExactKeys(value, keys) &&
    (value.kind === "rules" || value.kind === "mcp" || value.kind === "skills") &&
    typeof value.name === "string" &&
    (value.status === "new" || value.status === "conflict") &&
    (value.action === "import" || value.action === "skip") &&
    typeof value.source === "string" &&
    (value.secretRefs === undefined ||
      (Array.isArray(value.secretRefs) && value.secretRefs.every((ref) => typeof ref === "string")))
  );
}

function jsonCanonical(value: unknown): CanonicalJsonValue {
  return JSON.parse(JSON.stringify(value)) as CanonicalJsonValue;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    isPlainRecord(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

const CONTROLLED_SCAN_ACTION_CODES = new Set([
  "EACCES",
  "EDQUOT",
  "EFBIG",
  "EIO",
  "ENOSPC",
  "EPERM",
  "EROFS",
  "ESTALE",
  "PUBLICATION_POSTCONDITION_FAILED",
  "ACTION_POSTCONDITION_FAILED",
]);

function actionFailureCode(error: unknown): string {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN_IO_ERROR";
}

function sameTargetState(left: TargetStateReceipt, right: TargetStateReceipt): boolean {
  return (
    left.state === right.state &&
    (left.state === "absent" ||
      (right.state === "present" && left.fingerprint === right.fingerprint))
  );
}

function staleScanSourceError(): Error & { readonly code: string } {
  return Object.assign(new Error("scan source changed after planning"), {
    code: "ESTALE" as const,
  });
}

function invalidScanResult(plan: ScanPlan = invalidScanPlan()): ScanResult {
  return { plan, imported: [], operation: invalidPlanResult() };
}

function invalidScanPlan(): ScanPlan {
  return { agent: "untrusted", scope: "global", items: [], warnings: [] };
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
