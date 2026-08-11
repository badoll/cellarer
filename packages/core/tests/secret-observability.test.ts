import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import {
  cellarerSecretReference,
  environmentSecretReference,
  parseSecretReference,
  secretReferenceToken,
  validateControlPlaneConfig,
} from "../src/index.js";
import {
  createAuthorizedMutationPlan,
  verifyMutationPlanAuthorization,
} from "../src/protocol/canonical.js";
import {
  createProviderScope,
  providerScopeForEnv,
  resolveActiveSecretValues,
  withProviderScope,
} from "../src/secrets/active-values.js";
import {
  attachObservableProviderScope,
  createSecretValue,
  observableKnownValues,
  redactObservable,
  serializeObservable,
  withObservableKnownValues,
} from "../src/secrets/observable.js";
import { createSafeObservableOpenApiDocument } from "../src/secrets/public-boundary.js";
import { encryptVault, vaultPath } from "../src/secrets/vault.js";
import { ensureBaseDirs, makeTmpEnv } from "./helpers/env.js";
import { deterministicMutationAuthority } from "./helpers/mutation-authority.js";

const CANARY = "ordinary-canary-value-123";

describe("typed secret references", () => {
  it("parses environment and cellarer references without accepting embedded tokens", () => {
    expect(parseSecretReference(`\${GITHUB_TOKEN}`)).toEqual(
      environmentSecretReference("GITHUB_TOKEN"),
    );
    expect(parseSecretReference(`\${CELLARER_SECRET:github-token}`)).toEqual(
      cellarerSecretReference("github-token"),
    );
    expect(parseSecretReference(`prefix-\${GITHUB_TOKEN}`)).toBeNull();
    expect(secretReferenceToken(environmentSecretReference("GITHUB_TOKEN"))).toBe(
      `\${GITHUB_TOKEN}`,
    );
    expect(secretReferenceToken(cellarerSecretReference("github-token"))).toBe(
      `\${CELLARER_SECRET:github-token}`,
    );
  });
});

describe("scoped secret values", () => {
  it("can only expose plaintext to an explicit callback and cannot be JSON serialized", () => {
    const value = createSecretValue(CANARY);

    expect(value.use((plaintext) => plaintext.length)).toBe(CANARY.length);
    expect(() => JSON.stringify(value)).toThrow(/secret value/i);
    expect(() => String(value)).toThrow(/secret value/i);
  });

  it("allows one operation to attach the same provider scope at nested error boundaries", () => {
    const value = new Error("provider failed");
    const scope = { knownValues: [createSecretValue("tiny")] };

    expect(attachObservableProviderScope(value, scope)).toBe(value);
    expect(attachObservableProviderScope(value, scope)).toBe(value);
    expect(observableKnownValues(value)).toEqual(scope.knownValues);
  });

  it("keeps an operation scope private to its explicit Env clone", () => {
    const t = makeTmpEnv();
    try {
      const scope = createProviderScope({ secretMode: "env" });
      const scoped = withProviderScope(t.env, scope);
      const privateKeys = Reflect.ownKeys(scoped).filter(
        (key) => typeof key === "symbol" && providerScopeForEnv(scoped) === scope,
      );

      expect(scoped).not.toBe(t.env);
      expect(providerScopeForEnv(t.env)).toBeUndefined();
      expect(providerScopeForEnv(scoped)).toBe(scope);
      expect(privateKeys).toHaveLength(2);
      expect(
        privateKeys.every((key) => !Object.prototype.propertyIsEnumerable.call(scoped, key)),
      ).toBe(true);
      expect(providerScopeForEnv({ ...scoped })).toBeUndefined();
    } finally {
      t.cleanup();
    }
  });

  it("keeps observable known values out of enumeration, spread, and JSON", () => {
    const t = makeTmpEnv();
    try {
      const known = createSecretValue("tiny-private-scope");
      const scoped = withObservableKnownValues(t.env, [known]);
      const spread = { ...scoped };

      expect(Object.keys(scoped)).not.toContain("observableKnownValues");
      expect("observableKnownValues" in spread).toBe(false);
      expect(JSON.stringify(scoped)).not.toContain("tiny-private-scope");
      expect(observableKnownValues(scoped)).toEqual([known]);
    } finally {
      t.cleanup();
    }
  });

  it("deduplicates concurrent failures for the same provider token", async () => {
    const t = makeTmpEnv();
    await ensureBaseDirs(t);
    try {
      let reads = 0;
      const env: Env = {
        ...t.env,
        secretStore: {
          async get() {
            reads += 1;
            await Promise.resolve();
            return { error: `provider failure ${reads}` };
          },
          async set() {},
          async delete() {
            return false;
          },
        },
      };
      const scope = createProviderScope({ secretMode: "keychain" });
      const operationEnv = withProviderScope(env, scope);
      const resolve = () =>
        resolveActiveSecretValues(
          operationEnv,
          t.path("home", ".cellarer"),
          [cellarerSecretReference("SHARED_FAILURE")],
          { secretMode: "keychain", requireAvailable: true },
        );

      const results = await Promise.allSettled([resolve(), resolve()]);

      expect(reads).toBe(1);
      expect(results).toEqual([
        expect.objectContaining({
          status: "rejected",
          reason: expect.objectContaining({ code: "SECRET_PROVIDER_SCOPE_UNAVAILABLE" }),
        }),
        expect.objectContaining({
          status: "rejected",
          reason: expect.objectContaining({ code: "SECRET_PROVIDER_SCOPE_UNAVAILABLE" }),
        }),
      ]);
    } finally {
      await t.cleanup();
    }
  });

  it("loads one vault snapshot for concurrent references in an operation", async () => {
    const t = makeTmpEnv();
    await ensureBaseDirs(t);
    const storeRoot = t.path("home", ".cellarer");
    const passphrase = "one-operation-vault-passphrase";
    const path = vaultPath(storeRoot);
    await t.env.fs.mkdir(t.path("home", ".cellarer", "secrets"), { recursive: true });
    await t.env.fs.writeFile(
      path,
      await encryptVault({ FIRST: "alpha", SECOND: "beta" }, passphrase),
      { mode: 0o600 },
    );
    try {
      let reads = 0;
      const readFile = t.env.fs.readFile;
      const env: Env = {
        ...t.env,
        fs: {
          ...t.env.fs,
          async readFile(candidate) {
            if (candidate === path) reads += 1;
            return readFile(candidate);
          },
        },
      };
      const scope = createProviderScope({ secretMode: "vault", vaultPassphrase: passphrase });
      const operationEnv = withProviderScope(env, scope);

      const [first, second] = await Promise.all([
        resolveActiveSecretValues(operationEnv, storeRoot, [cellarerSecretReference("FIRST")], {
          secretMode: "vault",
          vaultPassphrase: passphrase,
          requireAvailable: true,
        }),
        resolveActiveSecretValues(operationEnv, storeRoot, [cellarerSecretReference("SECOND")], {
          secretMode: "vault",
          vaultPassphrase: passphrase,
          requireAvailable: true,
        }),
      ]);

      expect(first).toHaveLength(2);
      expect(second).toHaveLength(2);
      expect(reads).toBe(1);
    } finally {
      await t.cleanup();
    }
  });
});

describe("observable secret boundaries", () => {
  it("preserves public schema vocabulary without allowing secret canaries through", () => {
    const input = {
      openapi: "3.1.0",
      info: { title: "test", description: "ghp_0123456789abcdefghijklmnopqrstuvwx" },
      paths: {},
      components: {
        schemas: {
          Plan: {
            type: "object",
            properties: { authorization: { type: "object" } },
          },
        },
        securitySchemes: {
          localManagedClientAuth: { type: "http", scheme: "bearer" },
        },
      },
    };
    const document = createSafeObservableOpenApiDocument(input);
    const encoded = serializeObservable("web", { document });

    expect(encoded).toContain('"authorization":{"type":"object"');
    expect(encoded).toContain('"scheme":"bearer"');
    expect(encoded).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwx");
    expect(document).not.toBe(input);
    expect(Object.isFrozen(document)).toBe(true);
  });

  it("does not let public-document marking bypass low-entropy sensitive fields", () => {
    expect(() =>
      createSafeObservableOpenApiDocument({
        openapi: "3.1.0",
        info: {
          title: "test",
          authorization: { token: "managed-test-token", scheme: "bearer" },
        },
        paths: {},
        components: {},
      }),
    ).toThrow(/Sensitive data field/);
  });

  it("rejects low-entropy values embedded in sensitive JSON Schema properties", () => {
    expect(() =>
      createSafeObservableOpenApiDocument({
        openapi: "3.1.0",
        info: { title: "test" },
        paths: {},
        components: {
          schemas: {
            Unsafe: {
              type: "object",
              properties: { token: { type: "string", const: "managed-test-token" } },
            },
          },
        },
      }),
    ).toThrow(/Sensitive JSON Schema properties/);
  });

  it("preserves sensitive-named metadata only for a validated public config projection", () => {
    const validated = validateControlPlaneConfig({
      artifacts: {
        "rules/style": {
          secretPatternSuppressions: [
            { source: "rules/style.md", rule: "github-pat", patternVersion: 1 },
          ],
        },
      },
      customAdapters: {
        custom: {
          mcp: {
            global: "~/.custom/mcp.json",
            supportedSecretReferences: ["environment", "cellarer"],
          },
        },
      },
    });
    if (!validated.valid) throw new Error("expected valid config fixture");
    expect(Object.isFrozen(validated.config)).toBe(true);
    expect(
      Object.isFrozen(validated.config.artifacts["rules/style"]?.secretPatternSuppressions ?? []),
    ).toBe(true);
    expect(
      Object.isFrozen(validated.config.customAdapters.custom?.mcp?.supportedSecretReferences ?? []),
    ).toBe(true);

    const trusted = JSON.parse(serializeObservable("cli", { config: validated.config })) as {
      config: {
        artifacts: Record<
          string,
          { secretPatternSuppressions: Array<{ source: string; rule: string }> }
        >;
        customAdapters: Record<string, { mcp: { supportedSecretReferences: string[] } }>;
      };
    };
    expect(trusted.config.artifacts["rules/style"]?.secretPatternSuppressions).toEqual([
      { source: "rules/style.md", rule: "github-pat", patternVersion: 1 },
    ]);
    expect(trusted.config.customAdapters.custom?.mcp.supportedSecretReferences).toEqual([
      "environment",
      "cellarer",
    ]);

    const unverified = JSON.parse(JSON.stringify(validated.config)) as unknown;
    expect(JSON.parse(serializeObservable("cli", { config: unverified }))).toMatchObject({
      config: {
        artifacts: {
          "rules/style": {
            secretPatternSuppressions: [
              { source: "[REDACTED]", rule: "[REDACTED]", patternVersion: "[REDACTED]" },
            ],
          },
        },
        customAdapters: {
          custom: { mcp: { supportedSecretReferences: ["[REDACTED]", "[REDACTED]"] } },
        },
      },
    });

    const knownValueOutput = serializeObservable(
      "cli",
      { config: validated.config },
      {
        knownValues: [createSecretValue("github-pat")],
      },
    );
    expect(knownValueOutput).not.toContain("github-pat");
    expect(JSON.parse(knownValueOutput)).toMatchObject({
      config: {
        artifacts: {
          "rules/style": { secretPatternSuppressions: [{ rule: "[REDACTED]" }] },
        },
      },
    });
  });

  it.each(["plan", "state"] as const)("rejects secret values at the %s boundary", (boundary) => {
    expect(() => serializeObservable(boundary, { nested: createSecretValue(CANARY) })).toThrow(
      /secret value/i,
    );
  });

  it.each([
    "journal",
    "receipt",
    "activity",
    "log",
    "error",
    "cli",
    "web",
  ] as const)("redacts sensitive fields, known values, and typed values at the %s boundary", (boundary) => {
    const knownValue = createSecretValue(CANARY);
    const result = redactObservable(
      boundary,
      {
        apiKey: "plain-but-sensitive",
        message: `operation failed around ${CANARY}`,
        nested: { value: knownValue },
        reference: `\${CELLARER_SECRET:github-token}`,
      },
      { knownValues: [knownValue] },
    ) as Record<string, unknown>;
    const encoded = serializeObservable(boundary, result);

    expect(encoded).not.toContain("plain-but-sensitive");
    expect(encoded).not.toContain(CANARY);
    expect(encoded).toContain("[REDACTED]");
    expect(encoded).toContain(`\${CELLARER_SECRET:github-token}`);
  });

  it("redacts Error messages without exposing stack text", () => {
    const knownValue = createSecretValue(CANARY);
    const result = redactObservable("error", new Error(`failed with ${CANARY}`), {
      knownValues: [knownValue],
    });
    const encoded = serializeObservable("error", result);

    expect(encoded).not.toContain(CANARY);
    expect(encoded).not.toContain("secret-observability.test.ts");
    expect(encoded).toContain("[REDACTED]");
  });

  it("preserves only a factory-minted immutable mutation-authorization snapshot", () => {
    const t = makeTmpEnv();
    t.env.mutationAuthority = deterministicMutationAuthority();
    const plan = createAuthorizedMutationPlan(t.env, t.path("home", ".cellarer"), {
      schemaVersion: 1,
      planId: "observable-plan",
      operation: "apply",
      baseRevision: 0,
      normalizedInputs: {},
      actions: [],
      targetPreconditions: [],
      expires: { policy: "none" },
    });

    expect(Object.isSealed(plan)).toBe(true);
    expect(Object.isSealed(plan.authorization)).toBe(true);
    expect(JSON.parse(serializeObservable("cli", { plan }))).toMatchObject({
      plan: { authorization: plan.authorization },
    });
    expect(
      JSON.parse(
        serializeObservable("cli", {
          authorization: { ...plan.authorization, extra: true },
        }),
      ),
    ).toEqual({
      authorization: "[REDACTED]",
    });
    t.cleanup();
  });

  it("preserves a parsed mutation authorization only after authority verification", () => {
    const t = makeTmpEnv();
    t.env.mutationAuthority = deterministicMutationAuthority();
    const storeRoot = t.path("home", ".cellarer");
    const created = createAuthorizedMutationPlan(t.env, storeRoot, {
      schemaVersion: 1,
      planId: "parsed-observable-plan",
      operation: "apply",
      baseRevision: 0,
      normalizedInputs: {},
      actions: [],
      targetPreconditions: [],
      expires: { policy: "none" },
    });
    const parsed = JSON.parse(JSON.stringify(created)) as typeof created;

    expect(JSON.parse(serializeObservable("cli", { plan: parsed }))).toEqual({
      plan: { ...parsed, authorization: "[REDACTED]" },
    });
    expect(verifyMutationPlanAuthorization(t.env, storeRoot, parsed)).toBe(true);
    expect(JSON.parse(serializeObservable("cli", { plan: parsed }))).toEqual({ plan: parsed });
    t.cleanup();
  });

  it("does not execute hostile authorization getters, toJSON, prototypes, or Proxy traps", () => {
    let getterReads = 0;
    let toJsonCalls = 0;
    let proxyTraps = 0;
    const getterEnvelope = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries({
      schemaVersion: 1,
      domain: "executable-plan-v1",
      algorithm: "HMAC-SHA-256",
      authorityId: "getter-canary-authority",
      authorityEpoch: 1,
      seal: `hmac-sha256:${"b".repeat(64)}`,
    })) {
      Object.defineProperty(getterEnvelope, key, {
        enumerable: true,
        get() {
          getterReads += 1;
          if (getterReads >= 3) throw new Error("third getter canary");
          return value;
        },
      });
    }
    Object.defineProperty(getterEnvelope, "toJSON", {
      enumerable: false,
      value() {
        toJsonCalls += 1;
        return { seal: "getter-canary-leak" };
      },
    });
    const proxyEnvelope = new Proxy(getterEnvelope, {
      get() {
        proxyTraps += 1;
        throw new Error("proxy get trap");
      },
      getOwnPropertyDescriptor() {
        proxyTraps += 1;
        throw new Error("proxy descriptor trap");
      },
      getPrototypeOf() {
        proxyTraps += 1;
        throw new Error("proxy prototype trap");
      },
      ownKeys() {
        proxyTraps += 1;
        throw new Error("proxy ownKeys trap");
      },
    });

    expect(JSON.parse(serializeObservable("cli", { authorization: getterEnvelope }))).toEqual({
      authorization: "[REDACTED]",
    });
    expect(JSON.parse(serializeObservable("cli", { authorization: proxyEnvelope }))).toEqual({
      authorization: "[REDACTED]",
    });
    expect(JSON.parse(serializeObservable("plan", { authorization: proxyEnvelope }))).toEqual({
      authorization: "[REDACTED]",
    });
    expect(getterReads).toBe(0);
    expect(toJsonCalls).toBe(0);
    expect(proxyTraps).toBe(0);
  });

  it("redacts known values and credential patterns from nested observable object keys", () => {
    const known = createSecretValue(CANARY);
    const pattern = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    const map = new Map<string, unknown>();
    Object.defineProperty(map, `map-${CANARY}`, { enumerable: true, value: "map-value" });
    const encoded = serializeObservable(
      "cli",
      {
        nested: {
          deep: {
            "[REDACTED_KEY]": "collision-sentinel",
            [CANARY]: "known-key",
            [`prefix-${CANARY}-suffix`]: "contained-known-key",
            [`credential-${pattern}`]: "detected-key",
          },
        },
        array: [{ [`array-${CANARY}`]: "array-value" }],
        map,
      },
      { knownValues: [known] },
    );
    const parsed = JSON.parse(encoded) as {
      nested: { deep: Record<string, unknown> };
      array: Array<Record<string, unknown>>;
      map: Record<string, unknown>;
    };

    expect(encoded).not.toContain(CANARY);
    expect(encoded).not.toContain(pattern);
    expect(Object.keys(parsed.nested.deep)).toHaveLength(4);
    expect(new Set(Object.keys(parsed.nested.deep)).size).toBe(4);
    expect(Object.keys(parsed.array[0] ?? {})).toHaveLength(1);
    expect(Object.keys(parsed.map)).toHaveLength(1);
    expect(
      Object.keys(parsed.nested.deep).filter((key) => key.includes("REDACTED_KEY")),
    ).toHaveLength(4);
  });

  it("preserves only fixed journal structure keys and redacts arbitrary durable payload keys", () => {
    const fixedKeyCanary = "planId";
    const payloadKeyCanary = "payload-secret-key";
    let proxyTraps = 0;
    const hostile = new Proxy(
      { [fixedKeyCanary]: "hostile-value" },
      {
        ownKeys() {
          proxyTraps += 1;
          throw new Error("hostile ownKeys");
        },
      },
    );
    const encoded = serializeObservable(
      "journal",
      {
        plan: {
          planId: "fixed-id",
          actions: [
            {
              payload: {
                "[REDACTED_KEY]": "collision-sentinel",
                [payloadKeyCanary]: "user-payload-value",
                data: hostile,
              },
            },
          ],
        },
      },
      {
        knownValues: [createSecretValue(fixedKeyCanary), createSecretValue(payloadKeyCanary)],
        protocolShape: "operation-journal",
      },
    );
    const parsed = JSON.parse(encoded) as {
      plan: { planId: string; actions: Array<{ payload: Record<string, unknown> }> };
    };
    const payload = parsed.plan.actions[0]?.payload ?? {};

    expect(parsed.plan.planId).toBe("fixed-id");
    expect(encoded).not.toContain(payloadKeyCanary);
    expect(Object.keys(payload)).toHaveLength(3);
    expect(new Set(Object.keys(payload)).size).toBe(3);
    expect(Object.keys(payload).filter((key) => key.includes("REDACTED_KEY"))).toHaveLength(2);
    expect(payload.data).toBe("[REDACTED]");
    expect(proxyTraps).toBeGreaterThan(0);
  });

  it("preserves JSON omission semantics for undefined optional secret reference names", () => {
    expect(JSON.parse(serializeObservable("cli", { secretRefs: undefined }))).toEqual({});
    expect(
      JSON.parse(serializeObservable("web", { nested: { secretReferenceNames: undefined } })),
    ).toEqual({ nested: {} });
  });

  it("fails closed for observable accessor, symbol, toJSON, and Proxy key surfaces", () => {
    let getterCalls = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, CANARY, {
      enumerable: true,
      get() {
        getterCalls += 1;
        return CANARY;
      },
    });
    const symbol = { safe: true } as Record<PropertyKey, unknown>;
    symbol[Symbol(CANARY)] = "symbol-value";
    const withToJSON = { safe: true } as Record<string, unknown> & { toJSON?: () => unknown };
    Object.defineProperty(withToJSON, "toJSON", {
      enumerable: false,
      value: () => ({ [CANARY]: CANARY }),
    });
    const proxy = new Proxy(
      { [CANARY]: CANARY },
      {
        ownKeys() {
          throw new Error(`proxy-${CANARY}`);
        },
      },
    );

    for (const candidate of [accessor, symbol, withToJSON, proxy]) {
      const encoded = serializeObservable(
        "cli",
        { candidate },
        {
          knownValues: [createSecretValue(CANARY)],
        },
      );
      expect(encoded).not.toContain(CANARY);
    }
    expect(getterCalls).toBe(0);
  });

  it("keeps a provider failure scope local, non-enumerable, and able to redact low-entropy values", async () => {
    const t = makeTmpEnv();
    await ensureBaseDirs(t);
    try {
      const env: Env = {
        ...t.env,
        secretStore: {
          async get(_service, account) {
            if (account === "FIRST") return { found: true, value: "tiny" };
            return { error: "provider mentioned tiny" };
          },
          async set() {},
          async delete() {
            return false;
          },
        },
      };
      let thrown: unknown;
      try {
        await resolveActiveSecretValues(
          env,
          t.path("home", ".cellarer"),
          [cellarerSecretReference("FIRST"), cellarerSecretReference("SECOND")],
          { secretMode: "keychain", requireAvailable: true },
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({ code: "SECRET_PROVIDER_SCOPE_UNAVAILABLE" });
      expect(Object.keys(thrown as object)).not.toContain("knownValues");
      expect(JSON.stringify(thrown)).not.toContain("tiny");
      const encoded = serializeObservable("error", thrown, {
        knownValues: observableKnownValues(thrown),
      });
      expect(encoded).not.toContain("tiny");
    } finally {
      await t.cleanup();
    }
  });

  it("isolates low-entropy provider error scopes across concurrent operations", async () => {
    const t = makeTmpEnv();
    await ensureBaseDirs(t);
    try {
      const failAfter = (known: string): Env => ({
        ...t.env,
        secretStore: {
          async get(_service, account) {
            return account === "FIRST"
              ? { found: true, value: known }
              : { error: "provider unavailable" };
          },
          async set() {},
          async delete() {
            return false;
          },
        },
      });
      const operations = ["alpha", "beta"].map((known) =>
        resolveActiveSecretValues(
          failAfter(known),
          t.path("home", ".cellarer"),
          [cellarerSecretReference("FIRST"), cellarerSecretReference("SECOND")],
          { secretMode: "keychain", requireAvailable: true },
        ),
      );
      const [alpha, beta] = await Promise.allSettled(operations);
      if (alpha?.status !== "rejected" || beta?.status !== "rejected") {
        throw new Error("expected independent provider failures");
      }

      expect(
        serializeObservable("error", new Error("alpha beta"), {
          knownValues: observableKnownValues(alpha.reason),
        }),
      ).toContain("beta");
      expect(
        serializeObservable("error", new Error("alpha beta"), {
          knownValues: observableKnownValues(beta.reason),
        }),
      ).toContain("alpha");
    } finally {
      await t.cleanup();
    }
  });
});
