import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";
import * as activeSecretInternals from "../src/secrets/active-values.js";
import * as observableSecretInternals from "../src/secrets/observable.js";
import * as vaultSecretInternals from "../src/secrets/vault.js";

// These compile-time assertions make the named plaintext handles stay absent from the package
// root. If one is re-exported, TypeScript reports an unused @ts-expect-error.
// @ts-expect-error plaintext active values are package-private
type ActiveSecretValue = import("../src/index.js").ActiveSecretValue;
// @ts-expect-error plaintext secret values are package-private
type SecretValue = import("../src/index.js").SecretValue;

// @ts-expect-error plaintext resolvers are package-private
type ResolveActiveSecretValues = typeof import("../src/index.js")["resolveActiveSecretValues"];

// @ts-expect-error provider plaintext port aliases are package-private
type SecretStore = import("../src/index.js").SecretStore;
// @ts-expect-error provider plaintext results are package-private
type SecretGet = import("../src/index.js").SecretGet;

describe("public secret boundary", () => {
  it("does not re-export any runtime member from plaintext-capable internal modules", () => {
    const internals = new Set([
      ...Object.values(activeSecretInternals),
      ...Object.values(observableSecretInternals),
      ...Object.values(vaultSecretInternals),
    ]);
    expect(Object.values(core).filter((value) => internals.has(value))).toEqual([]);
  });

  it("keeps plaintext-capable modules and handle types out of the emitted root declaration", () => {
    const declaration = readFileSync(
      fileURLToPath(new URL("../dist/index.d.ts", import.meta.url)),
      "utf8",
    );
    expect(declaration).not.toMatch(/secrets\/(?:active-values|observable|resolver|vault)\.js/);
    expect(declaration).not.toMatch(/\b(?:ActiveSecretValue|SecretGet|SecretStore|SecretValue)\b/);
  });
});

void (0 as unknown as ActiveSecretValue);
void (0 as unknown as SecretValue);
void (0 as unknown as ResolveActiveSecretValues);
void (0 as unknown as SecretStore);
void (0 as unknown as SecretGet);
