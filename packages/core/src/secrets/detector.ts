// 密钥检测(借 gitleaks,两段式;见计划 §7.6)。支撑安全红线「落盘无明文」。
// 用途:(a) 扫描回写前对 env/headers 值做脱敏判定;(b) 下发前 secret-scan 护栏扫描渲染文本。
// 纯函数(node:crypto 不需要,熵自己算),无副作用,不读 Env。

import { parse as parseToml } from "smol-toml";
import { parseSecretReference } from "./reference.js";

export type SecretSeverity = "high" | "warning";

export interface SecretFinding {
  // 命中的变量名(字段名场景)或 undefined(纯值/文本扫描)。
  name?: string;
  // 命中片段的预览(脱敏:只示意前缀,绝不回显完整真值)。
  preview: string;
  severity: SecretSeverity;
  // 命中规则标识,便于排查与测试断言。
  rule: string;
  // Pattern-specific suppressions bind to this version so detector changes cannot silently widen
  // an older approval.
  patternVersion: number;
}

export interface SecretPatternMatch {
  index: number;
  value: string;
  rule: string;
  patternVersion: number;
}

export interface StructuredSecretFinding {
  readonly path: string;
  readonly rule:
    | "sensitive-field"
    | "command-secret-argument"
    | "url-userinfo"
    | "url-secret-query"
    | "duplicate-key"
    | "structured-parse-error";
}

export interface StructuredFileSecretFinding extends StructuredSecretFinding {
  readonly source: string;
}

// Field classification is shared by structured guards and observable serializers. Split common
// identifier styles into exact vocabulary tokens instead of matching arbitrary substrings: this
// recognizes `access_token`, `access-token`, `access.token`, `accessToken`, and `AccessToken`
// consistently without treating `monkey` or `tokenizer` as sensitive.
const SENSITIVE_FIELD_TOKENS = new Set([
  "authorization",
  "bearer",
  "credential",
  "credentials",
  "creds",
  "passphrase",
  "passphrases",
  "passwd",
  "password",
  "passwords",
  "pwd",
  "reference",
  "references",
  "secret",
  "secrets",
  "token",
  "tokens",
]);
const SENSITIVE_FIELD_COMPOUNDS = new Set([
  "access_key",
  "access_keys",
  "api_key",
  "api_keys",
  "client_secret",
  "client_secrets",
  "private_key",
  "private_keys",
]);
const SENSITIVE_FIELD_FUSED_NAMES = new Set([
  "accesskey",
  "accesskeys",
  "apikey",
  "apikeys",
  "clientsecret",
  "clientsecrets",
  "privatekey",
  "privatekeys",
]);
const SAFE_NON_SECRET_ENUM_FIELDS = new Set(["secret_mode"]);

export function normalizeSensitiveSecretFieldName(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function isSensitiveSecretFieldName(name: string): boolean {
  const normalized = normalizeSensitiveSecretFieldName(name);
  if (normalized.length === 0 || SAFE_NON_SECRET_ENUM_FIELDS.has(normalized)) return false;
  if (SENSITIVE_FIELD_FUSED_NAMES.has(normalized)) return true;
  const tokens = normalized.split("_");
  if (tokens.some((token) => SENSITIVE_FIELD_TOKENS.has(token))) return true;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (SENSITIVE_FIELD_COMPOUNDS.has(`${tokens[index]}_${tokens[index + 1]}`)) return true;
  }
  return false;
}

// 高精确:具名前缀/格式(命中即拦截)。值层面强信号。
const HIGH_VALUE_RULES: { rule: string; patternVersion: number; re: RegExp }[] = [
  { rule: "github-pat", patternVersion: 1, re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { rule: "aws-access-key", patternVersion: 1, re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: "google-api-key", patternVersion: 1, re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: "anthropic-key", patternVersion: 1, re: /\bsk-ant-[0-9A-Za-z_-]{20,}\b/ },
  {
    rule: "openai-key",
    patternVersion: 1,
    re: /\bsk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}\b/,
  },
  { rule: "openai-key-generic", patternVersion: 1, re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { rule: "slack-bot-token", patternVersion: 1, re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { rule: "gitlab-pat", patternVersion: 1, re: /\bglpat-[0-9A-Za-z_-]{20,}\b/ },
  { rule: "npm-token", patternVersion: 1, re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  {
    rule: "jwt",
    patternVersion: 1,
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  { rule: "pem-private-key", patternVersion: 1, re: /-----BEGIN[A-Z ]*PRIVATE KEY-----/ },
];

// 白名单降噪:占位符 / 示例值 / 空 / 纯布尔数字 → 不告警。
// 注:已是 ${ENV_VAR} / ${CELLARER_SECRET:..} 的整值占位符不算明文(下发默认形态)。
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
  if (isSupportedSecretReference(v)) return true;
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

  for (const { rule, patternVersion, re } of HIGH_VALUE_RULES) {
    if (re.test(value)) {
      return { name, preview: preview(value), severity: "high", rule, patternVersion };
    }
  }

  if (name && isSensitiveSecretFieldName(name)) {
    return {
      name,
      preview: preview(value),
      severity: "high",
      rule: "secret-name",
      patternVersion: 1,
    };
  }

  if (looksHighEntropy(value)) {
    return {
      name,
      preview: preview(value),
      severity: "warning",
      rule: "high-entropy",
      patternVersion: 1,
    };
  }

  return null;
}

// 扫描一整段文本里的高精确明文密钥(下发前护栏用;只认 high 规则,避免对正文误报)。
// 返回所有命中(去重 rule),空数组表示无明文。
export function scanTextForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  for (const match of scanTextForSecretMatches(text)) {
    if (seen.has(match.rule)) continue;
    seen.add(match.rule);
    findings.push({
      preview: preview(match.value),
      severity: "high",
      rule: match.rule,
      patternVersion: match.patternVersion,
    });
  }
  return findings;
}

// Internal staging scans need occurrence locations and exact ephemeral match values for source to
// rendered-output attribution. Callers must never publish this structure.
export function scanTextForSecretMatches(text: string): SecretPatternMatch[] {
  const matches: SecretPatternMatch[] = [];
  for (const { rule, patternVersion, re } of HIGH_VALUE_RULES) {
    const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
    for (const match of text.matchAll(new RegExp(re, flags))) {
      if (match.index === undefined || match[0] === undefined) continue;
      matches.push({ index: match.index, value: match[0], rule, patternVersion });
    }
  }
  return matches.sort(
    (left, right) => left.index - right.index || left.rule.localeCompare(right.rule),
  );
}

export function scanStructuredSecretFindings(value: unknown): StructuredSecretFinding[] {
  const findings: StructuredSecretFinding[] = [];
  const visit = (current: unknown, path: string, sensitiveContext = false): void => {
    if (current === null || typeof current !== "object") {
      if (sensitiveContext && !isSafeStructuredSensitiveScalar(current)) {
        findings.push({ path, rule: "sensitive-field" });
      }
      if (typeof current === "string") scanUrl(current, path, findings);
      return;
    }
    if (Array.isArray(current)) {
      scanCommandArguments(current, path, findings);
      current.forEach((item, index) => {
        visit(item, `${path}[${index}]`, sensitiveContext);
      });
      return;
    }
    if (typeof current !== "object" || current === null) return;
    for (const [key, child] of Object.entries(current)) {
      visit(
        child,
        path ? `${path}.${key}` : key,
        sensitiveContext || isSensitiveSecretFieldName(key),
      );
    }
  };
  visit(value, "$");
  return findings;
}

export function scanStructuredFileSecretFindings(
  source: string,
  content: string,
): StructuredFileSecretFinding[] {
  const extension = /(?:^|\/)(?:[^/]+)(\.[^./]+)$/.exec(source)?.[1]?.toLowerCase();
  let findings: StructuredSecretFinding[] = [];
  try {
    if (extension === ".json") {
      assertNoDuplicateJsonKeys(content);
      findings = scanStructuredSecretFindings(JSON.parse(content));
    } else if (extension === ".jsonc") {
      const normalized = normalizeJsonc(content);
      assertNoDuplicateJsonKeys(normalized);
      findings = scanStructuredSecretFindings(JSON.parse(normalized));
    } else if (extension === ".toml") {
      findings = scanStructuredSecretFindings(parseToml(content));
    } else if (extension === ".yaml" || extension === ".yml") {
      findings = scanYamlSensitiveFields(content);
    } else {
      return [];
    }
  } catch (error) {
    findings = [
      {
        path: "$",
        rule:
          error instanceof DuplicateStructuredKeyError ? "duplicate-key" : "structured-parse-error",
      },
    ];
  }
  return findings.map((finding) => ({ ...finding, source }));
}

class DuplicateStructuredKeyError extends SyntaxError {}

// JSON.parse intentionally uses last-wins semantics. Validate the normalized source representation
// first so an earlier plaintext value cannot be erased by a later safe-looking duplicate.
function assertNoDuplicateJsonKeys(content: string): void {
  let index = 0;
  const skipWhitespace = (): void => {
    while (/\s/.test(content[index] ?? "")) index += 1;
  };
  const parseString = (): string => {
    const start = index;
    if (content[index] !== '"') throw new SyntaxError("expected JSON string");
    index += 1;
    let escaped = false;
    while (index < content.length) {
      const current = content[index] ?? "";
      index += 1;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (current === "\\") {
        escaped = true;
        continue;
      }
      if (current === '"') {
        return JSON.parse(content.slice(start, index)) as string;
      }
      if (current.charCodeAt(0) < 0x20) throw new SyntaxError("invalid JSON string");
    }
    throw new SyntaxError("unterminated JSON string");
  };
  const parseValue = (): void => {
    skipWhitespace();
    const current = content[index];
    if (current === "{") {
      parseObject();
      return;
    }
    if (current === "[") {
      parseArray();
      return;
    }
    if (current === '"') {
      parseString();
      return;
    }
    const scalar = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      content.slice(index),
    )?.[0];
    if (!scalar) throw new SyntaxError("invalid JSON value");
    index += scalar.length;
  };
  const parseObject = (): void => {
    index += 1;
    skipWhitespace();
    const keys = new Set<string>();
    if (content[index] === "}") {
      index += 1;
      return;
    }
    while (true) {
      skipWhitespace();
      const key = parseString();
      if (keys.has(key)) throw new DuplicateStructuredKeyError("duplicate JSON key");
      keys.add(key);
      skipWhitespace();
      if (content[index] !== ":") throw new SyntaxError("expected JSON colon");
      index += 1;
      parseValue();
      skipWhitespace();
      if (content[index] === "}") {
        index += 1;
        return;
      }
      if (content[index] !== ",") throw new SyntaxError("expected JSON comma");
      index += 1;
    }
  };
  const parseArray = (): void => {
    index += 1;
    skipWhitespace();
    if (content[index] === "]") {
      index += 1;
      return;
    }
    while (true) {
      parseValue();
      skipWhitespace();
      if (content[index] === "]") {
        index += 1;
        return;
      }
      if (content[index] !== ",") throw new SyntaxError("expected JSON comma");
      index += 1;
    }
  };
  parseValue();
  skipWhitespace();
  if (index !== content.length) throw new SyntaxError("unexpected JSON trailing content");
}

function normalizeJsonc(content: string): string {
  let withoutComments = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < content.length; index += 1) {
    const current = content[index] ?? "";
    const next = content[index + 1] ?? "";
    if (lineComment) {
      if (current === "\n" || current === "\r") {
        lineComment = false;
        withoutComments += current;
      } else {
        withoutComments += " ";
      }
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        withoutComments += "  ";
        index += 1;
      } else {
        withoutComments += current === "\n" || current === "\r" ? current : " ";
      }
      continue;
    }
    if (!inString && current === "/" && next === "/") {
      lineComment = true;
      withoutComments += "  ";
      index += 1;
      continue;
    }
    if (!inString && current === "/" && next === "*") {
      blockComment = true;
      withoutComments += "  ";
      index += 1;
      continue;
    }
    withoutComments += current;
    if (inString) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
    } else if (current === '"') {
      inString = true;
    }
  }
  if (blockComment) throw new SyntaxError("unterminated JSONC comment");

  let normalized = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < withoutComments.length; index += 1) {
    const current = withoutComments[index] ?? "";
    if (!inString && current === ",") {
      let lookahead = index + 1;
      while (/\s/.test(withoutComments[lookahead] ?? "")) lookahead += 1;
      if (withoutComments[lookahead] === "}" || withoutComments[lookahead] === "]") continue;
    }
    normalized += current;
    if (inString) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
    } else if (current === '"') {
      inString = true;
    }
  }
  return normalized;
}

function scanYamlSensitiveFields(content: string): StructuredSecretFinding[] {
  const findings: StructuredSecretFinding[] = [];
  const indentation = [{ indent: 0, sensitive: false }];
  let sawContent = false;
  let mayIndent = false;
  let pendingSensitive = false;
  let pendingIndentlessSequence:
    | { readonly indent: number; readonly sensitive: boolean }
    | undefined;
  let activeIndentlessSequence:
    | { readonly indent: number; readonly sensitive: boolean }
    | undefined;
  let block:
    | {
        readonly indent: number;
        readonly sensitive: boolean;
        readonly path: string;
        lines: string[];
      }
    | undefined;
  const finishBlock = (): void => {
    if (!block) return;
    inspectYamlScalar(block.lines.join("\n"), block.path, block.sensitive, findings);
    block = undefined;
  };

  for (const [lineIndex, rawLine] of content.split(/\r?\n/).entries()) {
    if (rawLine.includes("\t")) throw new SyntaxError("tabs are ambiguous in YAML indentation");
    const indent = /^ */.exec(rawLine)?.[0].length ?? 0;
    const trimmed = rawLine.trim();
    if (block) {
      if (trimmed.length === 0 || indent > block.indent) {
        block.lines.push(trimmed.length === 0 ? "" : rawLine.slice(indent));
        continue;
      }
      finishBlock();
    }

    const line = stripYamlComment(rawLine).trim();
    if (line.length === 0 || line === "---" || line === "...") continue;
    const sequenceItem = line.startsWith("-");
    if (
      activeIndentlessSequence &&
      (indent < activeIndentlessSequence.indent ||
        (indent === activeIndentlessSequence.indent && !sequenceItem))
    ) {
      activeIndentlessSequence = undefined;
    }
    if (pendingIndentlessSequence && indent === pendingIndentlessSequence.indent && sequenceItem) {
      activeIndentlessSequence = pendingIndentlessSequence;
    }
    pendingIndentlessSequence = undefined;
    if (!sawContent) {
      if (indent !== 0) throw new SyntaxError("YAML root must not be indented");
      sawContent = true;
    } else {
      const currentIndent = indentation.at(-1)?.indent ?? 0;
      if (indent > currentIndent) {
        if (!mayIndent) throw new SyntaxError("unexpected YAML indentation");
        indentation.push({ indent, sensitive: pendingSensitive });
      } else if (indent < currentIndent) {
        while ((indentation.at(-1)?.indent ?? 0) > indent) indentation.pop();
        if ((indentation.at(-1)?.indent ?? 0) !== indent) {
          throw new SyntaxError("inconsistent YAML indentation");
        }
      }
    }
    const sensitiveContext =
      (indentation.at(-1)?.sensitive ?? false) ||
      (sequenceItem && activeIndentlessSequence?.indent === indent
        ? activeIndentlessSequence.sensitive
        : false);
    pendingSensitive = sensitiveContext;
    const item = line.startsWith("-")
      ? line === "-"
        ? ""
        : /^-\s+/.test(line)
          ? line.replace(/^-\s+/, "")
          : line
      : line;
    if (item.length === 0) {
      mayIndent = true;
      continue;
    }
    const assignment = splitYamlAssignment(item);
    if (!assignment) {
      const scalar = parseYamlScalar(item);
      inspectYamlScalar(scalar, `$line[${lineIndex + 1}]`, sensitiveContext, findings);
      mayIndent = false;
      continue;
    }
    const field = parseYamlKey(assignment.key);
    const sensitive = sensitiveContext || isSensitiveSecretFieldName(field);
    const path = `$line[${lineIndex + 1}].${field}`;
    const rawValue = assignment.value.trim();
    if (rawValue.length === 0) {
      pendingSensitive = sensitive;
      pendingIndentlessSequence = { indent, sensitive };
      mayIndent = true;
      continue;
    }
    if (/^[|>](?:[+-]?[1-9]?|[1-9]?[+-]?)$/.test(rawValue)) {
      block = { indent, sensitive, path, lines: [] };
      mayIndent = false;
      continue;
    }
    inspectYamlScalar(parseYamlScalar(rawValue), path, sensitive, findings);
    pendingSensitive = sensitive;
    mayIndent = line.startsWith("-");
  }
  finishBlock();
  return findings;
}

function stripYamlComment(line: string): string {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const current = line[index] ?? "";
    if (doubleQuoted) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') doubleQuoted = false;
      continue;
    }
    if (singleQuoted) {
      if (current === "'" && line[index + 1] === "'") index += 1;
      else if (current === "'") singleQuoted = false;
      continue;
    }
    if (current === '"') doubleQuoted = true;
    else if (current === "'") singleQuoted = true;
    else if (current === "#" && (index === 0 || /\s/.test(line[index - 1] ?? ""))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function splitYamlAssignment(line: string): { key: string; value: string } | null {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const current = line[index] ?? "";
    if (doubleQuoted) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') doubleQuoted = false;
      continue;
    }
    if (singleQuoted) {
      if (current === "'" && line[index + 1] === "'") index += 1;
      else if (current === "'") singleQuoted = false;
      continue;
    }
    if (current === '"') doubleQuoted = true;
    else if (current === "'") singleQuoted = true;
    else if (current === ":" && (index === line.length - 1 || /\s/.test(line[index + 1] ?? ""))) {
      return { key: line.slice(0, index).trim(), value: line.slice(index + 1) };
    }
  }
  if (singleQuoted || doubleQuoted) throw new SyntaxError("unterminated YAML quote");
  return null;
}

function parseYamlKey(raw: string): string {
  const parsed = parseYamlScalar(raw);
  if (typeof parsed !== "string" || parsed.length === 0 || /[\r\n]/.test(parsed)) {
    throw new SyntaxError("invalid YAML mapping key");
  }
  return parsed;
}

function inspectYamlScalar(
  value: unknown,
  path: string,
  sensitive: boolean,
  findings: StructuredSecretFinding[],
): void {
  if (sensitive && !isSafeStructuredSensitiveScalar(value)) {
    findings.push({ path, rule: "sensitive-field" });
  }
  if (typeof value === "string") scanUrl(value, path, findings);
}

function parseYamlScalar(value: string): unknown {
  const raw = value.trim();
  if (raw.startsWith('"')) {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "string") throw new SyntaxError("invalid YAML quoted scalar");
    return parsed;
  }
  if (raw.startsWith("'")) {
    if (raw.length < 2 || !raw.endsWith("'")) throw new SyntaxError("unterminated YAML quote");
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  if ("[]{}&*!".includes(raw[0] ?? "")) {
    throw new SyntaxError("unsupported ambiguous YAML scalar");
  }
  if (/^(?:null|~)$/i.test(raw)) return null;
  if (/^(?:true|false)$/i.test(raw)) return raw.toLowerCase() === "true";
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(raw)) return Number(raw);
  if (/:[ \t]/.test(raw)) throw new SyntaxError("ambiguous YAML scalar");
  return raw;
}

function isSupportedSecretReference(value: string): boolean {
  try {
    return value === value.trim() && parseSecretReference(value) !== null;
  } catch {
    return false;
  }
}

function isSafeStructuredSensitiveScalar(value: unknown): boolean {
  return (
    typeof value === "string" && (value.trim().length === 0 || isSupportedSecretReference(value))
  );
}

function isSafeStructuredSensitiveValue(value: string): boolean {
  return isSafeStructuredSensitiveScalar(value);
}

function scanCommandArguments(
  values: readonly unknown[],
  path: string,
  findings: StructuredSecretFinding[],
): void {
  for (const [index, raw] of values.entries()) {
    if (typeof raw !== "string") continue;
    const equal = /^--?([^=]+)=(.*)$/.exec(raw);
    if (
      equal?.[1] &&
      isSensitiveSecretFieldName(equal[1]) &&
      !isSafeStructuredSensitiveValue(equal[2] ?? "")
    ) {
      findings.push({ path: `${path}[${index}]`, rule: "command-secret-argument" });
      continue;
    }
    const flag = /^--?(.+)$/.exec(raw)?.[1];
    const next = values[index + 1];
    if (
      flag &&
      isSensitiveSecretFieldName(flag) &&
      index + 1 < values.length &&
      !isSafeStructuredSensitiveTree(next)
    ) {
      findings.push({ path: `${path}[${index + 1}]`, rule: "command-secret-argument" });
    }
  }
}

function isSafeStructuredSensitiveTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isSafeStructuredSensitiveTree);
  if (value !== null && typeof value === "object") {
    return Object.values(value).every(isSafeStructuredSensitiveTree);
  }
  return isSafeStructuredSensitiveScalar(value);
}

function scanUrl(value: string, path: string, findings: StructuredSecretFinding[]): void {
  if (!/^https?:\/\//i.test(value)) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (
    (url.username && !isSafeStructuredSensitiveValue(decodeURIComponent(url.username))) ||
    (url.password && !isSafeStructuredSensitiveValue(decodeURIComponent(url.password)))
  ) {
    findings.push({ path, rule: "url-userinfo" });
  }
  for (const [key, candidate] of url.searchParams) {
    if (isSensitiveSecretFieldName(key) && !isSafeStructuredSensitiveValue(candidate)) {
      findings.push({ path, rule: "url-secret-query" });
    }
  }
}
