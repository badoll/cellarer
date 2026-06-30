// 密钥检测(借 gitleaks,两段式;见计划 §7.6)。支撑安全红线「落盘无明文」。
// 用途:(a) 扫描回写前对 env/headers 值做脱敏判定;(b) 下发前 secret-scan 护栏扫描渲染文本。
// 纯函数(node:crypto 不需要,熵自己算),无副作用,不读 Env。

export type SecretSeverity = "high" | "warning";

export interface SecretFinding {
  // 命中的变量名(字段名场景)或 undefined(纯值/文本扫描)。
  name?: string;
  // 命中片段的预览(脱敏:只示意前缀,绝不回显完整真值)。
  preview: string;
  severity: SecretSeverity;
  // 命中规则标识,便于排查与测试断言。
  rule: string;
}

// 高精确:变量名正则(命中即视为密钥字段)。借 gitleaks 命名启发式。
// 注:用 `authorization`(完整词,匹配 HTTP 头)而非裸 `auth` —— 后者会误伤 AUTH_URL/AUTH_TYPE 等非密钥字段。
const SECRET_NAME_RE =
  /(^|[_-])(api[_-]?keys?|secret|secrets|token|tokens|password|passwd|pwd|credential|creds|authorization|access[_-]?key|private[_-]?key|bearer|client[_-]?secret)($|[_-])/i;

// 高精确:具名前缀/格式(命中即拦截)。值层面强信号。
const HIGH_VALUE_RULES: { rule: string; re: RegExp }[] = [
  { rule: "github-pat", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { rule: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: "anthropic-key", re: /\bsk-ant-[0-9A-Za-z_-]{20,}\b/ },
  { rule: "openai-key", re: /\bsk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}\b/ },
  { rule: "openai-key-generic", re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { rule: "slack-bot-token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { rule: "gitlab-pat", re: /\bglpat-[0-9A-Za-z_-]{20,}\b/ },
  { rule: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { rule: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { rule: "pem-private-key", re: /-----BEGIN[A-Z ]*PRIVATE KEY-----/ },
];

// 白名单降噪:占位符 / 示例值 / 空 / 纯布尔数字 → 不告警。
// 注:已是 ${ENV_VAR} / ${CELLARER_SECRET:..} 的整值占位符不算明文(下发默认形态)。
const PLACEHOLDER_RE = /^\s*\$\{[^}]+\}\s*$/;
const EXAMPLE_VALUES = new Set([
  "changeme",
  "change-me",
  "example",
  "examplekey",
  "your-api-key",
  "your_api_key",
  "xxx",
  "xxxx",
  "todo",
  "placeholder",
  "redacted",
  "none",
  "null",
]);

// 整值是否为占位符 / 示例 / 无意义(不视为明文密钥)。
export function isPlaceholderValue(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return true;
  if (PLACEHOLDER_RE.test(v)) return true;
  if (/^<.*>$/.test(v)) return true; // <your-token>
  if (/^(true|false|\d+(\.\d+)?)$/i.test(v)) return true; // 纯布尔/数字
  if (EXAMPLE_VALUES.has(v.toLowerCase())) return true;
  return false;
}

// Shannon 熵(bits/char)。高熵兜底用。
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// 值预览脱敏:只保留前若干字符示意,其余打码,绝不回显完整真值。
function preview(value: string): string {
  const v = value.trim();
  if (v.length <= 4) return "****";
  return `${v.slice(0, 4)}…(${v.length} chars)`;
}

// 第二段兜底:高熵长串(疑似密钥)。命中标 warning。
// base64-ish 熵≥4.0 或 hex 熵≥3.0,长度≥20;过滤明显非密钥(URL/路径/含空格句子)。
function looksHighEntropy(value: string): boolean {
  const v = value.trim();
  if (v.length < 20) return false;
  if (/\s/.test(v)) return false; // 含空白 → 多半是句子/路径
  if (/^https?:\/\//i.test(v)) return false; // URL 不算
  const isTokenish = /^[A-Za-z0-9+/_=-]+$/.test(v);
  if (!isTokenish) return false;
  const h = shannonEntropy(v);
  const isHex = /^[0-9a-fA-F]+$/.test(v);
  return isHex ? h >= 3.0 : h >= 4.0;
}

// 判定单个 name=value 是否为密钥(扫描回写脱敏、env/headers 字段用)。
// 优先级:高精确值规则 > 名字命中(且值非占位符)> 高熵兜底。无命中返回 null。
export function detectSecret(value: string, name?: string): SecretFinding | null {
  // 已是占位符/示例 → 永不告警(即便名字像密钥)。
  if (isPlaceholderValue(value)) return null;

  for (const { rule, re } of HIGH_VALUE_RULES) {
    if (re.test(value)) return { name, preview: preview(value), severity: "high", rule };
  }

  if (name && SECRET_NAME_RE.test(name)) {
    return { name, preview: preview(value), severity: "high", rule: "secret-name" };
  }

  if (looksHighEntropy(value)) {
    return { name, preview: preview(value), severity: "warning", rule: "high-entropy" };
  }

  return null;
}

// 扫描一整段文本里的高精确明文密钥(下发前护栏用;只认 high 规则,避免对正文误报)。
// 返回所有命中(去重 rule),空数组表示无明文。
export function scanTextForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  for (const { rule, re } of HIGH_VALUE_RULES) {
    const m = text.match(new RegExp(re, re.flags.includes("g") ? re.flags : `${re.flags}g`));
    if (m && m.length > 0 && !seen.has(rule)) {
      seen.add(rule);
      findings.push({ preview: preview(m[0]), severity: "high", rule });
    }
  }
  return findings;
}
