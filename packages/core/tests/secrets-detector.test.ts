import { describe, expect, it } from "vitest";
import {
  detectSecret,
  isPlaceholderValue,
  scanTextForSecrets,
  shannonEntropy,
} from "../src/secrets/detector.js";
import {
  deriveSecretName,
  envPlaceholder,
  parseSecretRef,
  redactFields,
  secretPlaceholder,
} from "../src/secrets/redactor.js";

describe("secrets/detector — name heuristics (stage 1)", () => {
  it("flags secret-like field names with non-placeholder values", () => {
    expect(detectSecret("hunter2longvalue", "API_KEY")?.rule).toBe("secret-name");
    expect(detectSecret("anything-here-xx", "github_token")?.rule).toBe("secret-name");
    expect(detectSecret("abcd1234efgh", "client_secret")?.rule).toBe("secret-name");
    expect(detectSecret("plainvalue123", "PASSWORD")?.severity).toBe("high");
  });

  it("does not flag ordinary field names", () => {
    expect(detectSecret("npx", "command")).toBeNull();
    expect(detectSecret("https://example.com", "url")).toBeNull();
    expect(detectSecret("production", "environment")).toBeNull();
  });

  it("does not false-positive on AUTH_* config fields (bare 'auth' token removed)", () => {
    // AUTH_URL / AUTH_TYPE / AUTH_METHOD 是常见非密钥配置;不应命中 secret-name。
    expect(detectSecret("https://api.example.com", "AUTH_URL")).toBeNull();
    expect(detectSecret("oauth2", "AUTH_TYPE")).toBeNull();
    expect(detectSecret("POST", "AUTH_METHOD")).toBeNull();
    // 但完整的 authorization 头仍判定为密钥字段。
    expect(detectSecret("Bearer abc123", "Authorization")?.rule).toBe("secret-name");
  });

  it("high-entropy git SHA / build hash is at most a warning, never high severity", () => {
    // 40-hex git SHA 不应被当作 high(否则会硬拦下发);最多 warning。
    const sha = detectSecret("3f8a1c9d2e4b5a6f7c8d9e0a1b2c3d4e5f60718a", "COMMIT_SHA");
    expect(sha?.severity).not.toBe("high");
  });
});

describe("secrets/detector — value patterns (stage 1 high)", () => {
  it("detects well-known token prefixes", () => {
    expect(detectSecret("ghp_0123456789abcdefghijklmnopqrstuvwx")?.rule).toBe("github-pat");
    expect(detectSecret("AKIAIOSFODNN7EXAMPLE")?.rule).toBe("aws-access-key");
    expect(detectSecret("sk-ant-api03-abcdefghijklmnopqrstuv")?.rule).toBe("anthropic-key");
    expect(detectSecret("xoxb-12345678901-abcdefghij")?.rule).toBe("slack-bot-token");
    expect(
      detectSecret("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N")?.rule,
    ).toBe("jwt");
  });

  it("detects PEM private keys", () => {
    expect(detectSecret("-----BEGIN RSA PRIVATE KEY-----\nMIIabc")?.rule).toBe("pem-private-key");
  });
});

describe("secrets/detector — whitelist (no false positives)", () => {
  it("never flags placeholders or example values", () => {
    expect(isPlaceholderValue("${MY_TOKEN}")).toBe(true);
    expect(isPlaceholderValue("${CELLARER_SECRET:foo}")).toBe(true);
    expect(isPlaceholderValue("<your-api-key>")).toBe(true);
    expect(isPlaceholderValue("changeme")).toBe(true);
    expect(isPlaceholderValue("")).toBe(true);
    expect(isPlaceholderValue("true")).toBe(true);
    expect(isPlaceholderValue("8080")).toBe(true);
    // 即便字段名像密钥,占位符值也不告警(关键:下发默认形态不被自己拦截)。
    expect(detectSecret("${GITHUB_TOKEN}", "GITHUB_TOKEN")).toBeNull();
    expect(detectSecret("${CELLARER_SECRET:gh}", "api_key")).toBeNull();
  });
});

describe("secrets/detector — high entropy (stage 2 warning)", () => {
  it("flags long high-entropy tokens as warning", () => {
    const f = detectSecret("Zk9Lm2Qp7Rw3Xt8Yv1Bn6Cd4Ef0Gh5Ij");
    expect(f?.severity).toBe("warning");
    expect(f?.rule).toBe("high-entropy");
  });

  it("does not flag low-entropy or sentence-like values", () => {
    expect(detectSecret("the quick brown fox jumps over")).toBeNull();
    expect(detectSecret("aaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull(); // 低熵重复
    expect(detectSecret("/usr/local/bin/some/path/here")).toBeNull();
  });

  it("shannonEntropy basic sanity", () => {
    expect(shannonEntropy("")).toBe(0);
    expect(shannonEntropy("aaaa")).toBe(0);
    expect(shannonEntropy("abcd")).toBeCloseTo(2, 5);
  });
});

describe("secrets/detector — scanTextForSecrets (guard)", () => {
  it("finds plaintext secrets embedded in rendered config text", () => {
    const text = `{"mcpServers":{"x":{"command":"npx","env":{"K":"ghp_0123456789abcdefghijklmnopqrstuvwx"}}}}`;
    const found = scanTextForSecrets(text);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.rule).toBe("github-pat");
    // 预览脱敏:不回显完整真值。
    expect(found[0]?.preview).not.toContain("qrstuvwx");
  });

  it("returns empty for placeholder-only config (env ref form)", () => {
    const text = `{"mcpServers":{"x":{"env":{"K":"\${GITHUB_TOKEN}"}}}}`;
    expect(scanTextForSecrets(text)).toEqual([]);
  });
});

describe("secrets/redactor", () => {
  it("parses env and vault refs (whole-value match only)", () => {
    expect(parseSecretRef("${FOO}")).toEqual({ kind: "env", name: "FOO" });
    expect(parseSecretRef("${CELLARER_SECRET:bar}")).toEqual({ kind: "vault", name: "bar" });
    expect(parseSecretRef("prefix-${FOO}-suffix")).toBeNull(); // 非整值不算
    expect(parseSecretRef("plain")).toBeNull();
  });

  it("builds placeholders", () => {
    expect(envPlaceholder("MY_VAR")).toBe("${MY_VAR}");
    expect(secretPlaceholder("svc_key")).toBe("${CELLARER_SECRET:svc_key}");
  });

  it("derives stable secret names from scope + field", () => {
    expect(deriveSecretName("mcp/company", "API_KEY")).toBe("MCP_COMPANY_API_KEY");
    expect(deriveSecretName("", "token")).toBe("TOKEN");
  });

  it("redacts secret-bearing fields and reports refs without real values", () => {
    const { redacted, refs } = redactFields(
      { CONTEXT7_API_KEY: "ghp_0123456789abcdefghijklmnopqrstuvwx", PORT: "8080" },
      "mcp/c7",
    );
    expect(redacted.PORT).toBe("8080"); // 非密钥保留
    expect(redacted.CONTEXT7_API_KEY).toMatch(/^\$\{CELLARER_SECRET:/); // 脱敏为占位符
    expect(refs).toHaveLength(1);
    // refs 不含真值。
    expect(JSON.stringify(refs)).not.toContain("ghp_0123456789");
  });

  it("is idempotent: re-redacting placeholders leaves them intact", () => {
    const { redacted } = redactFields(
      { K: "${CELLARER_SECRET:already}", E: "${ENV_REF}" },
      "mcp/x",
    );
    expect(redacted.K).toBe("${CELLARER_SECRET:already}");
    expect(redacted.E).toBe("${ENV_REF}");
  });
});
