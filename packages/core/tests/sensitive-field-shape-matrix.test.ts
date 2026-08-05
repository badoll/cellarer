import { describe, expect, it } from "vitest";
import { inventoryActiveSecretValues } from "../src/secrets/active-values.js";
import {
  isSensitiveSecretFieldName,
  scanStructuredFileSecretFindings,
  scanStructuredSecretFindings,
} from "../src/secrets/detector.js";
import { REDACTED_SECRET, serializeObservable } from "../src/secrets/observable.js";
import { makeTmpEnv } from "./helpers/env.js";

const SENSITIVE_FIELD_NAMES = [
  "token",
  "access_token",
  "access-token",
  "access.token",
  "accessToken",
  "AccessToken",
  "refreshToken",
  "clientSecret",
  "api_key",
  "apiKeys",
  "secret",
  "secrets",
  "password",
  "passwd",
  "passphrase",
  "pwd",
  "credential",
  "credentials",
  "creds",
  "authorization",
  "access_key",
  "private_key",
  "bearer",
  "passwords",
  "passphrases",
  "accessKeys",
  "privateKeys",
  "privatekeys",
  "clientSecrets",
  "clientsecrets",
  "apiKeys",
] as const;

const SUPPORTED_REFERENCES = [`\${ENV_VAR}`, `\${CELLARER_SECRET:shape-matrix}`] as const;

describe("sensitive field shape matrix", () => {
  it.each(SENSITIVE_FIELD_NAMES)("classifies the explicit/common-style field %s", (field) => {
    expect(isSensitiveSecretFieldName(field)).toBe(true);
  });

  it.each([
    "monkey",
    "tokenizer",
    "secretariat",
    "client",
    "access",
  ])("does not classify the non-sensitive substring %s", (field) => {
    expect(isSensitiveSecretFieldName(field)).toBe(false);
  });

  it.each([
    "reference",
    "references",
    "secretRefs",
  ])("treats plaintext reference-shaped field %s as sensitive while preserving exact typed references", (field) => {
    expect(isSensitiveSecretFieldName(field)).toBe(true);
    expect(scanStructuredSecretFindings({ [field]: "tiny" })).toEqual([
      expect.objectContaining({ rule: "sensitive-field" }),
    ]);
    expect(
      scanStructuredSecretFindings({
        [field]: ["${ENV_VAR}", { nested: "${CELLARER_SECRET:exact}" }],
      }),
    ).toEqual([]);
    expect(scanStructuredSecretFindings({ [field]: "${MISSING:-tiny}" })).toEqual([
      expect.objectContaining({ rule: "sensitive-field" }),
    ]);
  });

  it("keeps the narrow secretMode enum metadata exception", () => {
    expect(isSensitiveSecretFieldName("secretMode")).toBe(false);
    expect(scanStructuredSecretFindings({ secretMode: "env" })).toEqual([]);
  });

  it("uses the same plural/fused classifier for the active environment known-value inventory", async () => {
    const t = makeTmpEnv({
      env: {
        passwords: "plural-password-value",
        privatekeys: "fused-private-key-value",
        monkey: "ordinary-monkey-value",
      },
    });
    try {
      const active = await inventoryActiveSecretValues(t.env, t.path("home", ".cellarer"), {
        secretMode: "env",
      });
      expect(active.map((item) => item.reference.name).sort()).toEqual([
        "passwords",
        "privatekeys",
      ]);
    } finally {
      await t.cleanup();
    }
  });

  it.each(
    SENSITIVE_FIELD_NAMES,
  )("finds every non-reference scalar beneath %s and preserves exact references/empty strings", (field) => {
    const findings = scanStructuredSecretFindings({
      [field]: ["plaintext", 17, false, null, { nested: "object-plaintext" }],
    });

    expect(findings).toHaveLength(5);
    expect(findings.every((finding) => finding.rule === "sensitive-field")).toBe(true);
    for (const reference of SUPPORTED_REFERENCES) {
      expect(scanStructuredSecretFindings({ [field]: reference })).toEqual([]);
      expect(scanStructuredSecretFindings({ [field]: ` ${reference} ` })).toEqual([
        expect.objectContaining({ rule: "sensitive-field" }),
      ]);
    }
    expect(scanStructuredSecretFindings({ [field]: "" })).toEqual([]);
    expect(scanStructuredSecretFindings({ [field]: `\${MISSING:-plaintext}` })).toEqual([
      expect.objectContaining({ rule: "sensitive-field" }),
    ]);
  });

  it.each([
    ["json string", "shape.json", '{"AccessToken":"tiny"}\n', "sensitive-field"],
    ["json number", "shape.json", '{"AccessToken":17}\n', "sensitive-field"],
    ["json boolean", "shape.json", '{"AccessToken":false}\n', "sensitive-field"],
    ["json null", "shape.json", '{"AccessToken":null}\n', "sensitive-field"],
    ["jsonc object", "shape.jsonc", '{/*shape*/"accessToken":{"nested":17},}\n', "sensitive-field"],
    ["yaml string", "shape.yaml", "AccessToken: tiny\n", "sensitive-field"],
    ["yaml number", "shape.yaml", "AccessToken: 17\n", "sensitive-field"],
    ["yaml boolean", "shape.yaml", "AccessToken: false\n", "sensitive-field"],
    ["yaml null", "shape.yaml", "AccessToken: null\n", "sensitive-field"],
    ["toml string", "shape.toml", 'AccessToken = "tiny"\n', "sensitive-field"],
    ["toml number", "shape.toml", "AccessToken = 17\n", "sensitive-field"],
    ["toml boolean", "shape.toml", "AccessToken = false\n", "sensitive-field"],
    ["toml array", "shape.toml", 'AccessToken = ["tiny", 17, false]\n', "sensitive-field"],
    ["toml null is invalid", "shape.toml", "AccessToken = null\n", "structured-parse-error"],
  ] as const)("applies the same parsed scalar semantics to %s", (_label, source, content, rule) => {
    expect(scanStructuredFileSecretFindings(source, content)).toContainEqual(
      expect.objectContaining({ source, rule }),
    );
  });

  it.each([
    ["json", "shape.json", `{"accessToken":"\${ENV_VAR}"}\n`],
    ["jsonc", "shape.jsonc", `{/*safe*/"AccessToken":"\${CELLARER_SECRET:safe}",}\n`],
    ["yaml", "shape.yaml", `refreshToken: \${ENV_VAR}\n`],
    ["toml", "shape.toml", `clientSecret = "\${CELLARER_SECRET:safe}"\n`],
  ] as const)("accepts an exact supported reference in %s", (_format, source, content) => {
    expect(scanStructuredFileSecretFindings(source, content)).toEqual([]);
  });

  it.each([
    ["string", "tiny"],
    ["number", "17"],
    ["boolean", "false"],
    ["null", "null"],
    ["nested object", "nested:\n  value: tiny"],
    ["nested array", "- tiny\n- ${ENV_VAR}"],
  ] as const)("preserves sensitive context through a YAML indentless %s sequence item", (_label, item) => {
    const findings = scanStructuredFileSecretFindings("shape.yaml", `password:\n- ${item}\n`);

    expect(findings).toContainEqual(
      expect.objectContaining({ source: "shape.yaml", rule: "sensitive-field" }),
    );
  });

  it("accepts only exact typed references in a YAML indentless sensitive sequence", () => {
    expect(
      scanStructuredFileSecretFindings(
        "shape.yaml",
        "password:\n- ${ENV_VAR}\n- ${CELLARER_SECRET:exact}\n",
      ),
    ).toEqual([]);
  });

  it.each([
    ["number", 17],
    ["boolean", false],
    ["null", null],
    ["array", ["tiny"]],
    ["object", { nested: "tiny" }],
  ] as const)("treats the raw %s value after an MCP sensitive flag as sensitive", (_label, value) => {
    expect(
      scanStructuredSecretFindings({ command: "mcp", args: ["--password", value] }),
    ).toContainEqual(
      expect.objectContaining({
        path: expect.stringContaining("args[1]"),
        rule: "command-secret-argument",
      }),
    );
  });

  it.each([
    ["json", "shape.json", `{"AccessToken":"tiny","AccessToken":"\${ENV_VAR}"}\n`],
    [
      "jsonc",
      "shape.jsonc",
      `{"AccessToken":"tiny",/*last wins must not hide it*/"AccessToken":"\${ENV_VAR}",}\n`,
    ],
  ] as const)("rejects exact-source duplicate keys in %s", (_format, source, content) => {
    expect(scanStructuredFileSecretFindings(source, content)).toEqual([
      expect.objectContaining({ source, rule: "duplicate-key" }),
    ]);
  });
});

describe("observable sensitive field shape matrix", () => {
  const fingerprint = `sha256:${"a".repeat(64)}`;

  it.each([
    "journal",
    "receipt",
    "activity",
    "log",
    "cli",
    "web",
  ] as const)("redacts every descendant scalar at the %s boundary", (boundary) => {
    const payload = Object.fromEntries(
      SENSITIVE_FIELD_NAMES.map((field) => [
        field,
        [
          `plaintext-${field}`,
          17,
          false,
          null,
          { nested: `nested-${field}` },
          ...SUPPORTED_REFERENCES,
          "",
        ],
      ]),
    );
    const parsed = JSON.parse(serializeObservable(boundary, payload)) as Record<string, unknown[]>;

    for (const field of SENSITIVE_FIELD_NAMES) {
      expect(parsed[field]).toEqual([
        REDACTED_SECRET,
        REDACTED_SECRET,
        REDACTED_SECRET,
        REDACTED_SECRET,
        { nested: REDACTED_SECRET },
        ...SUPPORTED_REFERENCES,
        "",
      ]);
    }
  });

  it("redacts an object-shaped PascalCase field through an Error cause", () => {
    const error = new Error("safe failure", {
      cause: { AccessToken: { string: "error-plaintext", number: 17, boolean: false, nil: null } },
    });
    const encoded = serializeObservable("error", error);

    expect(encoded).not.toContain("error-plaintext");
    expect(JSON.parse(encoded)).toMatchObject({
      cause: {
        AccessToken: {
          string: REDACTED_SECRET,
          number: REDACTED_SECRET,
          boolean: REDACTED_SECRET,
          nil: REDACTED_SECRET,
        },
      },
    });
  });

  it.each([
    "reference",
    "references",
    "secretRefs",
  ])("redacts plaintext descendants in observable reference-shaped field %s", (field) => {
    const parsed = JSON.parse(
      serializeObservable("web", {
        [field]: ["tiny", 17, false, null, { nested: "tiny-object" }, "${ENV_VAR}"],
      }),
    );

    expect(parsed[field]).toEqual([
      REDACTED_SECRET,
      REDACTED_SECRET,
      REDACTED_SECRET,
      REDACTED_SECRET,
      { nested: REDACTED_SECRET },
      "${ENV_VAR}",
    ]);
  });

  it.each([
    "log",
    "error",
    "cli",
    "web",
  ] as const)("redacts bare and prefixed digest strings in ordinary token fields at the %s boundary", (boundary) => {
    const digest = "a".repeat(64);
    const parsed = JSON.parse(
      serializeObservable(boundary, {
        bare: { token: digest },
        prefixed: { token: `sha256:${digest}` },
        nested: {
          bare: { token: digest },
          prefixed: { token: `sha256:${digest}` },
        },
      }),
    );

    expect(parsed).toEqual({
      bare: { token: REDACTED_SECRET },
      prefixed: { token: REDACTED_SECRET },
      nested: {
        bare: { token: REDACTED_SECRET },
        prefixed: { token: REDACTED_SECRET },
      },
    });
  });

  it.each([
    "replace-unowned",
    "override-drift",
    "revert-drift",
  ] as const)("preserves the exact %s target acknowledgement needed for the next request", (kind) => {
    const parsed = JSON.parse(
      serializeObservable("web", { acknowledgement: { kind, token: fingerprint } }),
    );

    expect(parsed).toEqual({ acknowledgement: { kind, token: fingerprint } });
  });

  it.each([
    ["missing kind", { token: fingerprint }],
    ["wrong kind", { kind: "other", token: fingerprint }],
    ["extra key", { kind: "replace-unowned", token: fingerprint, extra: true }],
    ["bare digest", { kind: "replace-unowned", token: "a".repeat(64) }],
  ] as const)("does not exempt a %s token-bearing object", (_label, acknowledgement) => {
    const parsed = JSON.parse(serializeObservable("web", { acknowledgement }));

    expect(parsed.acknowledgement.token).toBe(REDACTED_SECRET);
  });
});
