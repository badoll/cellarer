import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type * as ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { listOperationReceipts } from "../src/protocol/journal.js";
import { executeStorePublicationMutation } from "../src/protocol/store-mutation.js";
import { MUTATION_AUTHORITY_CREDENTIAL_SERVICE } from "../src/secrets/authority-namespace.js";
import { keychainMetadataPath } from "../src/secrets/keychain-metadata.js";
import {
  createSecretObservationUseCaseInput,
  verifySecretReferences,
} from "../src/secrets/provider-runtime.js";
import { activeSecretPublicationGuard } from "../src/secrets/publication-guard.js";
import {
  secretMetadataCapabilitiesFor,
  setStoredSecret,
} from "../src/secrets/secret-metadata-runtime.js";
import { initStore } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";
import { deterministicMutationAuthority } from "./helpers/mutation-authority.js";

const sourceRoot = resolve(import.meta.dirname, "../src");
const repositoryRoot = resolve(sourceRoot, "../../..");
const tsRuntime = createRequire(import.meta.url)("typescript") as typeof ts;

function secretReferenceVerificationContractDiagnostics(): string[] {
  const fixturePath = resolve(sourceRoot, "../contract-tests/secret-reference-verification.mts");
  const fixtureSource = `import {
  type Env,
} from "../src/index.js";
import { createSecretObservationUseCaseInput } from "../src/secrets/provider-runtime.js";

const provider = {
  async get() {
    return { found: true as const, value: "compiler-contract" };
  },
};
const readOnlyInput = { env: {}, secretStore: provider };
const input = createSecretObservationUseCaseInput(readOnlyInput, "keychain-get");
void input.environment;
void input.observation.getKeychain;
// @ts-expect-error mutation authority is outside the read-only composition input
void input.mutationAuthority;
// @ts-expect-error the provider port exposes get only
void input.observation.setKeychain;
// @ts-expect-error the provider port exposes get only
void input.observation.deleteKeychain;

declare const fullEnv: Env;
createSecretObservationUseCaseInput(fullEnv, "environment-only");
`;
  const options: ts.CompilerOptions = {
    module: tsRuntime.ModuleKind.NodeNext,
    moduleResolution: tsRuntime.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: tsRuntime.ScriptTarget.ES2023,
    types: ["node"],
  };
  const host = tsRuntime.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (path) => (resolve(path) === fixturePath ? fixtureSource : readFile(path));
  host.fileExists = (path) => resolve(path) === fixturePath || fileExists(path);
  const program = tsRuntime.createProgram({ rootNames: [fixturePath], options, host });
  return tsRuntime.getPreEmitDiagnostics(program).map((diagnostic) => {
    const message = tsRuntime.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    if (!diagnostic.file || diagnostic.start === undefined) return message;
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1}: ${message}`;
  });
}

type BoundaryRole = "domain" | "port" | "provider" | "runtime" | "transaction";

interface SourceModule {
  readonly id: string;
  readonly source: string;
  readonly imports: readonly string[];
}

// domain: pure policy/data transforms; port: capability contracts; provider: concrete secret
// implementations; transaction: mutation/journal orchestration; runtime: composition and adapters.
const BOUNDARY_ROLE_INVENTORY: Readonly<Record<BoundaryRole, readonly string[]>> = {
  domain: [
    "protocol/cli.ts",
    "protocol/client-types.ts",
    "protocol/client.ts",
    "protocol/models.ts",
    "secrets/active-values.ts",
    "secrets/authority-namespace.ts",
    "secrets/detector.ts",
    "secrets/final-bytes.ts",
    "secrets/keychain-metadata.ts",
    "secrets/observable.ts",
    "secrets/redactor.ts",
    "secrets/reference.ts",
    "secrets/resolver.ts",
    "secrets/safe-tree.ts",
    "secrets/types.ts",
    "secrets/vault-path.ts",
  ],
  port: ["env.ts", "secrets/adoption-provider.ts", "secrets/provider-ports.ts"],
  provider: ["secrets/keychain-provider.ts", "secrets/provider-adapters.ts", "secrets/vault.ts"],
  runtime: [
    "real-env.ts",
    "runtime/credential-adapter.ts",
    "runtime/filesystem-adapter.ts",
    "runtime/mutation-authority-adapter.ts",
    "runtime/process-platform-adapter.ts",
    "runtime/resource-source-transport-adapter.ts",
    "secrets/provider-runtime.ts",
    "secrets/public-boundary.ts",
    "secrets/publication-guard.ts",
    "secrets/secret-metadata-runtime.ts",
  ],
  transaction: [
    "protocol/authority-lifecycle.ts",
    "protocol/canonical.ts",
    "protocol/execute.ts",
    "protocol/journal.ts",
    "protocol/mutation-lock.ts",
    "protocol/operation-adapter.ts",
    "protocol/operation-contracts.ts",
    "protocol/operation-execution.ts",
    "protocol/presentation.ts",
    "protocol/publication.ts",
    "protocol/readiness.ts",
    "protocol/recovery.ts",
    "protocol/store-mutation.ts",
    "protocol/store-revision.ts",
    "secrets/provider.ts",
    "secrets/secret-metadata.ts",
  ],
};

const ALLOWED_ROLE_EDGES = [
  "domain->port",
  "port->domain",
  "provider->domain",
  "provider->port",
  "runtime->domain",
  "runtime->port",
  "runtime->provider",
  "runtime->transaction",
  "transaction->domain",
  "transaction->port",
] as const;

const APPROVED_MODULE_GLOBAL_MUTABLE_IDENTITIES = new Set([
  "protocol/canonical.ts:currentMutationAuthorityScopes",
  "runtime/mutation-authority-adapter.ts:headlessKernelOwners",
  "runtime/mutation-authority-adapter.ts:pendingHeadlessKernelOwners",
  "secrets/observable.ts:observableMutationAuthorizations",
  "secrets/observable.ts:observableOpenApiDocuments",
  "secrets/observable.ts:observablePublicControlPlaneConfigs",
]);

// These initialized collections are read-only lookup tables: their only production uses are
// `.has`/`.get`; every stateful collection remains in the identity allowlist above.
const REVIEWED_READONLY_MODULE_GLOBAL_COLLECTIONS = new Set([
  "engine/apply.ts:CONTROLLED_ACTION_IO_CODES",
  "engine/revert.ts:CONTROLLED_ACTION_IO_CODES",
  "protocol/store-mutation.ts:CONTROLLED_ACTION_IO_CODES",
  "secrets/detector.ts:EXAMPLE_VALUES",
  "secrets/detector.ts:SAFE_NON_SECRET_ENUM_FIELDS",
  "secrets/detector.ts:SENSITIVE_FIELD_COMPOUNDS",
  "secrets/detector.ts:SENSITIVE_FIELD_FUSED_NAMES",
  "secrets/detector.ts:SENSITIVE_FIELD_TOKENS",
  "secrets/observable.ts:JOURNAL_STRUCTURE_KEYS",
  "secrets/observable.ts:RECEIPT_STRUCTURE_KEYS",
  "secrets/public-boundary.ts:JSON_SCHEMA_KEYS",
  "secrets/public-boundary.ts:OPEN_API_ROOT_KEYS",
  "store/config.ts:UNSAFE_RUNTIME_CONFIG_KEYS",
]);

describe("Core runtime architecture boundaries", () => {
  const modules = loadSourceModules();

  it("keeps secret observation and provider mutation ports independent of Store transactions", () => {
    const portModuleIds = ["secrets/provider-ports.ts"];
    const ports = modules.filter(({ id }) => portModuleIds.includes(id));

    expect(ports.map(({ id }) => id)).toEqual(portModuleIds);
    expect(
      ports.flatMap(({ id, imports }) =>
        imports.includes("protocol/store-mutation.ts") ? [id] : [],
      ),
    ).toEqual([]);
  });

  it("allows only acyclic domain, port, provider, transaction, and runtime directions", () => {
    const boundaryEdges = roleEdges(modules);
    const cycles = dependencyCycles(modules);
    const forbiddenRoleEdges = boundaryEdges.filter(
      (edge) => !ALLOWED_ROLE_EDGES.includes(edge as (typeof ALLOWED_ROLE_EDGES)[number]),
    );

    expect(cycles).toEqual([]);
    expect(boundaryEdges).toEqual(ALLOWED_ROLE_EDGES);
    expect(forbiddenRoleEdges).toEqual([]);
  });

  it("classifies every secret/runtime boundary module and forbids domain or transactions from concrete providers", () => {
    const boundaryModules = modules.filter(({ id }) => isBoundaryModule(id));
    const concreteProviders = new Set(BOUNDARY_ROLE_INVENTORY.provider);
    const forbiddenImports = forbiddenConcreteProviderEdges(boundaryModules, concreteProviders);

    expect(boundaryInventoryViolations(modules)).toEqual([]);
    expect(forbiddenImports).toEqual([]);
  });

  it("fails closed for an unknown module under a scanned boundary root", () => {
    const unknown: SourceModule = {
      id: "secrets/future-boundary.ts",
      source: "export const futureBoundary = true;",
      imports: [],
    };
    expect(boundaryInventoryViolations([...modules, unknown])).toEqual([
      "unclassified:secrets/future-boundary.ts",
    ]);
  });

  it("detects an illegal domain to concrete-provider edge in a synthetic graph", () => {
    const synthetic = modules.map((module) =>
      module.id === "secrets/active-values.ts"
        ? {
            ...module,
            imports: [...module.imports, "secrets/keychain-provider.ts"],
          }
        : module,
    );
    const forbidden = forbiddenConcreteProviderEdges(
      synthetic.filter(({ id }) => isBoundaryModule(id)),
      new Set(["secrets/keychain-provider.ts"]),
    );

    expect(forbidden).toEqual(["secrets/active-values.ts->secrets/keychain-provider.ts"]);
  });

  it("parses literal dynamic imports into real dependency edges and cycles", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "cellarer-import-graph-"));
    const writeModule = (id: string, source: string): void => {
      const path = join(fixtureRoot, id);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source, "utf8");
    };
    writeModule(
      "secrets/active-values.ts",
      'export async function observe() { return import("./keychain-provider.js"); }',
    );
    writeModule(
      "secrets/keychain-provider.ts",
      'export { transact } from "../protocol/store-mutation.js";',
    );
    writeModule(
      "protocol/store-mutation.ts",
      'export async function transact() { return await import("../secrets/active-values.js"); }',
    );
    try {
      const fixtureModules = loadSourceModulesFrom(fixtureRoot);
      expect(
        forbiddenConcreteProviderEdges(fixtureModules, new Set(["secrets/keychain-provider.ts"])),
      ).toEqual(["secrets/active-values.ts->secrets/keychain-provider.ts"]);
      expect(dependencyCycles(fixtureModules)).toEqual([
        ["protocol/store-mutation.ts", "secrets/active-values.ts", "secrets/keychain-provider.ts"],
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("counts static and literal dynamic self-imports as dependency cycles", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "cellarer-self-loop-"));
    writeFileSync(
      join(fixtureRoot, "dynamic.ts"),
      'export const load = () => import("./dynamic.js");',
    );
    writeFileSync(
      join(fixtureRoot, "static.ts"),
      'import "./static.js"; export const ready = true;',
    );
    try {
      expect(dependencyCycles(loadSourceModulesFrom(fixtureRoot))).toEqual([
        ["dynamic.ts"],
        ["static.ts"],
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects non-literal dynamic imports in first-party source", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "cellarer-import-graph-"));
    const fixture = join(fixtureRoot, "secrets", "active-values.ts");
    mkdirSync(dirname(fixture), { recursive: true });
    writeFileSync(fixture, "export const load = (specifier: string) => import(specifier);", "utf8");
    try {
      expect(() => loadSourceModulesFrom(fixtureRoot)).toThrowError(
        /non-literal dynamic import.*secrets\/active-values\.ts:1/u,
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when a relative first-party dependency cannot be resolved", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "cellarer-import-graph-"));
    const fixture = join(fixtureRoot, "secrets", "active-values.ts");
    mkdirSync(dirname(fixture), { recursive: true });
    writeFileSync(fixture, 'export { missing } from "./missing.js";', "utf8");
    try {
      expect(() => loadSourceModulesFrom(fixtureRoot)).toThrowError(
        /unresolved first-party import.*secrets\/active-values\.ts.*\.\/missing\.js/u,
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when a relative dependency resolves outside the scanned Core source root", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "cellarer-import-root-"));
    const coreRoot = join(fixtureRoot, "packages", "core", "src");
    const importer = join(coreRoot, "entry.ts");
    const outside = join(fixtureRoot, "packages", "cli", "src", "outside.ts");
    mkdirSync(dirname(importer), { recursive: true });
    mkdirSync(dirname(outside), { recursive: true });
    writeFileSync(importer, 'export { outside } from "../../cli/src/outside.js";', "utf8");
    writeFileSync(outside, "export const outside = true;", "utf8");
    try {
      expect(() => loadSourceModulesFrom(coreRoot)).toThrowError(
        /resolved outside Core source root.*entry\.ts.*\.\.\/\.\.\/cli\/src\/outside\.js/u,
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("parses static imports, re-exports, and import-equals declarations", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "cellarer-import-graph-"));
    const writeModule = (id: string, source: string): void => {
      const path = join(fixtureRoot, id);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source, "utf8");
    };
    writeModule(
      "entry.ts",
      [
        'import "./static.js";',
        'export { value } from "./exported.js";',
        'import provider = require("./provider.js");',
        "export const loaded = provider;",
      ].join("\n"),
    );
    writeModule("static.ts", "export const sideEffect = true;");
    writeModule("exported.ts", "export const value = true;");
    writeModule("provider.ts", "export = { ready: true };");
    try {
      expect(
        loadSourceModulesFrom(fixtureRoot).find(({ id }) => id === "entry.ts")?.imports,
      ).toEqual(["exported.ts", "provider.ts", "static.ts"]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("constructs the observation adapter from read capabilities without authority or provider writes", () => {
    const adapter = modules.find(({ id }) => id === "secrets/provider-adapters.ts");
    const ports = modules.find(({ id }) => id === "secrets/provider-ports.ts");
    const runtime = modules.find(({ id }) => id === "secrets/provider-runtime.ts");
    if (!adapter || !ports || !runtime) throw new Error("missing provider boundary module");
    const source = stripComments(adapter.source);

    expect(source).not.toMatch(/import\s+type\s+\{\s*Env\s*\}/u);
    expect(source).toMatch(/createVaultReadPort\(input:\s*VaultReadAdapterInput\)/u);
    expect(source).toMatch(/createKeychainGetPort\(input:\s*KeychainGetAdapterInput\)/u);
    expect(source).toMatch(/createKeychainListPort\(input:\s*KeychainListAdapterInput\)/u);
    expect(source).not.toMatch(/mutationAuthority/u);
    expect(stripComments(ports.source)).not.toMatch(/SecretObservationPort/u);
    expect(stripComments(runtime.source)).not.toMatch(/as\s+SecretObservationPort/u);
    expect(stripComments(ports.source)).toMatch(/StorePublicationSecretGuardContext/u);
    expect(stripComments(ports.source)).not.toMatch(/prepare\(\s*env:\s*Env/u);
  });

  it("keeps compatibility adapter descriptors out of runtime variant dispatch", () => {
    const planModule = modules.find(({ id }) => id === "engine/plan.ts");
    const skillsModule = modules.find(({ id }) => id === "engine/skills-plan.ts");
    if (!planModule || !skillsModule) throw new Error("missing capability planners");

    expect(planModule.imports).toContain("adapters/codec.ts");
    expect(stripComments(planModule.source)).not.toMatch(/adapter\.(?:rules|skills)\b/u);
    expect(stripComments(skillsModule.source)).not.toMatch(/adapter\.skills\b/u);
  });

  it("characterizes forbidden imports and ambient business-module inputs", () => {
    const businessModules = modules.filter(({ id }) => moduleRole(id) !== "runtime");
    const nodeEffectImports = businessModules.flatMap(({ id, source }) =>
      [
        ...stripComments(source).matchAll(
          /(?:from\s+|import\s*)["']node:(?:fs(?:\/promises)?|process)["']/g,
        ),
      ].map(() => id),
    );
    const processReads = businessModules.flatMap(({ id, source }) =>
      stripComments(source).match(/\bprocess\./) ? [id] : [],
    );
    const implicitCwdResolution = [
      ...new Set(
        businessModules.flatMap(({ id, source }) =>
          stripComments(source).match(/\bresolve\(\s*(?!env\.cwd\(\)\s*,)/) ? [id] : [],
        ),
      ),
    ];
    const moduleGlobalMutableIdentity = moduleGlobalMutableIdentityFindings(modules).filter(
      (finding) =>
        !APPROVED_MODULE_GLOBAL_MUTABLE_IDENTITIES.has(finding) &&
        !REVIEWED_READONLY_MODULE_GLOBAL_COLLECTIONS.has(finding),
    );
    const readonlyLookupViolations = reviewedReadonlyCollectionViolations(
      modules,
      REVIEWED_READONLY_MODULE_GLOBAL_COLLECTIONS,
    );

    expect(nodeEffectImports).toEqual([]);
    expect(processReads).toEqual([]);
    expect(implicitCwdResolution).toEqual([]);
    expect(moduleGlobalMutableIdentity).toEqual([]);
    expect(readonlyLookupViolations).toEqual([]);
  });

  it("detects top-level counters and const mutable identity containers with the AST", () => {
    const fixtures = [
      "let counter = 0;",
      "const identities = new WeakMap<object, string>();",
      "const state = { counter: 0 };",
      "const buckets = new Map<string, number>();",
      "const STATE = new Map<string, number>();",
      "const frozen = Object.freeze(new Map<string, number>());",
      "const asserted = ((new Set<string>()) as ReadonlySet<string>);",
      "const satisfied = (new WeakMap<object, string>()) satisfies WeakMap<object, string>;",
      "const parenthesized = (((new WeakSet<object>())));",
    ];
    const findings = moduleGlobalMutableIdentityFindings(
      fixtures.map((source, index) => ({ id: `synthetic-${index}.ts`, source, imports: [] })),
    );

    expect(findings).toEqual([
      "synthetic-0.ts:counter",
      "synthetic-1.ts:identities",
      "synthetic-2.ts:state",
      "synthetic-3.ts:buckets",
      "synthetic-4.ts:STATE",
      "synthetic-5.ts:frozen",
      "synthetic-6.ts:asserted",
      "synthetic-7.ts:satisfied",
      "synthetic-8.ts:parenthesized",
    ]);
  });

  it("rejects mutation, writes, and escapes from reviewed readonly module collections", () => {
    const synthetic: SourceModule[] = [
      {
        id: "synthetic-set.ts",
        imports: [],
        source: [
          "const LOOKUP = Object.freeze((new Set<string>()) satisfies Set<string>);",
          'LOOKUP.add("x");',
          'LOOKUP.delete("x");',
          "LOOKUP.clear();",
          "(LOOKUP as unknown as { extra: boolean }).extra = true;",
          '(LOOKUP as unknown as Record<string, boolean>)["x"] = true;',
          "consume(LOOKUP);",
          "const escaped = LOOKUP;",
          "export function leak() { return LOOKUP; }",
        ].join("\n"),
      },
      {
        id: "synthetic-map.ts",
        imports: [],
        source: [
          "const LOOKUP = ((new Map<string, string>()) as ReadonlyMap<string, string>);",
          'LOOKUP.set("x", "y");',
        ].join("\n"),
      },
      {
        id: "synthetic-weak.ts",
        imports: [],
        source: [
          "const WEAK_MAP = Object.freeze(new WeakMap<object, string>());",
          "const WEAK_SET = (((new WeakSet<object>())));",
          'WEAK_MAP.set({}, "x");',
          "consume(WEAK_SET);",
        ].join("\n"),
      },
    ];
    const allowlist = new Set([
      "synthetic-set.ts:LOOKUP",
      "synthetic-map.ts:LOOKUP",
      "synthetic-weak.ts:WEAK_MAP",
      "synthetic-weak.ts:WEAK_SET",
    ]);

    expect(reviewedReadonlyCollectionViolations(synthetic, allowlist)).toEqual([
      "synthetic-map.ts:LOOKUP:2:mutation:set",
      "synthetic-set.ts:LOOKUP:2:mutation:add",
      "synthetic-set.ts:LOOKUP:3:mutation:delete",
      "synthetic-set.ts:LOOKUP:4:mutation:clear",
      "synthetic-set.ts:LOOKUP:5:property-write",
      "synthetic-set.ts:LOOKUP:6:element-write",
      "synthetic-set.ts:LOOKUP:7:call-escape",
      "synthetic-set.ts:LOOKUP:8:assignment-escape",
      "synthetic-set.ts:LOOKUP:9:return-escape",
      "synthetic-weak.ts:WEAK_MAP:3:mutation:set",
      "synthetic-weak.ts:WEAK_SET:4:call-escape",
    ]);
  });

  it("permits only explicit readonly collection lookups and iteration", () => {
    const modules: SourceModule[] = [
      {
        id: "synthetic.ts",
        imports: [],
        source: [
          'const LOOKUP = Object.freeze(new Map<string, string>([["x", "y"]]));',
          'const VALUES = ((new Set<string>(["x"])) as ReadonlySet<string>);',
          "const WEAK_KEYS = (new WeakMap<object, string>()) satisfies WeakMap<object, string>;",
          "const WEAK_VALUES = (((new WeakSet<object>())));",
          'LOOKUP.has("x");',
          'LOOKUP.get("x");',
          'VALUES.has("x");',
          "WEAK_KEYS.get({});",
          "WEAK_VALUES.has({});",
          "for (const entry of LOOKUP) render(entry);",
        ].join("\n"),
      },
    ];

    expect(
      reviewedReadonlyCollectionViolations(
        modules,
        new Set([
          "synthetic.ts:LOOKUP",
          "synthetic.ts:VALUES",
          "synthetic.ts:WEAK_KEYS",
          "synthetic.ts:WEAK_VALUES",
        ]),
      ),
    ).toEqual([]);
  });

  it("composes real Env from adapters that own filesystem, resource transport, process, credential, and authority implementations", () => {
    const adapterIds = [
      "runtime/credential-adapter.ts",
      "runtime/filesystem-adapter.ts",
      "runtime/mutation-authority-adapter.ts",
      "runtime/process-platform-adapter.ts",
      "runtime/resource-source-transport-adapter.ts",
    ];
    const realEnv = modules.find(({ id }) => id === "real-env.ts");
    if (!realEnv) throw new Error("missing real-env composition root");
    const nodeImports = stripComments(realEnv.source).match(/from\s+["']node:[^"']+["']/g) ?? [];

    expect(modules.filter(({ id }) => adapterIds.includes(id)).map(({ id }) => id)).toEqual(
      adapterIds,
    );
    expect(nodeImports).toEqual([]);
    expect(realEnv.imports).toEqual(expect.arrayContaining(adapterIds));
    expect(modules.some(({ id }) => id === "runtime/node-runtime-primitives.ts")).toBe(false);

    const implementationOwners = [
      ["runtime/filesystem-adapter.ts", "createRealFilesystemAdapter"],
      ["runtime/mutation-authority-adapter.ts", "headlessLifetimeOwner"],
      ["runtime/resource-source-transport-adapter.ts", "createRealResourceSourceTransport"],
    ] as const;
    for (const [id, implementation] of implementationOwners) {
      const adapter = modules.find((module) => module.id === id);
      if (!adapter) throw new Error(`missing ${id}`);
      expect(adapter.source).toMatch(new RegExp(`(?:function|const)\\s+${implementation}\\b`, "u"));
      expect(adapter.source).not.toMatch(/export\s+(?:type\s+)?\{[\s\S]*?\}\s+from/u);
    }

    const filesystem =
      modules.find(({ id }) => id === "runtime/filesystem-adapter.ts")?.source ?? "";
    const authority =
      modules.find(({ id }) => id === "runtime/mutation-authority-adapter.ts")?.source ?? "";
    const resource =
      modules.find(({ id }) => id === "runtime/resource-source-transport-adapter.ts")?.source ?? "";
    expect(filesystem).toMatch(/execFileSync/u);
    expect(filesystem).not.toMatch(/node:(?:net|zlib)/u);
    expect(authority).toMatch(/node:net/u);
    expect(authority).not.toMatch(/node:(?:child_process|zlib)/u);
    expect(resource).toMatch(/node:(?:child_process|zlib)/u);
    expect(resource).not.toMatch(/node:net/u);
  });

  it("forbids free-form reasons and messages from selecting policy or transport behavior", () => {
    const decisionTextDependencies = decisionTextControlDependencies([
      ...walkTypeScriptFiles(sourceRoot),
      ...walkTypeScriptFiles(resolve(repositoryRoot, "packages/cli/src")),
      ...walkTypeScriptFiles(resolve(repositoryRoot, "packages/web/src")),
      ...walkTypeScriptFiles(resolve(repositoryRoot, "packages/web/client")),
    ]);

    expect(decisionTextDependencies).toEqual([]);
  });

  it("detects direct, indexed, destructured, aliased, parameter, helper, regex, and message decisions", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "cellarer-free-text-ast-"));
    const fixture = join(fixtureRoot, "decisions.tsx");
    writeFileSync(
      fixture,
      [
        "if (action.reason) deny();",
        'if (action["reason"]?.includes("blocked")) deny();',
        'const { reason } = action; if (reason === "blocked") deny();',
        'const { reason: diagnostic } = action; if (diagnostic.startsWith("blocked")) deny();',
        'if (/not supported/.test(action.reason ?? "")) deny();',
        'const status = error.message === "stale" ? 409 : 500;',
        "const copy = action;",
        'if (copy.reason === "blocked") deny();',
        'function decide({ reason }: PlanAction) { if (reason === "blocked") deny(); }',
        'function renamed({ reason: diagnostic }: PlanAction) { if (diagnostic.includes("blocked")) deny(); }',
        "function blocked(text: string) {",
        '  return text.startsWith("blocked");',
        "}",
        "if (blocked(action.reason)) deny();",
        'function decideCandidate(candidate: PlanAction) { if (candidate.reason === "blocked") deny(); }',
        "decideCandidate(action);",
        "inspect(action.reason);",
        "function reasonFor(candidate: PlanAction) { return candidate.reason; }",
        'if (reasonFor(action) === "blocked") deny();',
        "function present(text: string) { render(text); }",
        "present(action.reason);",
        "render(action.reason);",
      ].join("\n"),
      "utf8",
    );
    try {
      expect(decisionTextControlDependencies([fixture])).toEqual(
        [
          `${relative(repositoryRoot, fixture)}:1`,
          `${relative(repositoryRoot, fixture)}:2`,
          `${relative(repositoryRoot, fixture)}:3`,
          `${relative(repositoryRoot, fixture)}:4`,
          `${relative(repositoryRoot, fixture)}:5`,
          `${relative(repositoryRoot, fixture)}:6`,
          `${relative(repositoryRoot, fixture)}:8`,
          `${relative(repositoryRoot, fixture)}:9`,
          `${relative(repositoryRoot, fixture)}:10`,
          `${relative(repositoryRoot, fixture)}:12`,
          `${relative(repositoryRoot, fixture)}:15`,
          `${relative(repositoryRoot, fixture)}:17`,
          `${relative(repositoryRoot, fixture)}:19`,
        ].sort(),
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("detects exported typed action helper decisions without flagging rendering or logging", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "cellarer-free-text-helper-"));
    const decisions = join(fixtureRoot, "decisions.ts");
    const presentation = join(fixtureRoot, "presentation.ts");
    writeFileSync(
      decisions,
      [
        "export function truth(candidate: PlanAction) {",
        "  if (candidate.reason) deny();",
        "}",
        "export function comparison(selection: PlanAction) {",
        '  return selection.message === "blocked";',
        "}",
        "export function stringDecision(payload: PlanAction) {",
        '  return payload.reason?.includes("blocked");',
        "}",
        "export function regexDecision(record: PlanAction) {",
        '  return /blocked/u.test(record.message ?? "");',
        "}",
        "export function diagnostic(subject: PlanAction) {",
        "  return subject.reason;",
        "}",
        "export function propagated(operation: PlanAction) {",
        '  return diagnostic(operation) === "blocked";',
        "}",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      presentation,
      [
        "export function present(candidate: PlanAction) {",
        "  render(candidate.reason);",
        "  console.log(candidate.message);",
        "  output.warn(candidate.reason);",
        "  if (candidate.message) render(candidate.message);",
        "}",
      ].join("\n"),
      "utf8",
    );
    try {
      expect(decisionTextControlDependencies([decisions, presentation])).toEqual(
        [2, 5, 8, 11, 17].map((line) => `${relative(repositoryRoot, decisions)}:${line}`).sort(),
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

describe("Core runtime effect ordering", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
  });

  afterEach(() => t.cleanup());

  it("injects exactly the provider capabilities selected by each secret metadata use case", () => {
    const capabilityKeys = (
      useCase: Parameters<typeof secretMetadataCapabilitiesFor>[1],
    ): string[] => Object.keys(secretMetadataCapabilitiesFor(t.env, useCase)).sort();

    expect(capabilityKeys("vault-write")).toEqual([
      "assertVaultMutationSupported",
      "assertVaultSecurity",
      "encryptVault",
      "vaultPath",
    ]);
    expect(capabilityKeys("vault-set")).toEqual(["encryptVault", "loadVault", "vaultPath"]);
    expect(capabilityKeys("vault-delete")).toEqual(["encryptVault", "loadVault", "vaultPath"]);
    expect(capabilityKeys("keychain-set")).toEqual(["setKeychain"]);
    expect(capabilityKeys("keychain-delete")).toEqual(["deleteKeychain"]);
  });

  it("rejects stale authority before Store or provider access and does not disclose the input", async () => {
    const canary = "stale-authority-low-entropy-canary";
    const events: string[] = [];
    const env: Env = {
      ...t.env,
      mutationAuthority: deterministicMutationAuthority({
        isCurrent: async () => {
          events.push("authority-current");
          return false;
        },
      }),
      secretStore: {
        async get() {
          events.push("provider-get");
          return { found: false };
        },
        async set() {
          events.push("provider-set");
        },
        async delete() {
          events.push("provider-delete");
          return false;
        },
      },
      fs: {
        ...t.env.fs,
        async readFile(path) {
          events.push("store-read");
          return t.env.fs.readFile(path);
        },
        async readdir(path) {
          events.push("store-list");
          return t.env.fs.readdir(path);
        },
        async lstat(path) {
          events.push("store-lstat");
          return t.env.fs.lstat(path);
        },
        async writeFileExclusive(path, data, options) {
          events.push("lock");
          return t.env.fs.writeFileExclusive(path, data, options);
        },
        async publishFileAtomically(path, data, options) {
          events.push("publish");
          return t.env.fs.publishFileAtomically(path, data, options);
        },
      },
    };

    const rejected = await setStoredSecret(env, storeRoot, {
      provider: "keychain",
      name: "RUNTIME_BOUNDARY",
      value: canary,
    }).catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(TypeError);
    expect(String(rejected)).toBe("TypeError: mutation authority is not current");
    expect(JSON.stringify(rejected)).not.toContain(canary);
    expect(events).toEqual(["authority-current"]);
  });

  it("executes read-only provider observation without mutation authority or provider write methods", async () => {
    const provider = {
      async get() {
        return { found: true as const, value: "read-only-canary" };
      },
    };
    const readOnlyEnv = {
      env: {},
      secretStore: provider,
    };

    const result = await verifySecretReferences(
      readOnlyEnv,
      "/read-only-store",
      [{ kind: "cellarer", name: "READ_ONLY" }],
      { mode: "keychain" },
    );

    expect(result).toEqual([
      {
        reference: "$" + "{CELLARER_SECRET:READ_ONLY}",
        provider: "keychain",
        status: "available",
      },
    ]);
    expect(Object.hasOwn(readOnlyEnv, "mutationAuthority")).toBe(false);
    expect(Object.keys(provider)).toEqual(["get"]);
  });

  it("compiles the public reference verifier with only its read capabilities", () => {
    expect(secretReferenceVerificationContractDiagnostics()).toEqual([]);
  });

  it("projects privileged Env objects into capability-free read-only scope carriers", () => {
    const privilegedEnv: Env = {
      ...t.env,
      mutationAuthority: deterministicMutationAuthority(),
      secretStore: {
        get: async () => ({ found: false }),
        set: async () => undefined,
        delete: async () => false,
      },
    };

    const input = createSecretObservationUseCaseInput(privilegedEnv, "keychain-get");

    expect(input.scopeCarrier).not.toBe(privilegedEnv);
    expect(Object.keys(input.scopeCarrier)).toEqual([]);
    expect(Object.keys(input.observation).sort()).toEqual(["getKeychain", "keychainAvailable"]);
    expect(
      Object.keys(createSecretObservationUseCaseInput(privilegedEnv, "vault-read").observation),
    ).toEqual(["loadVault"]);
    expect(
      Object.keys(
        createSecretObservationUseCaseInput(privilegedEnv, "keychain-inventory").observation,
      ).sort(),
    ).toEqual(["getKeychain", "keychainAvailable", "listManagedKeychainNames"]);
    expect(
      Object.keys(
        createSecretObservationUseCaseInput(privilegedEnv, "environment-only").observation,
      ),
    ).toEqual([]);
  });

  it("prepares the Store publication guard from its narrow read-only context", async () => {
    await initStore(t.env, storeRoot);
    const canary = "narrow-publication-guard-canary";
    const context = {
      env: { API_TOKEN: canary },
      fs: {
        lstat: t.env.fs.lstat,
        readFile: t.env.fs.readFile,
        readdir: t.env.fs.readdir,
        snapshotFileNoFollow: t.env.fs.snapshotFileNoFollow,
        snapshotTreeNoFollow: t.env.fs.snapshotTreeNoFollow,
        supportsSafeRecursiveSnapshots: t.env.fs.supportsSafeRecursiveSnapshots,
      },
      ...(t.env.secretStore ? { secretStore: { get: t.env.secretStore.get } } : {}),
    };

    const prepared = await activeSecretPublicationGuard.prepare(context, storeRoot);

    expect(Object.keys(prepared.env).sort()).toEqual(Object.keys(context).sort());
    expect(Object.hasOwn(prepared.env, "mutationAuthority")).toBe(false);
    expect(Object.hasOwn(prepared.env, "cwd")).toBe(false);
    expect(prepared.knownValues).toHaveLength(1);
    expect(prepared.knownValues[0]?.use((value) => value)).toBe(canary);
  });

  it("rejects reserved credential targets before authority, intent, or provider effects", async () => {
    await initStore(t.env, storeRoot);
    const events: string[] = [];
    const originalPublish = t.env.fs.publishFileAtomically;
    const env: Env = {
      ...t.env,
      mutationAuthority: deterministicMutationAuthority({
        isCurrent: async () => {
          events.push("authority-current");
          return true;
        },
      }),
      secretStore: {
        async get() {
          events.push("provider-get");
          return { found: false };
        },
        async set() {
          events.push("provider-set");
        },
        async delete() {
          events.push("provider-delete");
          return false;
        },
      },
      fs: {
        ...t.env.fs,
        async publishFileAtomically(path, data, options) {
          events.push("publish");
          return originalPublish(path, data, options);
        },
      },
    };

    const rejected = await setStoredSecret(env, storeRoot, {
      provider: "keychain",
      name: "RUNTIME_BOUNDARY",
      value: "reserved-target-canary",
      keychainService: MUTATION_AUTHORITY_CREDENTIAL_SERVICE,
    }).catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(TypeError);
    expect(String(rejected)).toBe("TypeError: reserved mutation authority credential namespace");
    expect(events).toEqual([]);
  });

  it("publishes keychain intent before provider access and final metadata afterward", async () => {
    await initStore(t.env, storeRoot);
    const canary = "keychain-boundary-low-entropy-canary";
    const events: string[] = [];
    const metadataPath = keychainMetadataPath(storeRoot, "cellarer", "RUNTIME_BOUNDARY");
    const originalPublish = t.env.fs.publishFileAtomically;
    const originalWrite = t.env.fs.writeFile;
    const env: Env = {
      ...t.env,
      mutationAuthority: deterministicMutationAuthority({
        isCurrent: async () => {
          events.push("authority-current");
          return true;
        },
        onAcquireLease: () => events.push("authority-lease"),
      }),
      secretStore: {
        async get() {
          events.push("provider-get");
          return { found: false };
        },
        async set(_service, _account, value) {
          expect(value).toBe(canary);
          events.push("provider-set");
        },
        async delete() {
          events.push("provider-delete");
          return false;
        },
      },
      fs: {
        ...t.env.fs,
        async writeFile(path, data, options) {
          if (path === metadataPath) events.push("metadata-direct-write");
          return originalWrite(path, data, options);
        },
        async publishFileAtomically(path, data, options) {
          if (path === metadataPath) {
            events.push(
              data.includes('"status": "executing"') ? "metadata-intent" : "metadata-final",
            );
          }
          return originalPublish(path, data, options);
        },
      },
    };

    const result = await setStoredSecret(env, storeRoot, {
      provider: "keychain",
      name: "RUNTIME_BOUNDARY",
      value: canary,
    });

    const boundaryEvents = events.filter((event) =>
      ["authority-lease", "metadata-intent", "provider-set", "metadata-final"].includes(event),
    );
    expect(boundaryEvents).toEqual([
      "authority-lease",
      "metadata-intent",
      "provider-set",
      "metadata-final",
    ]);
    expect(events).not.toContain("metadata-direct-write");
    expect(result.operation).toMatchObject({ ok: true });
    for (const observable of [
      JSON.stringify(result),
      await t.env.fs.readFile(metadataPath),
      JSON.stringify(await listOperationReceipts(t.env, storeRoot)),
    ]) {
      expect(observable).not.toContain(canary);
    }
  });

  it("runs the final-byte guard before atomic publication and publishes safe bytes atomically", async () => {
    await initStore(t.env, storeRoot);
    const canary = "final-byte-low-entropy-canary";
    const target = t.path("home", ".cellarer", "store", "rules", "runtime-boundary.md");
    const targetPublications: string[] = [];
    const directTargetWrites: string[] = [];
    const originalPublish = t.env.fs.publishFileAtomically;
    const originalWrite = t.env.fs.writeFile;
    const env: Env = {
      ...t.env,
      env: { API_TOKEN: canary },
      fs: {
        ...t.env.fs,
        async writeFile(path, data, options) {
          if (path === target) directTargetWrites.push(data);
          return originalWrite(path, data, options);
        },
        async publishFileAtomically(path, data, options) {
          if (path === target) targetPublications.push(data);
          return originalPublish(path, data, options);
        },
      },
    };
    const publish = (data: string) =>
      executeStorePublicationMutation(
        env,
        storeRoot,
        "settings",
        "config-update",
        async () => ({
          value: undefined,
          publications: [{ path: target, data, mode: 0o600 }],
        }),
        {
          normalizedInputs: {
            businessInput: { kind: "settings", action: "update", settings: { method: "copy" } },
            changedFields: ["defaults.method"],
          },
          provenancePaths: [target],
          selfContainedPublications: true,
          secretPublicationGuard: activeSecretPublicationGuard,
        },
      );

    const rejected = await publish(`unsafe ${canary}`).catch((error: unknown) => error);

    expect(rejected).toMatchObject({ code: "FINAL_SECRET_BYTE_GUARD" });
    expect(String(rejected)).not.toContain(canary);
    expect(targetPublications).toEqual([]);
    await expect(t.env.fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });

    const safe = "safe runtime boundary bytes\n";
    const accepted = await publish(safe);

    expect(accepted.operation).toMatchObject({ ok: true });
    expect(targetPublications).toEqual([safe]);
    expect(directTargetWrites).toEqual([]);
    await expect(t.env.fs.readFile(target)).resolves.toBe(safe);
  });
});

function loadSourceModules(): SourceModule[] {
  return loadSourceModulesFrom(sourceRoot);
}

function loadSourceModulesFrom(root: string): SourceModule[] {
  const files = walkTypeScriptFiles(root);
  return files.map((path) => {
    const source = readFileSync(path, "utf8");
    const id = moduleId(path, root);
    const imports = sourceModuleSpecifiers(id, path, source)
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) => {
        const resolved = resolveInternalModule(path, specifier, root);
        if (!resolved) {
          throw new TypeError(`unresolved first-party import in ${id}: ${specifier}`);
        }
        return resolved;
      });
    return { id, source, imports: [...new Set(imports)].sort() };
  });
}

function sourceModuleSpecifiers(id: string, path: string, source: string): string[] {
  const file = tsRuntime.createSourceFile(
    path,
    source,
    tsRuntime.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? tsRuntime.ScriptKind.TSX : tsRuntime.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const parseDiagnostics = (
    file as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  if (parseDiagnostics && parseDiagnostics.length > 0) {
    throw new TypeError(`TypeScript parse failed for dependency source ${id}`);
  }
  const addLiteral = (node: ts.Expression): void => {
    if (tsRuntime.isStringLiteral(node) || tsRuntime.isNoSubstitutionTemplateLiteral(node)) {
      specifiers.push(node.text);
    }
  };
  const visit = (node: ts.Node): void => {
    if (tsRuntime.isImportDeclaration(node) || tsRuntime.isExportDeclaration(node)) {
      if (node.moduleSpecifier) addLiteral(node.moduleSpecifier);
    } else if (
      tsRuntime.isImportEqualsDeclaration(node) &&
      tsRuntime.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    ) {
      addLiteral(node.moduleReference.expression);
    } else if (
      tsRuntime.isCallExpression(node) &&
      node.expression.kind === tsRuntime.SyntaxKind.ImportKeyword
    ) {
      const [specifier] = node.arguments;
      if (
        specifier &&
        (tsRuntime.isStringLiteral(specifier) ||
          tsRuntime.isNoSubstitutionTemplateLiteral(specifier))
      ) {
        specifiers.push(specifier.text);
      } else {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        throw new TypeError(`non-literal dynamic import is forbidden in ${id}:${line}`);
      }
    }
    tsRuntime.forEachChild(node, visit);
  };
  visit(file);
  return specifiers;
}

function walkTypeScriptFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(root, entry.name);
      if (entry.isDirectory()) return walkTypeScriptFiles(path);
      return entry.isFile() && /\.tsx?$/u.test(entry.name) ? [path] : [];
    })
    .sort();
}

function resolveInternalModule(importer: string, specifier: string, root: string): string | null {
  const withoutJavaScriptExtension = specifier.replace(/\.(?:c|m)?js$/u, "");
  const candidate = resolve(dirname(importer), withoutJavaScriptExtension);
  for (const path of [
    `${candidate}.ts`,
    `${candidate}.tsx`,
    resolve(candidate, "index.ts"),
    resolve(candidate, "index.tsx"),
  ]) {
    if (!existsSync(path)) continue;
    const id = moduleId(path, root);
    if (id === ".." || id.startsWith("../")) {
      throw new TypeError(
        `resolved outside Core source root in ${moduleId(importer, root)}: ${specifier}`,
      );
    }
    return id;
  }
  return null;
}

function moduleId(path: string, root = sourceRoot): string {
  return relative(root, path).replaceAll("\\", "/");
}

function moduleRole(id: string): BoundaryRole | null {
  for (const role of Object.keys(BOUNDARY_ROLE_INVENTORY) as BoundaryRole[]) {
    if (BOUNDARY_ROLE_INVENTORY[role].includes(id)) return role;
  }
  return null;
}

function isBoundaryModule(id: string): boolean {
  return (
    id === "env.ts" ||
    id === "real-env.ts" ||
    id.startsWith("runtime/") ||
    id.startsWith("secrets/") ||
    id.startsWith("protocol/")
  );
}

function boundaryInventoryViolations(modules: readonly SourceModule[]): string[] {
  const boundaryIds = modules.filter(({ id }) => isBoundaryModule(id)).map(({ id }) => id);
  const inventoryIds = Object.values(BOUNDARY_ROLE_INVENTORY).flat();
  const inventoryCounts = new Map<string, number>();
  for (const id of inventoryIds) inventoryCounts.set(id, (inventoryCounts.get(id) ?? 0) + 1);
  return [
    ...boundaryIds.filter((id) => moduleRole(id) === null).map((id) => `unclassified:${id}`),
    ...inventoryIds.filter((id) => !boundaryIds.includes(id)).map((id) => `missing:${id}`),
    ...[...inventoryCounts]
      .filter(([, count]) => count !== 1)
      .map(([id, count]) => `roles:${id}:${count}`),
  ].sort();
}

function forbiddenConcreteProviderEdges(
  modules: readonly SourceModule[],
  concreteProviders: ReadonlySet<string>,
): string[] {
  return modules.flatMap(({ id, imports }) =>
    moduleRole(id) === "domain"
      ? imports
          .filter((target) => concreteProviders.has(target))
          .map((target) => `${id}->${target}`)
      : [],
  );
}

function roleEdges(modules: readonly SourceModule[]): string[] {
  const edges = new Set<string>();
  for (const source of modules) {
    const sourceRole = moduleRole(source.id);
    if (!sourceRole) continue;
    for (const target of source.imports) {
      const targetRole = moduleRole(target);
      if (targetRole && targetRole !== sourceRole) edges.add(`${sourceRole}->${targetRole}`);
    }
  }
  return [...edges].sort();
}

function stronglyConnectedComponents(modules: readonly SourceModule[]): string[][] {
  const graph = new Map(modules.map((module) => [module.id, module.imports]));
  const indexById = new Map<string, number>();
  const lowLinkById = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;

  const visit = (id: string): void => {
    indexById.set(id, nextIndex);
    lowLinkById.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);

    for (const target of graph.get(id) ?? []) {
      if (!graph.has(target)) continue;
      if (!indexById.has(target)) {
        visit(target);
        lowLinkById.set(id, Math.min(lowLinkById.get(id) ?? 0, lowLinkById.get(target) ?? 0));
      } else if (onStack.has(target)) {
        lowLinkById.set(id, Math.min(lowLinkById.get(id) ?? 0, indexById.get(target) ?? 0));
      }
    }

    if (lowLinkById.get(id) !== indexById.get(id)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop();
      if (!member) break;
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    components.push(component);
  };

  for (const id of graph.keys()) {
    if (!indexById.has(id)) visit(id);
  }
  return components;
}

function dependencyCycles(modules: readonly SourceModule[]): string[][] {
  const graph = new Map(modules.map((module) => [module.id, module.imports]));
  return stronglyConnectedComponents(modules)
    .filter(
      (component) =>
        component.length > 1 ||
        (component.length === 1 &&
          (graph.get(component[0] ?? "") ?? []).includes(component[0] ?? "")),
    )
    .map((component) => [...component].sort())
    .sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function moduleGlobalMutableIdentityFindings(modules: readonly SourceModule[]): string[] {
  const findings: string[] = [];
  for (const module of modules) {
    const file = tsRuntime.createSourceFile(
      module.id,
      module.source,
      tsRuntime.ScriptTarget.Latest,
      true,
    );
    for (const statement of file.statements) {
      if (!tsRuntime.isVariableStatement(statement)) continue;
      const declarationKind = statement.declarationList.flags & tsRuntime.NodeFlags.Const;
      for (const declaration of statement.declarationList.declarations) {
        if (!tsRuntime.isIdentifier(declaration.name)) continue;
        const name = declaration.name.text;
        if (!declarationKind || isMutableIdentityInitializer(name, declaration.initializer)) {
          findings.push(`${module.id}:${name}`);
        }
      }
    }
  }
  return findings.sort();
}

function isMutableIdentityInitializer(
  name: string,
  initializer: ts.Expression | undefined,
): boolean {
  if (!initializer) return false;
  const value = unwrapMutableIdentityInitializer(initializer);
  if (tsRuntime.isNewExpression(value) && tsRuntime.isIdentifier(value.expression)) {
    if (["Map", "Set", "WeakMap", "WeakSet"].includes(value.expression.text)) return true;
  }
  if (tsRuntime.isObjectLiteralExpression(value)) {
    return (
      /(?:cache|counter|identit|owner|registry|scope|state)$/iu.test(name) ||
      value.properties.some(
        (property) =>
          tsRuntime.isPropertyAssignment(property) &&
          ((tsRuntime.isIdentifier(property.name) &&
            /counter|identity|state/iu.test(property.name.text)) ||
            (tsRuntime.isStringLiteral(property.name) &&
              /counter|identity|state/iu.test(property.name.text))),
      )
    );
  }
  return (
    tsRuntime.isArrayLiteralExpression(value) &&
    /(?:cache|counter|identit|owner|registry|scope|state)$/iu.test(name)
  );
}

function unwrapMutableIdentityInitializer(initializer: ts.Expression): ts.Expression {
  let value = unwrapExpression(initializer);
  if (
    tsRuntime.isCallExpression(value) &&
    tsRuntime.isPropertyAccessExpression(value.expression) &&
    tsRuntime.isIdentifier(value.expression.expression) &&
    value.expression.expression.text === "Object" &&
    value.expression.name.text === "freeze" &&
    value.arguments[0]
  ) {
    const frozen = unwrapExpression(value.arguments[0]);
    if (
      tsRuntime.isNewExpression(frozen) &&
      tsRuntime.isIdentifier(frozen.expression) &&
      ["Map", "Set", "WeakMap", "WeakSet"].includes(frozen.expression.text)
    ) {
      value = frozen;
    }
  }
  return value;
}

function reviewedReadonlyCollectionViolations(
  modules: readonly SourceModule[],
  allowlist: ReadonlySet<string>,
): string[] {
  const findings: string[] = [];
  const reviewed = new Set<string>();
  const readonlyMethods = new Set(["get", "has"]);
  const mutationMethods = new Set(["add", "clear", "delete", "set"]);
  for (const module of modules) {
    const names = [...allowlist]
      .filter((entry) => entry.startsWith(`${module.id}:`))
      .map((entry) => entry.slice(module.id.length + 1));
    if (names.length === 0) continue;
    const file = tsRuntime.createSourceFile(
      module.id,
      module.source,
      tsRuntime.ScriptTarget.Latest,
      true,
    );
    const declarations = new Map<string, ts.VariableDeclaration>();
    for (const statement of file.statements) {
      if (!tsRuntime.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (tsRuntime.isIdentifier(declaration.name) && names.includes(declaration.name.text)) {
          declarations.set(declaration.name.text, declaration);
          reviewed.add(`${module.id}:${declaration.name.text}`);
        }
      }
    }
    const record = (name: string, node: ts.Node, reason: string): void => {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      findings.push(`${module.id}:${name}:${line}:${reason}`);
    };
    const visit = (node: ts.Node): void => {
      if (!tsRuntime.isIdentifier(node) || !declarations.has(node.text)) {
        tsRuntime.forEachChild(node, visit);
        return;
      }
      const declaration = declarations.get(node.text);
      if (declaration?.name === node) return;
      const reference = transparentExpressionParent(node);
      const parent = reference.parent;
      if (tsRuntime.isForOfStatement(parent) && parent.expression === reference) return;
      if (
        (tsRuntime.isPropertyAccessExpression(parent) || tsRuntime.isPropertyAccessChain(parent)) &&
        parent.expression === reference
      ) {
        const method = parent.name.text;
        if (isAssignmentTarget(parent)) {
          record(node.text, node, "property-write");
          return;
        }
        if (tsRuntime.isCallExpression(parent.parent) && parent.parent.expression === parent) {
          if (readonlyMethods.has(method)) return;
          record(
            node.text,
            node,
            mutationMethods.has(method) ? `mutation:${method}` : `method:${method}`,
          );
          return;
        }
        record(node.text, node, `property-read:${method}`);
        return;
      }
      if (tsRuntime.isElementAccessExpression(parent) && parent.expression === reference) {
        record(node.text, node, isAssignmentTarget(parent) ? "element-write" : "element-read");
        return;
      }
      if (
        tsRuntime.isCallExpression(parent) &&
        parent.arguments.includes(reference as ts.Expression)
      ) {
        record(node.text, node, "call-escape");
        return;
      }
      if (tsRuntime.isVariableDeclaration(parent) && parent.initializer === reference) {
        record(node.text, node, "assignment-escape");
        return;
      }
      if (tsRuntime.isReturnStatement(parent)) {
        record(node.text, node, "return-escape");
        return;
      }
      if (
        tsRuntime.isBinaryExpression(parent) &&
        parent.right === reference &&
        parent.operatorToken.kind === tsRuntime.SyntaxKind.EqualsToken
      ) {
        record(node.text, node, "assignment-escape");
        return;
      }
      record(node.text, node, "escape");
    };
    visit(file);
  }
  for (const entry of allowlist) {
    if (!reviewed.has(entry)) findings.push(`${entry}:missing-declaration`);
  }
  return findings.sort();
}

function transparentExpressionParent(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    (tsRuntime.isAsExpression(current.parent) ||
      tsRuntime.isTypeAssertionExpression(current.parent) ||
      tsRuntime.isNonNullExpression(current.parent) ||
      tsRuntime.isParenthesizedExpression(current.parent) ||
      tsRuntime.isSatisfiesExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return current;
}

function isAssignmentTarget(node: ts.Expression): boolean {
  let current: ts.Expression = node;
  while (tsRuntime.isParenthesizedExpression(current.parent)) current = current.parent;
  return (
    tsRuntime.isBinaryExpression(current.parent) &&
    current.parent.left === current &&
    current.parent.operatorToken.kind === tsRuntime.SyntaxKind.EqualsToken
  );
}

function decisionTextControlDependencies(paths: readonly string[]): string[] {
  const findings = new Set<string>();
  const textDecisionMethods = new Set([
    "endsWith",
    "includes",
    "match",
    "search",
    "startsWith",
    "test",
  ]);
  const comparisonOperators = new Set([
    tsRuntime.SyntaxKind.EqualsEqualsEqualsToken,
    tsRuntime.SyntaxKind.ExclamationEqualsEqualsToken,
    tsRuntime.SyntaxKind.EqualsEqualsToken,
    tsRuntime.SyntaxKind.ExclamationEqualsToken,
  ]);
  for (const path of paths) {
    const file = tsRuntime.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      tsRuntime.ScriptTarget.Latest,
      true,
      path.endsWith(".tsx") ? tsRuntime.ScriptKind.TSX : tsRuntime.ScriptKind.TS,
    );
    const flow = decisionTextFlow(file);
    const containsDecisionText = (node: ts.Node): boolean =>
      containsDecisionTextReference(node, flow);
    const record = (node: ts.Node): void => {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      findings.add(`${relative(repositoryRoot, path)}:${line}`);
    };
    const visit = (node: ts.Node): void => {
      const condition = tsRuntime.isConditionalExpression(node)
        ? node.condition
        : tsRuntime.isIfStatement(node) ||
            tsRuntime.isWhileStatement(node) ||
            tsRuntime.isDoStatement(node) ||
            tsRuntime.isSwitchStatement(node)
          ? node.expression
          : undefined;
      if (
        condition &&
        isDecisionTextValueExpression(condition, flow) &&
        !isPresentationOnlyCondition(node) &&
        !(tsRuntime.isCallExpression(condition) && localFunctionForCall(condition, flow))
      ) {
        record(condition);
      }
      if (
        tsRuntime.isBinaryExpression(node) &&
        comparisonOperators.has(node.operatorToken.kind) &&
        !tsRuntime.isTypeOfExpression(node.left) &&
        !tsRuntime.isTypeOfExpression(node.right) &&
        ((isDecisionTextValueExpression(node.left, flow) &&
          tsRuntime.isStringLiteral(node.right)) ||
          (isDecisionTextValueExpression(node.right, flow) && tsRuntime.isStringLiteral(node.left)))
      ) {
        record(node);
      }
      if (
        tsRuntime.isCallExpression(node) &&
        tsRuntime.isPropertyAccessExpression(node.expression)
      ) {
        const method = node.expression.name.text;
        if (textDecisionMethods.has(method) && containsDecisionText(node)) {
          record(node);
        }
      }
      if (
        tsRuntime.isCallExpression(node) &&
        node.arguments.some(containsDecisionText) &&
        !localFunctionForCall(node, flow) &&
        !isPresentationOnlyCall(node) &&
        !isDecisionTextMethodCall(node, textDecisionMethods, flow)
      ) {
        record(node);
      }
      tsRuntime.forEachChild(node, visit);
    };
    visit(file);
  }
  return [...findings].sort();
}

interface DecisionTextFlow {
  readonly file: ts.SourceFile;
  readonly functions: readonly ScopedFunction[];
  readonly objectAliases: readonly ScopedAlias[];
  readonly returnedTextFunctions: ReadonlySet<ts.FunctionLikeDeclaration>;
  readonly textAliases: readonly ScopedAlias[];
}

interface ScopedAlias {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

interface ScopedFunction extends ScopedAlias {
  readonly declaration: ts.FunctionLikeDeclaration;
}

function decisionTextFlow(file: ts.SourceFile): DecisionTextFlow {
  const functions: ScopedFunction[] = [];
  const objectAliases: ScopedAlias[] = [];
  const returnedTextFunctions = new Set<ts.FunctionLikeDeclaration>();
  const textAliases: ScopedAlias[] = [];
  const flow: DecisionTextFlow = {
    file,
    functions,
    objectAliases,
    returnedTextFunctions,
    textAliases,
  };
  const addAlias = (
    aliases: ScopedAlias[],
    node: ts.Identifier,
    start: number,
    end: number,
  ): boolean => {
    if (
      aliases.some(
        (alias) => alias.name === node.text && alias.start === start && alias.end === end,
      )
    ) {
      return false;
    }
    aliases.push({ name: node.text, start, end });
    return true;
  };
  const collectFunctions = (node: ts.Node): void => {
    if (tsRuntime.isFunctionDeclaration(node) && node.name) {
      const scope = nearestLexicalScope(node, file);
      functions.push({
        name: node.name.text,
        start: scope.getStart(file),
        end: scope.end,
        declaration: node,
      });
    } else if (
      tsRuntime.isVariableDeclaration(node) &&
      tsRuntime.isIdentifier(node.name) &&
      node.initializer &&
      (tsRuntime.isArrowFunction(node.initializer) ||
        tsRuntime.isFunctionExpression(node.initializer))
    ) {
      const scope = nearestLexicalScope(node, file);
      functions.push({
        name: node.name.text,
        start: node.end,
        end: scope.end,
        declaration: node.initializer,
      });
    }
    tsRuntime.forEachChild(node, collectFunctions);
  };
  collectFunctions(file);
  for (const { declaration: fn } of functions) {
    const scope = functionBodyScope(fn, file);
    for (const parameter of fn.parameters) {
      if (
        tsRuntime.isIdentifier(parameter.name) &&
        (parameter.name.text === "action" || typeReferencesPlanAction(parameter.type))
      ) {
        addAlias(objectAliases, parameter.name, scope.start, scope.end);
      } else if (tsRuntime.isObjectBindingPattern(parameter.name)) {
        addSensitiveBindings(parameter.name, textAliases, scope);
      }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if (tsRuntime.isVariableDeclaration(node)) {
        if (tsRuntime.isObjectBindingPattern(node.name)) {
          if (node.initializer && isDecisionObjectReference(node.initializer, flow)) {
            const scope = aliasScope(node, file);
            changed = addSensitiveBindings(node.name, textAliases, scope) || changed;
          }
        } else if (tsRuntime.isIdentifier(node.name) && node.initializer) {
          const scope = aliasScope(node, file);
          if (isDecisionObjectReference(node.initializer, flow)) {
            changed = addAlias(objectAliases, node.name, scope.start, scope.end) || changed;
          } else if (isDecisionTextValueExpression(node.initializer, flow)) {
            changed = addAlias(textAliases, node.name, scope.start, scope.end) || changed;
          }
        }
      } else if (tsRuntime.isCallExpression(node)) {
        const fn = localFunctionForCall(node, flow);
        if (fn) {
          const scope = functionBodyScope(fn, file);
          for (const [index, parameter] of fn.parameters.entries()) {
            const argument = node.arguments[index];
            if (!argument) continue;
            if (tsRuntime.isIdentifier(parameter.name)) {
              if (isDecisionObjectReference(argument, flow)) {
                changed =
                  addAlias(objectAliases, parameter.name, scope.start, scope.end) || changed;
              } else if (containsDecisionTextReference(argument, flow)) {
                changed = addAlias(textAliases, parameter.name, scope.start, scope.end) || changed;
              }
            } else if (
              tsRuntime.isObjectBindingPattern(parameter.name) &&
              isDecisionObjectReference(argument, flow)
            ) {
              changed = addSensitiveBindings(parameter.name, textAliases, scope) || changed;
            }
          }
        }
      }
      tsRuntime.forEachChild(node, visit);
    };
    visit(file);
    for (const { declaration: fn } of functions) {
      if (!returnedTextFunctions.has(fn) && functionReturnsDecisionText(fn, flow)) {
        returnedTextFunctions.add(fn);
        changed = true;
      }
    }
  }
  return flow;
}

function typeReferencesPlanAction(type: ts.TypeNode | undefined): boolean {
  if (!type) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      tsRuntime.isTypeReferenceNode(node) &&
      ((tsRuntime.isIdentifier(node.typeName) && node.typeName.text === "PlanAction") ||
        (tsRuntime.isQualifiedName(node.typeName) && node.typeName.right.text === "PlanAction"))
    ) {
      found = true;
      return;
    }
    tsRuntime.forEachChild(node, visit);
  };
  visit(type);
  return found;
}

function addSensitiveBindings(
  pattern: ts.ObjectBindingPattern,
  aliases: ScopedAlias[],
  scope: { readonly start: number; readonly end: number },
): boolean {
  let changed = false;
  for (const element of pattern.elements) {
    const property = element.propertyName ?? element.name;
    const propertyName =
      tsRuntime.isIdentifier(property) || tsRuntime.isStringLiteral(property)
        ? property.text
        : undefined;
    if (
      (propertyName === "reason" || propertyName === "message") &&
      tsRuntime.isIdentifier(element.name)
    ) {
      if (
        !aliases.some(
          (alias) =>
            alias.name === element.name.text &&
            alias.start === scope.start &&
            alias.end === scope.end,
        )
      ) {
        aliases.push({ name: element.name.text, ...scope });
        changed = true;
      }
    }
  }
  return changed;
}

function nearestLexicalScope(node: ts.Node, file: ts.SourceFile): ts.Node {
  let current = node.parent;
  while (
    current &&
    !tsRuntime.isBlock(current) &&
    !tsRuntime.isSourceFile(current) &&
    !tsRuntime.isCaseBlock(current)
  ) {
    current = current.parent;
  }
  return current ?? file;
}

function aliasScope(
  declaration: ts.VariableDeclaration,
  file: ts.SourceFile,
): { readonly start: number; readonly end: number } {
  return { start: declaration.end, end: nearestLexicalScope(declaration, file).end };
}

function functionBodyScope(
  fn: ts.FunctionLikeDeclaration,
  file: ts.SourceFile,
): { readonly start: number; readonly end: number } {
  return fn.body
    ? { start: fn.body.getStart(file), end: fn.body.end }
    : { start: fn.getStart(file), end: fn.end };
}

function containsDecisionTextReference(node: ts.Node, flow: DecisionTextFlow): boolean {
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (found) return;
    if (tsRuntime.isFunctionLike(candidate)) return;
    if (
      isDecisionTextReference(candidate, flow) ||
      (tsRuntime.isExpression(candidate) && isDecisionTextValueExpression(candidate, flow))
    ) {
      found = true;
      return;
    }
    tsRuntime.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

function isDecisionTextValueExpression(node: ts.Expression, flow: DecisionTextFlow): boolean {
  const expression = unwrapExpression(node);
  if (isDecisionTextReference(expression, flow)) return true;
  if (tsRuntime.isCallExpression(expression)) {
    const fn = localFunctionForCall(expression, flow);
    if (fn && flow.returnedTextFunctions.has(fn)) return true;
  }
  if (tsRuntime.isPrefixUnaryExpression(expression)) {
    return isDecisionTextValueExpression(expression.operand, flow);
  }
  if (tsRuntime.isConditionalExpression(expression)) {
    return (
      isDecisionTextValueExpression(expression.whenTrue, flow) ||
      isDecisionTextValueExpression(expression.whenFalse, flow)
    );
  }
  if (
    tsRuntime.isBinaryExpression(expression) &&
    [
      tsRuntime.SyntaxKind.BarBarToken,
      tsRuntime.SyntaxKind.PlusToken,
      tsRuntime.SyntaxKind.QuestionQuestionToken,
    ].includes(expression.operatorToken.kind)
  ) {
    return (
      isDecisionTextValueExpression(expression.left, flow) ||
      isDecisionTextValueExpression(expression.right, flow)
    );
  }
  return false;
}

function functionReturnsDecisionText(
  fn: ts.FunctionLikeDeclaration,
  flow: DecisionTextFlow,
): boolean {
  if (!fn.body) return false;
  if (!tsRuntime.isBlock(fn.body)) return isDecisionTextValueExpression(fn.body, flow);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || (node !== fn.body && tsRuntime.isFunctionLike(node))) return;
    if (
      tsRuntime.isReturnStatement(node) &&
      node.expression &&
      isDecisionTextValueExpression(node.expression, flow)
    ) {
      found = true;
      return;
    }
    tsRuntime.forEachChild(node, visit);
  };
  visit(fn.body);
  return found;
}

function isDecisionTextReference(node: ts.Node, flow: DecisionTextFlow): boolean {
  if (tsRuntime.isIdentifier(node)) {
    return hasScopedAlias(flow.textAliases, node);
  }
  if (tsRuntime.isPropertyAccessExpression(node)) {
    return (
      (["message", "reason"].includes(node.name.text) &&
        isDecisionObjectReference(node.expression, flow)) ||
      (node.name.text === "message" && isErrorLikeExpression(node.expression))
    );
  }
  if (!tsRuntime.isElementAccessExpression(node)) return false;
  const argument = node.argumentExpression;
  return (
    (tsRuntime.isStringLiteral(argument) || tsRuntime.isNoSubstitutionTemplateLiteral(argument)) &&
    ((["message", "reason"].includes(argument.text) &&
      isDecisionObjectReference(node.expression, flow)) ||
      (argument.text === "message" && isErrorLikeExpression(node.expression)))
  );
}

function isDecisionObjectReference(node: ts.Expression, flow: DecisionTextFlow): boolean {
  const expression = unwrapExpression(node);
  if (!tsRuntime.isIdentifier(expression)) return false;
  if (expression.text === "action") return true;
  return hasScopedAlias(flow.objectAliases, expression);
}

function hasScopedAlias(aliases: readonly ScopedAlias[], node: ts.Identifier): boolean {
  const position = node.getStart();
  return aliases.some(
    (alias) => alias.name === node.text && position >= alias.start && node.end <= alias.end,
  );
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let expression = node;
  while (
    tsRuntime.isAsExpression(expression) ||
    tsRuntime.isTypeAssertionExpression(expression) ||
    tsRuntime.isNonNullExpression(expression) ||
    tsRuntime.isParenthesizedExpression(expression) ||
    tsRuntime.isSatisfiesExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function isErrorLikeExpression(node: ts.Expression): boolean {
  return /(?:error|exception|failure)$/iu.test(leftmostIdentifier(node) ?? "");
}

function localFunctionForCall(
  call: ts.CallExpression,
  flow: DecisionTextFlow,
): ts.FunctionLikeDeclaration | undefined {
  const expression = unwrapExpression(call.expression);
  if (!tsRuntime.isIdentifier(expression)) return undefined;
  const position = expression.getStart(flow.file);
  return flow.functions
    .filter((fn) => fn.name === expression.text && position >= fn.start && expression.end <= fn.end)
    .sort((left, right) => right.start - left.start || left.end - right.end)[0]?.declaration;
}

function isDecisionTextMethodCall(
  call: ts.CallExpression,
  methods: ReadonlySet<string>,
  flow: DecisionTextFlow,
): boolean {
  return (
    tsRuntime.isPropertyAccessExpression(call.expression) &&
    methods.has(call.expression.name.text) &&
    containsDecisionTextReference(call, flow)
  );
}

function isPresentationOnlyCall(call: ts.CallExpression): boolean {
  if (call.expression.kind === tsRuntime.SyntaxKind.SuperKeyword) return true;
  if (tsRuntime.isIdentifier(call.expression)) {
    return ["commandFailure", "createSafeConsole", "redactSafeObservableText", "render"].includes(
      call.expression.text,
    );
  }
  if (!tsRuntime.isPropertyAccessExpression(call.expression)) return false;
  const method = call.expression.name.text;
  if (
    method === "push" &&
    ((tsRuntime.isIdentifier(call.expression.expression) &&
      ["conflicts", "warnings"].includes(call.expression.expression.text)) ||
      (tsRuntime.isPropertyAccessExpression(call.expression.expression) &&
        call.expression.expression.name.text === "warnings"))
  ) {
    return true;
  }
  if (!["debug", "error", "info", "log", "warn"].includes(method)) return false;
  const receiver = call.expression.expression;
  if (tsRuntime.isIdentifier(receiver))
    return receiver.text === "console" || receiver.text === "output";
  return (
    tsRuntime.isCallExpression(receiver) &&
    tsRuntime.isIdentifier(receiver.expression) &&
    receiver.expression.text === "createSafeConsole"
  );
}

function isPresentationOnlyCondition(node: ts.Node): boolean {
  if (!tsRuntime.isIfStatement(node) || node.elseStatement) return false;
  const statement = tsRuntime.isBlock(node.thenStatement)
    ? node.thenStatement.statements.length === 1
      ? node.thenStatement.statements[0]
      : undefined
    : node.thenStatement;
  return (
    statement !== undefined &&
    tsRuntime.isExpressionStatement(statement) &&
    tsRuntime.isCallExpression(statement.expression) &&
    isPresentationOnlyCall(statement.expression)
  );
}

function leftmostIdentifier(node: ts.Expression): string | undefined {
  let current: ts.Expression = node;
  while (
    tsRuntime.isPropertyAccessExpression(current) ||
    tsRuntime.isElementAccessExpression(current)
  ) {
    current = current.expression;
  }
  return tsRuntime.isIdentifier(current) ? current.text : undefined;
}
