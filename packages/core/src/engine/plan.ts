// plan:纯函数,只读 fs,产出 DistributePlan(不变量 3)。
// 分派结构(M2 重构):按 capability 查 planner 表,引擎不散写 if (cap === "rules")。
// 每个 planner 负责一种制品的「选取 → 渲染/解析 → 产出 PlanAction」,新增能力只加一张表项。
//
// op 与 method 的关系(M2 厘清):
//   - op 是「落地动作的种类」,是 apply 分派与 revert 的真相:
//       write(rules 渲染整文件) / merge|overwrite(mcp 合并) / symlink|copy(skills 目录链接) / skip。
//   - method 是用户偏好的 LinkMethod(symlink|copy),来自 CLI/per-OS/默认。
//       · rules:固定 op=write,method 仅为信息字段(rules 永远是渲染写入,不软链整文件)。
//       · skills:op 由 method 推导(symlink→op=symlink,copy→op=copy),故 per-OS method 真正影响落地。
//   - 实际落地方式(可能因 Windows 回退)记台账的 AppliedMethod,与计划 method 区分。

import { normalize } from "node:path";
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
  TargetAcknowledgement,
  TargetConflict,
  TargetOwner,
  TargetOwnershipEvidence,
} from "../model/index.js";
import { loadVault } from "../secrets/vault.js";
import { sha256 } from "../store/checksum.js";
import { type CellarerConfig, loadConfig } from "../store/config.js";
import { duplicateTargetOwnerKeys, loadLedgerForPlanning, targetKey } from "../store/ledger.js";
import {
  listMcpArtifacts,
  listRuleArtifacts,
  listSkillArtifacts,
  readRuleArtifact,
} from "../store/store.js";
import { inspectTargetOwnership } from "../target-ownership.js";
import { loadSelectedMcp, planMcp, type RenderedMcp, renderMcp } from "./mcp-plan.js";
import { dedupeCollisions } from "./plan/collision.js";
import { applySecretScanGuard } from "./plan/secret-guard.js";
import { planSkills } from "./skills-plan.js";
import type { DistributeOptions } from "./types.js";

// 制品是否命中选中 collection:制品无标签 → 视为属于默认 collection(宽松),命中任一选中 collection 即可。
// 导出供 CLI(ls)复用,避免匹配规则在 core/CLI 各写一份(不变量 1)。
export function inCollections(artifactCollections: string[], selected: string[]): boolean {
  if (artifactCollections.length === 0) return true;
  return artifactCollections.some((collection) => selected.includes(collection));
}

// planner 的共享上下文:在 plan() 顶层一次性准备好(各 agent 共享),避免 N×M 重复读。
interface PlanContext {
  env: Env;
  opts: DistributeOptions;
  config: CellarerConfig;
  method: LinkMethod;
  selectedRules: Artifact[];
  ruleFragments: RuleFragment[];
  selectedMcp: Artifact[];
  // mcp 密钥渲染与 agent 无关,顶层渲染一次共享(含 vault 单次解密)。
  renderedMcp: RenderedMcp;
  selectedSkills: Artifact[];
}

// 一个 capability planner:为单个 (agent, scope) 产出零或多个 PlanAction。
type CapabilityPlanner = (ctx: PlanContext, adapter: AgentAdapter) => Promise<PlanAction[]>;

// capability → planner 分派表(不变量 4 的引擎侧落地:新增能力加表项,不改控制流)。
const PLANNERS: Record<Capability, CapabilityPlanner> = {
  rules: planRulesCapability,
  mcp: planMcpCapability,
  skills: planSkillsCapability,
};

export async function plan(env: Env, opts: DistributeOptions): Promise<DistributePlan> {
  const warnings: string[] = [];
  const actions: PlanAction[] = [];
  const conflicts: TargetConflict[] = [];

  // 库房配置与制品独立读取并行(config.json / rules / mcp / skills)。
  const [config, registry, ruleArtifacts, mcpArtifacts, skillArtifacts, ledger] = await Promise.all(
    [
      loadConfig(env, opts.storeRoot),
      loadRegistry(env, opts.storeRoot),
      listRuleArtifacts(env, opts.storeRoot),
      listMcpArtifacts(env, opts.storeRoot),
      listSkillArtifacts(env, opts.storeRoot),
      loadLedgerForPlanning(env, opts.storeRoot),
    ],
  );
  warnings.push(...registry.warnings);

  const collections = opts.collections ?? config.defaults.collections;
  // 优先级:CLI --method > 按 OS 覆盖([defaults.os.<platform>]) > 全局默认。
  // (Windows 软链需特权,init 默认写 [defaults.os.win32].method=copy,此处必须实际生效。)
  const osMethod = config.defaults.os?.[env.platform as "win32" | "darwin" | "linux"]?.method;
  const method = opts.method ?? osMethod ?? config.defaults.method;
  const capabilities: Capability[] = opts.capabilities ?? ["rules"];

  // collection 过滤(三类制品共用 inCollections;制品无标签视为命中)。
  const inSel = (id: string) => inCollections(config.artifacts[id]?.collections ?? [], collections);
  const selectedRules = ruleArtifacts.filter((a) => inSel(a.id));
  const selectedMcp = mcpArtifacts.filter((a) => inSel(a.id));
  const selectedSkills = skillArtifacts.filter((a) => inSel(a.id));

  // 各 agent 共享同一份制品内容,避免按 agent 重复读(N×M → M)。
  const [ruleFragments, mcpServers] = await Promise.all([
    Promise.all(selectedRules.map((a) => readRuleArtifact(env, opts.storeRoot, a.id))),
    loadSelectedMcp(env, opts.storeRoot, selectedMcp),
  ]);

  // vault 单次解密(仅 vault 模式且需要时):传给 mcp 渲染,避免每字段/每 agent 重复 scrypt 解密。
  const secretMode = opts.secretMode ?? config.defaults.secretMode;
  const vaultData =
    secretMode === "vault" && opts.vaultPassphrase && selectedMcp.length > 0
      ? await loadVault(env, opts.storeRoot, opts.vaultPassphrase)
      : undefined;

  // mcp 密钥渲染与 agent 无关,顶层渲染一次(含意外/故意明文标记 + 解析失败告警),各 agent 共享。
  const renderedMcp = await renderMcp({
    env,
    storeRoot: opts.storeRoot,
    servers: mcpServers,
    secretMode,
    vaultPassphrase: opts.vaultPassphrase,
    vaultData,
  });
  warnings.push(...renderedMcp.warnings);

  const ctx: PlanContext = {
    env,
    opts,
    config,
    method,
    selectedRules,
    ruleFragments,
    selectedMcp,
    renderedMcp,
    selectedSkills,
  };

  for (const agentId of opts.agents) {
    const adapter = registry.get(agentId);
    if (!adapter) {
      warnings.push(`unknown agent "${agentId}" — skipped`);
      continue;
    }
    // agents.<id>.enabled = false → 显式禁用,跳过该 agent 的全部能力。
    if (config.agents[agentId]?.enabled === false) {
      warnings.push(`agent "${agentId}" is disabled in config.json — skipped`);
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
      // planner 内 adapter.paths() 可能抛(如配置模板越界 expand,§6.6 分享场景)。
      // 隔离到 agent+capability 粒度:转 skip + 告警,不让一个坏适配器炸掉整批下发。
      try {
        actions.push(...(await PLANNERS[cap](ctx, adapter)));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`agent "${agentId}" ${cap} planning failed — skipped: ${msg}`);
        const skip = skipAction(agentId, cap, opts.scope, method);
        skip.reason = msg;
        actions.push(skip);
      }
    }
  }

  // 目标去冲突:多 agent 可能映射到同一物理文件(pass 抽到 plan/collision.ts)。
  dedupeCollisions(actions, warnings);

  // 所有 capability 共用同一 target ownership 判定与显式授权协议，避免 planner 各自漂移。
  const duplicateOwnerKeys = duplicateTargetOwnerKeys(ledger.owners);
  addDuplicateOwnerConflicts(ledger.owners, duplicateOwnerKeys, conflicts);
  await classifyPlannedTargets(env, opts, ledger.owners, actions, conflicts);

  // 统一 secret-scan 护栏,覆盖所有能力与所有 scope(pass 抽到 plan/secret-guard.ts)。
  applySecretScanGuard(actions, opts.scope);

  return {
    actions,
    warnings,
    conflicts,
    ...(duplicateOwnerKeys.length > 0 ? { invalidLedger: true as const } : {}),
  };
}

function addDuplicateOwnerConflicts(
  owners: readonly TargetOwner[],
  duplicateOwnerKeys: readonly string[],
  conflicts: TargetConflict[],
): void {
  const duplicateKeys = new Set(duplicateOwnerKeys);
  const emitted = new Set<string>();
  for (const owner of owners) {
    const key = targetKey(owner);
    if (!duplicateKeys.has(key) || emitted.has(key)) continue;
    emitted.add(key);
    const target = normalize(owner.target);
    conflicts.push({
      code: "INVALID_TARGET_OWNER",
      target,
      message: `duplicate current owners for canonical target "${target}"`,
      ownership: {
        key,
        classification: "invalid-owner",
        target,
        currentFingerprint: null,
        expectedReceipt: null,
      },
    });
  }
}

async function classifyPlannedTargets(
  env: Env,
  opts: DistributeOptions,
  owners: readonly TargetOwner[],
  actions: PlanAction[],
  conflicts: TargetConflict[],
): Promise<void> {
  for (const action of actions) {
    if (action.op === "skip" || action.target.length === 0) continue;
    const inspection = await inspectTargetOwnership(env, {
      agent: action.agent,
      scope: action.scope,
      capability: action.capability,
      target: action.target,
      dir: opts.dir,
      owners,
    });
    const ownership: TargetOwnershipEvidence = {
      key: targetKey(action),
      classification: inspection.classification,
      target: inspection.target,
      currentFingerprint: inspection.fingerprint,
      expectedReceipt: inspection.owner?.receipt ?? null,
    };
    action.target = inspection.target;
    action.ownership = ownership;

    if (inspection.classification === "absent" || inspection.classification === "owned-current") {
      continue;
    }

    // before 可能来自用户文件并含明文凭据；冲突证据只暴露指纹，不把 payload 放进 plan 输出。
    if (action.preview) action.preview.before = undefined;

    if (inspection.classification === "invalid-owner") {
      blockAction(action, inspection.reason ?? "target ownership is invalid");
      if (
        !conflicts.some(
          (conflict) =>
            conflict.code === "INVALID_TARGET_OWNER" && conflict.ownership.key === ownership.key,
        )
      ) {
        conflicts.push({
          code: "INVALID_TARGET_OWNER",
          target: action.target,
          message: action.reason ?? "target ownership is invalid",
          ownership,
        });
      }
      continue;
    }

    const acknowledgement = targetAcknowledgement(action, ownership);
    const input =
      inspection.classification === "unowned-existing" ? opts.replaceUnowned : opts.overrideDrift;
    const approved = input?.includes(acknowledgement.token) === true;
    if (!approved) {
      const message =
        inspection.classification === "unowned-existing"
          ? "existing target is not owned by cellarer; exact replacement acknowledgement required"
          : "owned target has drifted; exact drift acknowledgement required";
      blockAction(action, message);
      conflicts.push({
        code:
          inspection.classification === "unowned-existing"
            ? "UNOWNED_TARGET"
            : "OWNED_TARGET_DRIFTED",
        target: action.target,
        message,
        ownership,
        acknowledgement,
      });
      continue;
    }

    if (!opts.snapshotPassphrase) {
      const message = "approved replacement requires an encrypted snapshot passphrase";
      blockAction(action, message);
      conflicts.push({
        code: "SNAPSHOT_ENCRYPTION_REQUIRED",
        target: action.target,
        message,
        ownership,
        acknowledgement,
      });
      continue;
    }

    action.replacement = { acknowledgement, snapshotRequired: true };
  }
}

function targetAcknowledgement(
  action: PlanAction,
  ownership: TargetOwnershipEvidence,
): TargetAcknowledgement {
  const kind =
    ownership.classification === "unowned-existing" ? "replace-unowned" : "override-drift";
  return {
    kind,
    token: sha256(
      JSON.stringify({
        version: 1,
        kind,
        key: ownership.key,
        classification: ownership.classification,
        currentFingerprint: ownership.currentFingerprint,
        expectedReceipt: ownership.expectedReceipt,
        artifactIds: action.artifactIds ?? [],
      }),
    ),
  };
}

function blockAction(action: PlanAction, reason: string): void {
  action.op = "skip";
  action.reason = reason;
  // A merge preview can contain payload copied from an existing, user-owned target. Once the
  // ownership gate blocks the action, later secret scanning intentionally skips it, so retain only
  // the ownership fingerprint/conflict evidence and suppress both sides of the preview.
  action.preview = undefined;
}

function skipAction(
  agentId: string,
  cap: Capability,
  scope: PlanAction["scope"],
  method: LinkMethod,
): PlanAction {
  return {
    artifact: `${cap}/*`,
    artifactIds: [],
    agent: agentId,
    scope,
    capability: cap,
    target: "",
    method,
    op: "skip",
    reason: `capability ${cap}/${scope} not supported`,
  };
}

// rules planner:把单个 PlanAction(或无)包成数组,适配 planner 表签名。
async function planRulesCapability(ctx: PlanContext, adapter: AgentAdapter): Promise<PlanAction[]> {
  const action = await planRules(
    ctx.env,
    ctx.opts,
    adapter,
    ctx.selectedRules,
    ctx.ruleFragments,
    ctx.method,
  );
  return action ? [action] : [];
}

// mcp planner:委托 engine/mcp-plan(密钥已在顶层渲染好;此处只做 per-agent merge)。
// 合并策略优先级:CLI --mcp-overwrite > agents.<id>.mcp.mergeStrategy > adapter 默认。
function planMcpCapability(ctx: PlanContext, adapter: AgentAdapter): Promise<PlanAction[]> {
  const perAgent = ctx.config.agents[adapter.id]?.mcp?.mergeStrategy;
  return planMcp(
    {
      env: ctx.env,
      scope: ctx.opts.scope,
      dir: ctx.opts.dir,
      selectedMcp: ctx.selectedMcp,
      rendered: ctx.renderedMcp,
      strategyOverride: ctx.opts.mcpStrategy ?? perAgent,
    },
    adapter,
  );
}

// skills planner:委托 engine/skills-plan(目录级 link/copy,op 由 method 推导)。
async function planSkillsCapability(
  ctx: PlanContext,
  adapter: AgentAdapter,
): Promise<PlanAction[]> {
  return planSkills(
    {
      env: ctx.env,
      scope: ctx.opts.scope,
      dir: ctx.opts.dir,
      selectedSkills: ctx.selectedSkills,
      method: ctx.method,
    },
    adapter,
  );
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
    artifactIds: selectedRules.map((artifact) => artifact.id),
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
