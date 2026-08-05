import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import {
  cellarerSecretReference,
  environmentSecretReference,
  parseSecretReference,
  secretReferenceToken,
} from "../src/index.js";
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
import { encryptVault, vaultPath } from "../src/secrets/vault.js";
import { ensureBaseDirs, makeTmpEnv } from "./helpers/env.js";

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
