// 密钥脱敏与引用占位符(安全红线:库房零明文)。
// 占位符两种形态:
//   ${ENV_VAR}                —— 下发默认(metamcp 风格),真值留环境变量,不落盘。
//   ${CELLARER_SECRET:<name>} —— 库房内引用,真值存 vault/keychain,绝不入库。
import { detectSecret, isPlaceholderValue } from "./detector.js";
import { parseSecretReference } from "./reference.js";

export type SecretRefKind = "env" | "vault";

export interface SecretRef {
  kind: SecretRefKind;
  name: string; // env 变量名 或 vault 密钥名
}

// 构造占位符文本。
export function envPlaceholder(varName: string): string {
  return `\${${varName}}`;
}
export function secretPlaceholder(name: string): string {
  return `\${CELLARER_SECRET:${name}}`;
}

// 解析整值占位符;非占位符返回 null(整值匹配,避免对内嵌子串误判,metamcp 风格)。
export function parseSecretRef(value: string): SecretRef | null {
  const reference = parseSecretReference(value);
  if (!reference) return null;
  return {
    kind: reference.kind === "environment" ? "env" : "vault",
    name: reference.name,
  };
}

export interface RedactResult {
  // 脱敏后的值集合(name → 占位符或原值)。
  redacted: Record<string, string>;
  // 命中的密钥引用(name → 建议引用名);供调用方提示存 vault/keychain。
  refs: { field: string; suggestedName: string; preview: string }[];
}

// 把一组 name=value 字段(mcp 的 env/headers)按检测结果脱敏为占位符。
// 命中密钥 → 替换为 ${CELLARER_SECRET:<derivedName>};未命中/已是占位符 → 原样保留。
// derivedName:scope 前缀 + 字段名归一(大写下划线),避免不同 server 同名字段碰撞。
export function redactFields(fields: Record<string, string>, scopePrefix: string): RedactResult {
  const redacted: Record<string, string> = {};
  const refs: RedactResult["refs"] = [];
  for (const [field, value] of Object.entries(fields)) {
    // 已是占位符 → 原样保留(幂等:重复脱敏不破坏)。
    if (isPlaceholderValue(value) && parseSecretRef(value)) {
      redacted[field] = value;
      continue;
    }
    const finding = detectSecret(value, field);
    if (finding) {
      const suggestedName = deriveSecretName(scopePrefix, field);
      redacted[field] = secretPlaceholder(suggestedName);
      refs.push({ field, suggestedName, preview: finding.preview });
    } else {
      redacted[field] = value;
    }
  }
  return { redacted, refs };
}

// 引用名:<prefix>_<FIELD>,统一大写 + 非字母数字转下划线。
export function deriveSecretName(prefix: string, field: string): string {
  const norm = (s: string) =>
    s
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase();
  const p = norm(prefix);
  const f = norm(field);
  return p.length > 0 ? `${p}_${f}` : f;
}
