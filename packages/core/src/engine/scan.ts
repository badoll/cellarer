// scan(扫描回写,kickoff §9):下发的逆向 —— 把 agent/目录里已有的 rules/mcp/skills 收进库房。
// 流程:读目标现有配置 → 规范化为 canonical → 脱敏(密钥→占位符)→ 与库房 diff → 冲突策略 → 写库房。
//
// 关键约束:
//   - 零明文(红线):mcp 的 env/headers 真值在「入库前」用 redactFields 换占位符,真值绝不进库房。
//   - 不吸收自身下发物:靠台账 target + 产物指纹(rules 首行 marker / mcp server 名匹配库房制品)双保险,
//     避免把 cellarer 自己写的内容当用户新增重复收编。
//   - plan/apply 分离:scanPlan 只读 + 产出计划;applyScan 才写库房。
import { loadRegistry } from "../adapters/registry.js";
import type { Env } from "../env.js";
import { lstatOrNull, readdirOrEmpty, readFileOrNull } from "../fs/probe.js";
import { isGenerated } from "../markers.js";
import { type McpServer, serverToRaw } from "../mcp/model.js";
import type { Scope } from "../model/index.js";
import { type SecretFinding, scanTextForSecrets } from "../secrets/detector.js";
import { redactFields } from "../secrets/redactor.js";
import { tagArtifactChannels } from "../store/config.js";
import {
  importSkillArtifact,
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

export interface ScanOptions {
  storeRoot: string;
  agent: string;
  scope: Scope;
  dir?: string;
  // 入库目标通道(写 config.json 的 artifacts 标签)。
  intoChannel?: string;
  conflict?: ConflictStrategy;
  // 仅扫描这些能力(缺省三类全扫)。
  capabilities?: ("rules" | "mcp" | "skills")[];
  // 仅导入这些制品名(按扫描发现的原始 name 匹配;缺省导入全部发现项)。非交互选择入口。
  select?: string[];
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
    | { kind: "rules"; content: string }
    | { kind: "mcp"; server: McpServer }
    | { kind: "skills"; srcDir: string };
}

function wantCap(opts: ScanOptions, cap: "rules" | "mcp" | "skills"): boolean {
  return !opts.capabilities || opts.capabilities.includes(cap);
}

// --select 过滤:仅保留发现名在 select 内的候选(缺省全留)。在冲突裁决前按原始名过滤。
function applySelect(candidates: ScanCandidate[], select: string[] | undefined): ScanCandidate[] {
  if (!select || select.length === 0) return candidates;
  const want = new Set(select);
  return candidates.filter((c) => want.has(c.item.name));
}

// —— 扫描(只读)：产出候选 —— //
async function scanCandidates(
  env: Env,
  opts: ScanOptions,
): Promise<{ candidates: ScanCandidate[]; warnings: string[] }> {
  const warnings: string[] = [];
  const registry = await loadRegistry(env, opts.storeRoot);
  warnings.push(...registry.warnings);
  const adapter = registry.get(opts.agent);
  if (!adapter) {
    warnings.push(`unknown agent "${opts.agent}" — nothing to scan`);
    return { candidates: [], warnings };
  }
  const paths = adapter.paths(env, opts.scope, opts.dir);
  const candidates: ScanCandidate[] = [];

  // rules:读 agent 原生 rules 文件;cellarer 生成物(首行 marker)跳过,不回收自身。
  if (wantCap(opts, "rules") && paths.rules) {
    const content = await readFileOrNull(env, paths.rules);
    if (content !== null && content.trim().length > 0) {
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
          payload: { kind: "rules", content },
        });
      }
    }
  }

  // mcp:decode agent 原生 mcp 文件 → canonical servers;脱敏 env/headers。
  if (wantCap(opts, "mcp") && paths.mcp && adapter.mcp) {
    const content = await readFileOrNull(env, paths.mcp);
    if (content !== null && content.trim().length > 0) {
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
            payload: { kind: "mcp", server: redacted },
          });
        }
      } catch (err) {
        warnings.push(
          `failed to parse mcp at ${paths.mcp}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // skills:列 agent skills 目录;软链(多半是 cellarer/共享池指向真源)跳过,只收真实目录。
  if (wantCap(opts, "skills") && paths.skillsDir) {
    const entries = await readdirOrEmpty(env, paths.skillsDir);
    for (const name of entries.sort()) {
      const abs = `${paths.skillsDir}/${name}`;
      const st = await lstatOrNull(env, abs);
      if (!st?.isDirectory() || st.isSymbolicLink()) continue; // 软链/非目录跳过
      candidates.push({
        item: { kind: "skills", name, status: "new", action: "import", source: abs },
        payload: { kind: "skills", srcDir: abs },
      });
    }
  }

  return { candidates, warnings };
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
    return []; // skills 是目录拷贝,不在此扫(目录内容护栏留 M4)。
  }
  return scanTextForSecrets(text);
}

// 对已裁决的候选施加写前明文护栏:仍含明文者转 skip 并记原因/告警。
// 集中一处,scanPlan 与 applyScan 共用 → 预览与落地裁决一致。
function guardPlaintext(resolved: ScanCandidate[], warnings: string[]): ScanCandidate[] {
  return resolved.map((c) => {
    if (c.item.action !== "import") return c;
    const hits = plaintextInStorePayload(c);
    if (hits.length === 0) return c;
    warnings.push(
      `secret-scan: refusing to import ${c.item.kind}/${c.item.name} — plaintext secret(s) [${hits
        .map((h) => h.rule)
        .join(", ")}] could not be auto-redacted (${c.item.source})`,
    );
    return { ...c, item: { ...c.item, action: "skip", status: c.item.status } };
  });
}

// 扫描计划(只读):读目标 → 脱敏 → 冲突裁决 → 写前护栏 → 候选清单。不写库房。
export async function scanPlan(env: Env, opts: ScanOptions): Promise<ScanPlan> {
  const { candidates, warnings } = await scanCandidates(env, opts);
  const selected = applySelect(candidates, opts.select);
  const existing = await existingNames(env, opts.storeRoot);
  const resolved = guardPlaintext(
    resolveConflicts(selected, existing, opts.conflict ?? "keep-theirs", opts.agent),
    warnings,
  );
  return {
    agent: opts.agent,
    scope: opts.scope,
    items: resolved.map((c) => c.item),
    warnings,
  };
}

export interface ScanResult {
  plan: ScanPlan;
  imported: ScanItem[];
}

// applyScan:执行扫描计划,把 action==="import" 的候选写库房(已脱敏 + 过写前护栏)。
export async function applyScan(env: Env, opts: ScanOptions): Promise<ScanResult> {
  const { candidates, warnings } = await scanCandidates(env, opts);
  const selected = applySelect(candidates, opts.select);
  const existing = await existingNames(env, opts.storeRoot);
  const resolved = guardPlaintext(
    resolveConflicts(selected, existing, opts.conflict ?? "keep-theirs", opts.agent),
    warnings,
  );

  const imported: ScanItem[] = [];
  for (const c of resolved) {
    if (c.item.action !== "import") continue;
    if (c.payload.kind === "rules") {
      await writeRuleArtifact(env, opts.storeRoot, c.item.name, c.payload.content);
    } else if (c.payload.kind === "mcp") {
      await writeMcpArtifact(env, opts.storeRoot, c.item.name, c.payload.server);
    } else {
      await importSkillArtifact(env, opts.storeRoot, c.item.name, c.payload.srcDir);
    }
    imported.push(c.item);
  }

  // --into-channel:给本次导入的制品打通道标签。
  if (opts.intoChannel && imported.length > 0) {
    const ids = imported.map((i) => `${i.kind}/${i.name}`);
    await tagArtifactChannels(env, opts.storeRoot, ids, opts.intoChannel);
  }

  return {
    plan: { agent: opts.agent, scope: opts.scope, items: resolved.map((c) => c.item), warnings },
    imported,
  };
}
