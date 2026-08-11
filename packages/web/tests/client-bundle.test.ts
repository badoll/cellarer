import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin, type Rollup } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertClientApiExportContract,
  type CoreClientFixture,
  createCoreClientFixture,
} from "./helpers/core-client-fixture.js";
import { isPathInside } from "./helpers/path-containment.js";
import { assertPortableCoreModules } from "./helpers/portable-module-guard.js";
import {
  aggregatedRuntimeGlobalMutations,
  lexicalRuntimeGlobalShadows,
} from "./helpers/runtime-global-fixtures.js";

const productionCoreRoot = realpathSync(fileURLToPath(new URL("../../core", import.meta.url)));
const productionViteConfig = fileURLToPath(new URL("../client/vite.config.ts", import.meta.url));
const approvedCoreSpecifier = "@cellarer/core/client-api";

function realModulePath(id: string): string | undefined {
  const normalizedId = id.replace(/^\0/u, "").replaceAll("\\", "/");
  const cleanId = normalizedId.split(/[?#]/u, 1)[0] ?? normalizedId;
  const filesystemPath = cleanId.startsWith("/@fs/") ? cleanId.slice(4) : cleanId;
  if (!isAbsolute(filesystemPath)) return undefined;
  try {
    return realpathSync(filesystemPath);
  } catch {
    return undefined;
  }
}

function coreModulePath(id: string, coreRoot: string): string | undefined {
  const modulePath = realModulePath(id);
  if (modulePath === undefined) return undefined;
  const relativePath = relative(coreRoot, modulePath);
  return isPathInside(modulePath, coreRoot) ? relativePath.replaceAll("\\", "/") : undefined;
}

function nodeBuiltinFromViteId(id: string): string | undefined {
  const normalizedId = id.replace(/^\/@id\/__x00__/u, "").replace(/^\0/u, "");
  if (isBuiltin(normalizedId)) return normalizedId;

  for (const browserExternalMarker of ["__vite-browser-external:", "browser-external:"]) {
    const markerOffset = normalizedId.indexOf(browserExternalMarker);
    if (markerOffset === -1) continue;
    const externalizedId = normalizedId.slice(markerOffset + browserExternalMarker.length);
    if (isBuiltin(externalizedId)) return externalizedId;
  }
  return undefined;
}

function viteBrowserExternalId(id: string): string | undefined {
  const normalizedId = id.replace(/^\/@id\/__x00__/u, "").replace(/^\0/u, "");
  return normalizedId === "__vite-browser-external" ||
    normalizedId.startsWith("__vite-browser-external:") ||
    normalizedId.startsWith("browser-external:")
    ? normalizedId
    : undefined;
}

interface ProductionBundleGraph {
  readonly browserExternals: readonly string[];
  readonly coreModules: readonly string[];
  readonly nodeBuiltins: readonly string[];
  readonly resolvedClientApiRuntimePaths: readonly string[];
  readonly sharedCoreModules: readonly string[];
  readonly unresolvedCoreRootImports: readonly string[];
}

async function productionBundleGraph(
  coreFixture: CoreClientFixture,
  portableSourceMutation?: string,
  coreSourceMutation?: string,
  portableEmittedMutation?: string,
  allowPortableDiagnostics = false,
): Promise<ProductionBundleGraph> {
  const hasMutation =
    portableSourceMutation !== undefined ||
    coreSourceMutation !== undefined ||
    portableEmittedMutation !== undefined;
  const mutatedPortableFixture = hasMutation
    ? await createCoreClientFixture(
        "cellarer-web-bundle-mutation-",
        portableSourceMutation ?? "",
        allowPortableDiagnostics,
      )
    : undefined;
  const activeCoreFixture = mutatedPortableFixture ?? coreFixture;
  assertClientApiExportContract(activeCoreFixture);
  const portableModulePath = activeCoreFixture.portableModulePath;
  let coreSourcePath: string | undefined;
  if (portableEmittedMutation !== undefined) {
    const portableModule = await readFile(activeCoreFixture.portableModulePath, "utf8");
    await writeFile(
      portableModulePath,
      `${portableModule}\n${portableEmittedMutation ?? ""}\n`,
      "utf8",
    );
  }
  if (coreSourceMutation !== undefined) {
    coreSourcePath = join(activeCoreFixture.coreRoot, "src", "deep-node.ts");
    await mkdir(dirname(coreSourcePath), { recursive: true });
    await writeFile(coreSourcePath, coreSourceMutation, "utf8");
  }
  const coreRoot = activeCoreFixture.coreRoot;
  const htmlEntry = activeCoreFixture.htmlEntry;
  const importsByModule = new Map<string, readonly string[]>();
  const builtinImportsByModule = new Map<string, Set<string>>();
  const resolvedClientApiRuntimePaths = new Set<string>();
  const captureModuleGraph: Plugin = {
    name: "capture-core-client-module-graph",
    enforce: "pre",
    async resolveId(source, importer) {
      if (importer !== undefined && isBuiltin(source)) {
        const imports = builtinImportsByModule.get(importer) ?? new Set<string>();
        imports.add(source);
        builtinImportsByModule.set(importer, imports);
      }
      if (importer !== undefined && source === approvedCoreSpecifier) {
        const resolved = await this.resolve(source, importer, { skipSelf: true });
        const resolvedPath = resolved === null ? undefined : realModulePath(resolved.id);
        if (resolvedPath !== undefined) resolvedClientApiRuntimePaths.add(resolvedPath);
        return resolved;
      }
      return null;
    },
    generateBundle() {
      for (const id of this.getModuleIds()) {
        const info = this.getModuleInfo(id);
        importsByModule.set(id, [
          ...(info?.importedIds ?? []),
          ...(info?.dynamicallyImportedIds ?? []),
        ]);
      }
    },
  };
  const injectMutation: Plugin = {
    name: "inject-core-client-mutation",
    enforce: "pre",
    resolveId(source) {
      return source === "vite-browser-external-mutation/node-path.js"
        ? "\0__vite-browser-external"
        : null;
    },
    load(id) {
      return id === "\0__vite-browser-external" ? "export const join = undefined;" : null;
    },
    transform(source, id) {
      if (
        coreSourcePath === undefined ||
        realModulePath(id) !== realpathSync(join(activeCoreFixture.browserRoot, "api.ts"))
      ) {
        return null;
      }
      return `${source}\nimport { coreSourceMutation } from ${JSON.stringify(coreSourcePath)}; void coreSourceMutation;\n`;
    },
  };

  try {
    const result = await build({
      configFile: productionViteConfig,
      root: activeCoreFixture.browserRoot,
      logLevel: "silent",
      build: { write: false },
      plugins: [injectMutation, captureModuleGraph],
    });
    if ("close" in result) throw new Error("expected a completed production build");
    const outputs = Array.isArray(result) ? result : [result];
    const chunks = outputs.flatMap(({ output }) =>
      output.filter((item): item is Rollup.OutputChunk => item.type === "chunk"),
    );
    await assertPortableCoreModules({
      portableDeclarationPaths: activeCoreFixture.portableDeclarationPaths,
      portableSourcePaths: activeCoreFixture.portableSourcePaths,
      portableModulePaths: activeCoreFixture.portableModulePaths,
    });

    const htmlModuleId = [...importsByModule.keys()].find((id) => realModulePath(id) === htmlEntry);
    if (htmlModuleId === undefined) throw new Error("production graph is missing its HTML entry");
    const graphClosure = new Set<string>();
    const pending = [htmlModuleId];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined || graphClosure.has(id)) continue;
      graphClosure.add(id);
      pending.push(...(importsByModule.get(id) ?? []));
    }
    const coreModuleIds = [...graphClosure].filter(
      (id) => coreModulePath(id, coreRoot) !== undefined,
    );
    const nodeBuiltins = new Set(
      [...graphClosure].flatMap((id) => nodeBuiltinFromViteId(id) ?? []),
    );
    for (const id of graphClosure) {
      for (const builtin of builtinImportsByModule.get(id) ?? []) nodeBuiltins.add(builtin);
    }

    return {
      browserExternals: [...graphClosure].flatMap((id) => viteBrowserExternalId(id) ?? []).sort(),
      coreModules: coreModuleIds.flatMap((id) => coreModulePath(id, coreRoot) ?? []).sort(),
      nodeBuiltins: [...nodeBuiltins].sort(),
      resolvedClientApiRuntimePaths: [...resolvedClientApiRuntimePaths].sort(),
      sharedCoreModules: [...graphClosure]
        .flatMap((id) => coreModulePath(id, productionCoreRoot) ?? [])
        .sort(),
      unresolvedCoreRootImports: chunks
        .flatMap((chunk) => [...chunk.imports, ...chunk.dynamicImports])
        .filter(
          (specifier) => specifier === "@cellarer/core" || specifier.startsWith("@cellarer/core/"),
        )
        .sort(),
    };
  } finally {
    await mutatedPortableFixture?.cleanup();
  }
}

describe("bundled Web client production artifact", () => {
  let coreFixture: CoreClientFixture;

  beforeAll(async () => {
    coreFixture = await createCoreClientFixture("cellarer-web-bundle-core-");
  });

  afterAll(async () => {
    await coreFixture?.cleanup();
  });

  it("bundles only the browser-safe Core client protocol module", async () => {
    const result = await productionBundleGraph(coreFixture);
    expect(result).toEqual({
      browserExternals: [],
      coreModules: ["dist/protocol/client.js"],
      nodeBuiltins: [],
      resolvedClientApiRuntimePaths: [coreFixture.portableModulePath],
      sharedCoreModules: [],
      unresolvedCoreRootImports: [],
    });
    expect(
      result.resolvedClientApiRuntimePaths.every((path) =>
        isPathInside(path, coreFixture.coreRoot),
      ),
    ).toBe(true);
  });

  it.each([
    [
      "points the Vite import condition at the type-only runtime module",
      (manifest: Record<string, unknown>) => {
        const exports = manifest.exports as Record<string, Record<string, string>>;
        const clientApi = exports["./client-api"];
        if (clientApi === undefined) throw new Error("missing client-api export fixture");
        clientApi.import = "./dist/protocol/client-types.js";
      },
    ],
    [
      "removes the Vite import condition while retaining the correct default fallback",
      (manifest: Record<string, unknown>) => {
        const exports = manifest.exports as Record<string, Record<string, string>>;
        const clientApi = exports["./client-api"];
        if (clientApi === undefined) throw new Error("missing client-api export fixture");
        delete clientApi.import;
        clientApi.default = "./dist/protocol/client.js";
      },
    ],
    [
      "points the explicit default strategy at an unapproved runtime target",
      (manifest: Record<string, unknown>) => {
        const exports = manifest.exports as Record<string, Record<string, string>>;
        const clientApi = exports["./client-api"];
        if (clientApi === undefined) throw new Error("missing client-api export fixture");
        clientApi.default = "./dist/protocol/client-types.js";
      },
    ],
  ])("rejects a candidate package that %s", async (_name, mutateManifest) => {
    const mutated = await createCoreClientFixture("cellarer-web-bundle-export-mutation-");
    const originalManifest = await readFile(mutated.packageJsonPath, "utf8");
    try {
      const manifest = JSON.parse(originalManifest) as Record<string, unknown>;
      mutateManifest(manifest);
      await writeFile(mutated.packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await expect(productionBundleGraph(mutated)).rejects.toThrow();
    } finally {
      await mutated.cleanup();
    }
  });

  it("detects a Node builtin added to the portable value module in a production build", async () => {
    await expect(
      productionBundleGraph(
        coreFixture,
        'import path from "node:path"; export const mutation = path;',
      ),
    ).rejects.toThrow(/Node builtin import "node:path"/u);
  });

  it("rejects a Node builtin reached only through a TypeScript import type", async () => {
    await expect(
      productionBundleGraph(coreFixture, 'export type Leaked = import("node:fs").PathLike;'),
    ).rejects.toThrow(/Node builtin import "node:fs"/u);
  });

  it("rejects a Node builtin reached only through a JSDoc import type", async () => {
    await expect(
      productionBundleGraph(
        coreFixture,
        '/** @typedef {import("node:fs").PathLike} Leaked */\nexport const jsdocMutation = 1;',
      ),
    ).rejects.toThrow(/Node builtin import "node:fs"/u);
  });

  it("rejects a triple-slash Node type reference in portable source", async () => {
    const sourcePath = coreFixture.portableSourcePaths.find((path) => path.endsWith("/client.ts"));
    if (sourcePath === undefined) throw new Error("portable client source fixture is missing");
    const original = await readFile(sourcePath, "utf8");
    try {
      await writeFile(sourcePath, `/// <reference types="node" />\n${original}`, "utf8");
      await expect(assertPortableCoreModules(coreFixture)).rejects.toThrow(
        /triple-slash type reference "node"/u,
      );
    } finally {
      await writeFile(sourcePath, original, "utf8");
    }
  });

  it("rejects a triple-slash path reference in portable source", async () => {
    const sourcePath = coreFixture.portableSourcePaths.find((path) => path.endsWith("/client.ts"));
    if (sourcePath === undefined) throw new Error("portable client source fixture is missing");
    const original = await readFile(sourcePath, "utf8");
    try {
      await writeFile(
        sourcePath,
        `/// <reference path="./unapproved-portable.d.ts" />\n${original}`,
        "utf8",
      );
      await expect(assertPortableCoreModules(coreFixture)).rejects.toThrow(
        /triple-slash path reference "\.\/unapproved-portable\.d\.ts"/u,
      );
    } finally {
      await writeFile(sourcePath, original, "utf8");
    }
  });

  it("rejects a Node import type preserved only in emitted portable declarations", async () => {
    const declarationPath = coreFixture.portableDeclarationPaths.find((path) =>
      path.endsWith("/client.d.ts"),
    );
    if (declarationPath === undefined) throw new Error("portable client declaration is missing");
    const original = await readFile(declarationPath, "utf8");
    try {
      await writeFile(
        declarationPath,
        `${original}\nexport type Leaked = import("node:fs").PathLike;\n`,
        "utf8",
      );
      await expect(assertPortableCoreModules(coreFixture)).rejects.toThrow(
        /Node builtin import "node:fs"/u,
      );
    } finally {
      await writeFile(declarationPath, original, "utf8");
    }
  });

  it.each([
    ["process", "export const mutation = process.platform;"],
    ["Buffer", 'export const mutation = Buffer.from("portable");'],
    ["global", "export const mutation = global;"],
    ["__dirname", "export const mutation = __dirname;"],
    ["__filename", "export const mutation = __filename;"],
    ["module", "export const mutation = module;"],
    ["exports", "export const mutation = exports;"],
  ])("rejects the unbound Node global %s in fresh portable Core source", async (_name, source) => {
    await expect(productionBundleGraph(coreFixture, source)).rejects.toThrow(
      /Node runtime global/u,
    );
  });

  it.each(
    aggregatedRuntimeGlobalMutations,
  )("rejects the %s aggregation at its global source occurrence in a production build", async (_name, source) => {
    await expect(
      productionBundleGraph(coreFixture, source, undefined, undefined, true),
    ).rejects.toThrow(/forbidden runtime global "globalThis"/u);
  });

  it.each(
    aggregatedRuntimeGlobalMutations,
  )("rejects the %s aggregation preserved only in emitted JavaScript in a production build", async (_name, source) => {
    await expect(productionBundleGraph(coreFixture, undefined, undefined, source)).rejects.toThrow(
      /forbidden runtime global "globalThis"/u,
    );
  });

  it.each([
    ["process", "export const mutation = process.platform;"],
    ["Buffer", 'export const mutation = Buffer.from("portable");'],
  ])("rejects the unbound Node global %s preserved only in emitted Core JavaScript", async (_name, source) => {
    await expect(productionBundleGraph(coreFixture, undefined, undefined, source)).rejects.toThrow(
      /Node runtime global/u,
    );
  });

  it.each([
    [
      "process",
      'const process = { platform: "browser" }; export const mutation = process.platform;',
    ],
    [
      "Buffer",
      'const Buffer = { from: (value: string) => value }; export const mutation = Buffer.from("portable");',
    ],
    [
      "require",
      'const require = (value: string) => value; export const mutation = require("portable");',
    ],
  ])("allows the locally shadowed %s name in portable Core source", async (_name, source) => {
    await expect(productionBundleGraph(coreFixture, source)).resolves.toMatchObject({
      browserExternals: [],
      nodeBuiltins: [],
    });
  });

  it.each(
    lexicalRuntimeGlobalShadows,
  )("allows a genuine %s shadow in portable Core source", async (_name, source) => {
    await expect(productionBundleGraph(coreFixture, source)).resolves.toMatchObject({
      browserExternals: [],
      nodeBuiltins: [],
    });
  });

  it.each(
    lexicalRuntimeGlobalShadows,
  )("allows a genuine %s shadow in emitted portable JavaScript", async (_name, source) => {
    await expect(
      productionBundleGraph(coreFixture, undefined, undefined, source),
    ).resolves.toMatchObject({ browserExternals: [], nodeBuiltins: [] });
  });

  it("rejects a wrapped require from fresh portable Core source before publication", async () => {
    await expect(
      productionBundleGraph(
        coreFixture,
        'const load = (specifier: string) => require(specifier); export const mutation = load("node:path");',
      ),
    ).rejects.toThrow(
      /portable Core source\/emitted module gate rejected:[\s\S]*CommonJS require/u,
    );
  });

  it("rejects require when its callee is hidden by a TypeScript wrapper", async () => {
    await expect(
      productionBundleGraph(
        coreFixture,
        'export const mutation = (require as (specifier: string) => unknown)("node:path");',
      ),
    ).rejects.toThrow(/CommonJS require/u);
  });

  it("rejects a computed require callee from fresh portable Core source", async () => {
    await expect(
      productionBundleGraph(
        coreFixture,
        'const runtime = globalThis as typeof globalThis & { require(specifier: string): unknown }; export const mutation = runtime["require"]("node:path");',
      ),
    ).rejects.toThrow(/forbidden runtime global "globalThis"/u);
  });

  it("rejects require hidden behind a callable alias in fresh portable Core source", async () => {
    await expect(
      productionBundleGraph(
        coreFixture,
        'const load = require; export const mutation = load("node:path");',
      ),
    ).rejects.toThrow(/CommonJS require/u);
  });

  it.each([
    [
      "identifier property from globalThis",
      'const { require: load } = globalThis as typeof globalThis & { require(specifier: string): unknown }; export const mutation = load("node:path");',
      false,
      'forbidden runtime global "globalThis"',
    ],
    [
      "string property from window",
      'const { "require": load } = window as typeof window & { require(specifier: string): unknown }; export const mutation = load("node:path");',
      true,
      'forbidden runtime global "window"',
    ],
    [
      "computed-literal property from self",
      'const { ["require"]: load } = self as typeof self & { require(specifier: string): unknown }; export const mutation = load("node:path");',
      true,
      'forbidden runtime global "self"',
    ],
    [
      "shorthand property from global",
      'const { require } = global as typeof global & { require(specifier: string): unknown }; export const mutation = require("node:path");',
      false,
      'Node runtime global "global"',
    ],
    [
      "callable wrapper around a CommonJS alias",
      'const commonJs = module as typeof module & { require(specifier: string): unknown }; const { require: rawLoad } = commonJs; const load = (specifier: string) => rawLoad(specifier); export const mutation = load("node:path");',
      false,
      'Node runtime global "module"',
    ],
  ])("rejects destructured require via %s in fresh portable Core source", async (_name, source, allowPortableDiagnostics, reason) => {
    await expect(
      productionBundleGraph(coreFixture, source, undefined, undefined, allowPortableDiagnostics),
    ).rejects.toThrow(reason);
  });

  it("rejects destructured require preserved only in emitted portable JavaScript", async () => {
    await expect(
      productionBundleGraph(
        coreFixture,
        undefined,
        undefined,
        'const { ["require"]: load } = globalThis; export const mutation = load("node:path");',
      ),
    ).rejects.toThrow(/forbidden runtime global "globalThis"/u);
  });

  it.each([
    [
      "destructuring assignment",
      'let load = (specifier: string): unknown => specifier; ({ require: load } = globalThis as typeof globalThis & { require(specifier: string): unknown }); export const mutation = load("node:path");',
    ],
    [
      "object-rest alias",
      'const { ...runtime } = globalThis as typeof globalThis & { require(specifier: string): unknown }; export const mutation = runtime.require("node:path");',
    ],
    [
      "const computed property",
      'const key = "require"; const { [key]: load } = globalThis as typeof globalThis & { require(specifier: string): unknown }; export const mutation = load("node:path");',
    ],
  ])("rejects require provenance through %s in fresh portable Core source", async (_name, source) => {
    await expect(productionBundleGraph(coreFixture, source)).rejects.toThrow(
      /forbidden runtime global "globalThis"/u,
    );
  });

  it.each([
    [
      "destructuring assignment",
      'let load; ({ require: load } = globalThis); export const mutation = load("node:path");',
    ],
    [
      "object-rest alias",
      'const { ...runtime } = globalThis; export const mutation = runtime.require("node:path");',
    ],
    [
      "const computed property",
      'const key = "require"; const { [key]: load } = globalThis; export const mutation = load("node:path");',
    ],
  ])("rejects require provenance through %s in emitted portable JavaScript", async (_name, source) => {
    await expect(productionBundleGraph(coreFixture, undefined, undefined, source)).rejects.toThrow(
      /forbidden runtime global "globalThis"/u,
    );
  });

  it("fails closed for an unknown computed property of a known runtime owner", async () => {
    await expect(
      productionBundleGraph(
        coreFixture,
        "const key = String(Date.now()); const runtime = globalThis as typeof globalThis & Record<string, unknown>; export const mutation = runtime[key];",
      ),
    ).rejects.toThrow(/forbidden runtime global "globalThis"/u);
  });

  it("tracks a dangerous assignment through an alias and callable wrapper", async () => {
    await expect(
      productionBundleGraph(
        coreFixture,
        'let runtime = { require: (specifier: string): unknown => specifier }; runtime = globalThis as typeof globalThis & typeof runtime; const alias = runtime; const load = (specifier: string) => alias.require(specifier); export const mutation = load("node:path");',
      ),
    ).rejects.toThrow(/forbidden runtime global "globalThis"/u);
  });

  it("allows require destructured from a safe local object in portable Core source", async () => {
    await expect(
      productionBundleGraph(
        coreFixture,
        'const browserLoader = (value: string) => value; const browserRuntime = { require: browserLoader }; const { require: load } = browserRuntime; export const mutation = load("portable");',
      ),
    ).resolves.toMatchObject({ browserExternals: [], nodeBuiltins: [] });
  });

  it("allows a named class expression to shadow require in its own lexical scope", async () => {
    await expect(
      productionBundleGraph(
        coreFixture,
        "const RuntimeClass = class require { method() { return require; } }; export const mutation = RuntimeClass;",
      ),
    ).resolves.toMatchObject({ browserExternals: [], nodeBuiltins: [] });
  });

  it("rejects a non-literal dynamic import from fresh portable Core source", async () => {
    await expect(
      productionBundleGraph(
        coreFixture,
        'const specifier = "./client-types.js"; export const mutation = import(specifier);',
      ),
    ).rejects.toThrow(/non-literal dynamic import/u);
  });

  it("rejects TypeScript import-equals from fresh portable Core source", async () => {
    await expect(
      productionBundleGraph(
        coreFixture,
        'import path = require("node:path"); export const mutation = path.sep;',
        undefined,
        undefined,
        true,
      ),
    ).rejects.toThrow(/TypeScript import-equals/u);
  });

  it("rejects TypeScript export-equals from fresh portable Core source", async () => {
    await expect(
      productionBundleGraph(
        coreFixture,
        "const commonJsMutation = {}; export = commonJsMutation;",
        undefined,
        undefined,
        true,
      ),
    ).rejects.toThrow(/TypeScript export-equals/u);
  });

  it("rejects require preserved only in the emitted portable module", async () => {
    await expect(
      productionBundleGraph(
        coreFixture,
        undefined,
        undefined,
        'const load = (specifier) => require(specifier); export const mutation = load("node:path");',
      ),
    ).rejects.toThrow(/CommonJS require/u);
  });

  it("detects an opaque Vite browser external in the portable production closure", async () => {
    await expect(
      productionBundleGraph(
        coreFixture,
        undefined,
        undefined,
        'import { join } from "vite-browser-external-mutation/node-path.js"; export const mutation = join;',
      ),
    ).rejects.toThrow(/unapproved portable dependency/u);
  });

  it("detects a Node builtin reached through a relative Core source deep import", async () => {
    const result = await productionBundleGraph(
      coreFixture,
      undefined,
      'import path from "node:path"; export const coreSourceMutation = path.sep;\n',
    );
    expect(result).toEqual({
      coreModules: ["dist/protocol/client.js", "src/deep-node.ts"],
      browserExternals: ["__vite-browser-external:node:path"],
      nodeBuiltins: ["node:path"],
      resolvedClientApiRuntimePaths: [expect.stringMatching(/cellarer-web-bundle-mutation-/u)],
      sharedCoreModules: [],
      unresolvedCoreRootImports: [],
    });
  });
});
