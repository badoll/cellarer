// 密钥解析(下发期):占位符 → 真值,来源分层(env / vault / keychain)。
// 安全约束:解析只在「必须明文」的 agent 落地路径上发生;默认下发保留 ${ENV_VAR} 不解析(零落盘)。
// 日志/错误绝不回显真值(用 [REDACTED] / 引用名)。
import type { SecretObservationUseCaseInput } from "./active-values.js";
import { createSecretValue, type SecretValue } from "./observable.js";
import { parseSecretRef, type SecretRef } from "./redactor.js";
import type { SecretMode } from "./types.js";

// 解析所需的密钥来源(按 mode 注入,避免下发期总是要口令)。
export interface SecretSources {
  mode: SecretMode;
  // vault 模式:解密口令(经此注入,不从 process.env 直读)。
  vaultPassphrase?: string;
  // keychain 服务名(SecretStore.get 的 service 参数)。
  keychainService?: string;
}

// 解析结果:成功带真值;失败带原因(供护栏/CLI 决策,绝不含真值)。
export interface ResolveOutcome {
  resolved: boolean;
  value?: SecretValue;
  reason?: string;
}

// 解析单个占位符值。
// - env 引用 ${VAR}:始终从 Env.env 取(与 mode 无关,metamcp 风格)。
// - ${CELLARER_SECRET:name}:按 mode 从 vault / keychain 取真值。
// 非占位符(已是明文或普通值)→ 原样返回(resolved:true)。
export async function resolveSecretValue(
  input: SecretObservationUseCaseInput,
  storeRoot: string,
  value: string,
  sources: SecretSources,
): Promise<ResolveOutcome> {
  const ref = parseSecretRef(value);
  if (!ref) return { resolved: true, value: createSecretValue(value) };

  if (ref.kind === "env") {
    const real = input.environment[ref.name];
    if (real === undefined || real.length === 0) {
      return { resolved: false, reason: `env var "${ref.name}" not set` };
    }
    return { resolved: true, value: createSecretValue(real) };
  }

  // vault 引用:按 mode 决定来源。
  return resolveVaultRef(input, storeRoot, ref, sources);
}

async function resolveVaultRef(
  input: SecretObservationUseCaseInput,
  storeRoot: string,
  ref: SecretRef,
  sources: SecretSources,
): Promise<ResolveOutcome> {
  if (sources.mode === "keychain") {
    if (input.useCase !== "keychain-get" && input.useCase !== "keychain-inventory") {
      return { resolved: false, reason: "keychain unavailable (no keychain get port injected)" };
    }
    if (!input.observation.keychainAvailable()) {
      return { resolved: false, reason: "keychain unavailable (no SecretStore injected)" };
    }
    const service = sources.keychainService ?? "cellarer";
    let got: Awaited<ReturnType<typeof input.observation.getKeychain>>;
    try {
      got = await input.observation.getKeychain(service, ref.name);
    } catch {
      return { resolved: false, reason: `keychain provider unavailable for "${ref.name}"` };
    }
    if (!got.found) {
      return { resolved: false, reason: `keychain has no entry for "${ref.name}"` };
    }
    return { resolved: true, value: got.value };
  }

  // 默认走 vault(mode env 也允许显式 vault 引用解密)。
  // 每个 operation 的调用方在更外层 provider scope 中负责去重加载。
  let vault: Record<string, string>;
  if (sources.vaultPassphrase) {
    if (input.useCase !== "vault-read") {
      return { resolved: false, reason: "vault unavailable (no vault read port injected)" };
    }
    vault = await input.observation.loadVault(storeRoot, sources.vaultPassphrase);
  } else {
    return { resolved: false, reason: "vault passphrase not provided" };
  }
  const real = vault[ref.name];
  if (real === undefined)
    return { resolved: false, reason: `vault has no entry for "${ref.name}"` };
  return { resolved: true, value: createSecretValue(real) };
}

// 批量解析一组字段(mcp 的 env/headers)。任一解析失败 → unresolved 收集,调用方决定降级或中止。
export async function resolveFields(
  input: SecretObservationUseCaseInput,
  storeRoot: string,
  fields: Record<string, string>,
  sources: SecretSources,
): Promise<{
  resolved: Record<string, string | SecretValue>;
  unresolved: { field: string; reason: string }[];
}> {
  const resolved: Record<string, string | SecretValue> = {};
  const unresolved: { field: string; reason: string }[] = [];
  for (const [field, value] of Object.entries(fields)) {
    const outcome = await resolveSecretValue(input, storeRoot, value, sources);
    if (outcome.resolved && outcome.value !== undefined) {
      resolved[field] = outcome.value;
    } else {
      // 解析失败:保留原占位符(不落明文),记 unresolved。
      resolved[field] = value;
      unresolved.push({ field, reason: outcome.reason ?? "unknown" });
    }
  }
  return { resolved, unresolved };
}
