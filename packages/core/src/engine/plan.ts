// plan:纯函数,只读 fs,产出 DistributePlan(不变量 3)。
// M1 仅处理 rules:把选中 channel 的 rule 制品按字母序 concat 渲染为 agent 原生文件。

import { loadRegistry } from "../adapters/registry.js";
import type { AgentAdapter, RuleFragment } from "../adapters/types.js";
import type { Env } from "../env.js";
import { readFileOrNull } from "../fs/probe.js";
import type {
  Artifact,
  Capability,
  DistributePlan,
  LinkMethod,
  PlanAction,
} from "../model/index.js";
import { loadConfig } from "../store/config.js";
import { listRuleArtifacts, readRuleArtifact } from "../store/store.js";
import type { DistributeOptions } from "./types.js";

// 制品是否命中选中通道:制品无标签 → 视为属于默认通道(宽松),命中任一选中通道即可。
// 导出供 CLI(ls)复用,避免通道匹配规则在 core/CLI 各写一份(不变量 1)。
export function inChannels(artifactChannels: string[], selected: string[]): boolean {
  if (artifactChannels.length === 0) return true;
  return artifactChannels.some((c) => selected.includes(c));
}

export async function plan(env: Env, opts: DistributeOptions): Promise<DistributePlan> {
  const warnings: string[] = [];
  const actions: PlanAction[] = [];

  // 三处独立读取并行(cellarer.toml / adapters 目录 / store/rules)。
  const [config, registry, ruleArtifacts] = await Promise.all([
    loadConfig(env, opts.storeRoot),
    loadRegistry(env, opts.storeRoot, opts.dir),
    listRuleArtifacts(env, opts.storeRoot),
  ]);
  warnings.push(...registry.warnings);

  const channels = opts.channels ?? config.defaults.channels;
  // 优先级:CLI --method > 按 OS 覆盖([defaults.os.<platform>]) > 全局默认。
  // (Windows 软链需特权,init 默认写 [defaults.os.win32].method=copy,此处必须实际生效。)
  const osMethod = config.defaults.os?.[env.platform as "win32" | "darwin" | "linux"]?.method;
  const method = opts.method ?? osMethod ?? config.defaults.method;
  const capabilities: Capability[] = opts.capabilities ?? ["rules"];

  // 选中(按字母序,渲染顺序确定 → 幂等)并一次性读取 fragment ——
  // 各 agent 共享同一份 fragment,避免按 agent 重复读(N×M → M)。
  const selectedRules = ruleArtifacts.filter((a) =>
    inChannels(config.artifacts[a.id]?.channels ?? [], channels),
  );
  const ruleFragments: RuleFragment[] = await Promise.all(
    selectedRules.map((a) => readRuleArtifact(env, opts.storeRoot, a.id)),
  );

  for (const agentId of opts.agents) {
    const adapter = registry.get(agentId);
    if (!adapter) {
      warnings.push(`unknown agent "${agentId}" — skipped`);
      continue;
    }

    for (const cap of capabilities) {
      const supportedScopes = adapter.capabilities[cap] ?? [];
      if (!supportedScopes.includes(opts.scope)) {
        warnings.push(
          `agent "${agentId}" does not support ${cap} in ${opts.scope} scope — skipped`,
        );
        actions.push(skipAction(agentId, cap, opts.scope, method));
        continue;
      }

      // M1 仅 rules;M2 加 mcp/skills 时此处按 cap 扩展。
      if (cap === "rules") {
        const action = await planRules(env, opts, adapter, selectedRules, ruleFragments, method);
        if (action) actions.push(action);
      }
    }
  }

  // 目标去冲突:多 agent 可能映射到同一物理文件(如 codex 与 agents-md 的 project AGENTS.md)。
  // 同一 target 的写入只保留首个,其余转 skip + 告警 —— 否则两条台账指向一个文件,
  // 破坏 per-agent revert(先 revert 者删文件,后者变 missing)。
  const claimed = new Map<string, string>(); // target → 首个占用的 agent
  for (const a of actions) {
    if (a.op === "skip" || a.target === "") continue;
    const owner = claimed.get(a.target);
    if (owner === undefined) {
      claimed.set(a.target, a.agent);
      continue;
    }
    warnings.push(
      `agent "${a.agent}" ${a.capability} target collides with "${owner}" at ${a.target} — skipped`,
    );
    a.op = "skip";
    a.reason = `target already claimed by "${owner}"`;
  }

  return { actions, warnings };
}

function skipAction(
  agentId: string,
  cap: Capability,
  scope: PlanAction["scope"],
  method: LinkMethod,
): PlanAction {
  return {
    artifact: `${cap}/*`,
    agent: agentId,
    scope,
    capability: cap,
    target: "",
    method,
    op: "skip",
    reason: `capability ${cap}/${scope} not supported`,
  };
}

// 注:fragment 已在外层读好(各 agent 共享);此处解析 target、渲染、读 before(per-agent 差异)。
async function planRules(
  env: Env,
  opts: DistributeOptions,
  adapter: AgentAdapter,
  selectedRules: Artifact[],
  fragments: RuleFragment[],
  method: LinkMethod,
): Promise<PlanAction | null> {
  const target = adapter.paths(env, opts.scope, opts.dir).rules;
  if (!target || !adapter.rules || fragments.length === 0) return null;

  const after = adapter.rules.render(fragments);
  // before 是 per-agent 差异:既供 dry-run diff,也是 apply 幂等短路的依据。
  const before = (await readFileOrNull(env, target)) ?? undefined;

  return {
    // rules 是聚合制品,artifact 标 "rules/*" 并在 reason 列出参与的制品。
    artifact: "rules/*",
    agent: adapter.id,
    scope: opts.scope,
    capability: "rules",
    target,
    method,
    // rules 落地是「渲染 concat 写入」,固定 op=write(非软链整文件)。
    op: "write",
    reason: selectedRules.map((a) => a.id).join(", "),
    preview: { before, after },
  };
}
