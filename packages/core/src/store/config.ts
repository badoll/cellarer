// User config: ~/.cellarer/config.json.
// Packaged config carries built-in adapters; user config keeps built-in/custom overrides separate.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isProxy } from "node:util/types";
import { z } from "zod";
import type { AgentSpec } from "../adapters/spec.js";
import type { Env } from "../env.js";
import { atomicWrite } from "../fs/atomicWrite.js";
import { readFileOrNull } from "../fs/probe.js";
import type { McpDialect } from "../mcp/model.js";
import type { Capability, Scope } from "../model/index.js";
import type { AssertExact, ExactContract, SettingsSummary } from "../protocol/client-types.js";
import { registerObservablePublicControlPlaneConfig } from "../secrets/observable.js";

export const CONFIG_FILENAME = "config.json";
type ConfigReadContext = { readonly fs: Pick<Env["fs"], "readFile"> };
export const PACKAGED_CONFIG_PATH = fileURLToPath(new URL("../../config.json", import.meta.url));
export const NORMALIZED_STORE_RELATIVE_SOURCE_PATTERN =
  "^(?!/)(?!.*\\\\)(?![A-Za-z]:)(?!.*:)(?!.*%[0-9A-Fa-f]{2})(?!(?:.*\\/)?\\.{1,2}(?:\\/|$))(?!.*\\/\\/)(?!.*\\/$)[^/]+(?:\\/[^/]+)*$";
export const AGENT_ID_PATTERN =
  "^(?!(?:__proto__|prototype|constructor)$)[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$";

const nonEmptyString = z.string().min(1);
const agentIdSchema = z
  .string()
  .regex(
    new RegExp(AGENT_ID_PATTERN),
    "agent id must use letters, digits, dots, underscores, or hyphens without unsafe boundary or reserved object keys",
  );
const agentIdRecord = <T extends z.ZodType>(valueSchema: T) =>
  z
    .custom<Record<string, unknown>>(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).every((key) => agentIdSchema.safeParse(key).success),
      "adapter map contains an invalid agent id",
    )
    .pipe(z.record(agentIdSchema, valueSchema));
const nonEmptyStringArray = z.array(nonEmptyString);
const methodSchema = z.enum(["symlink", "copy"]);
const secretModeSchema = z.enum(["env", "vault", "keychain"]);
const mergeStrategySchema = z.enum(["merge", "overwrite"]);
const scopeArray = z.array(z.enum(["global", "project"]));

const osDefaultsSchema = z
  .object({
    method: methodSchema.optional(),
  })
  .strict();

const defaultsSchema = z
  .object({
    method: methodSchema.default("symlink"),
    collections: nonEmptyStringArray.default(["default"]),
    secretMode: secretModeSchema.default("env"),
    os: z
      .object({
        win32: osDefaultsSchema.optional(),
        darwin: osDefaultsSchema.optional(),
        linux: osDefaultsSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type SettingsDefaults = SettingsSummary["defaults"];
type SettingsDefaultsSchemaInput = Partial<SettingsDefaults>;

export type SettingsDefaultsSchemaInputContract = AssertExact<
  ExactContract<z.input<typeof defaultsSchema>, SettingsDefaultsSchemaInput>
>;
export type SettingsDefaultsSchemaOutputContract = AssertExact<
  ExactContract<z.output<typeof defaultsSchema>, SettingsDefaults>
>;

const collectionSchema = z.object({ description: z.string().optional() }).strict();
const collectionsSchema = z.record(nonEmptyString, collectionSchema);
const secretPatternSuppressionSchema = z
  .object({
    source: z
      .string()
      .min(1)
      .regex(
        new RegExp(NORMALIZED_STORE_RELATIVE_SOURCE_PATTERN),
        "source must be a normalized store-relative file path",
      ),
    rule: z.string().min(1),
    patternVersion: z.number().int().positive(),
  })
  .strict();
const artifactSchema = z
  .object({
    collections: nonEmptyStringArray.default([]),
    secretPatternSuppressions: z.array(secretPatternSuppressionSchema).optional(),
  })
  .strict();
const pathTemplate = z
  .object({
    global: nonEmptyString.optional(),
    project: nonEmptyString.optional(),
  })
  .strict();

const dialectSchema = z
  .object({
    commandStyle: z.enum(["scalar", "array"]).optional(),
    envKey: nonEmptyString.optional(),
    urlKey: nonEmptyString.optional(),
    typeField: nonEmptyString.optional(),
    stdioType: nonEmptyString.optional(),
    remoteType: nonEmptyString.optional(),
  })
  .strict();

const capabilitiesSchema = z
  .object({
    rules: scopeArray.optional(),
    mcp: scopeArray.optional(),
    skills: scopeArray.optional(),
  })
  .strict();

const discoverySchema = z
  .array(
    z
      .object({
        sourceId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
        scope: z.enum(["global", "project"]),
        kind: z.enum(["rules", "mcp", "skills"]),
        path: nonEmptyString,
        locator: z.enum(["file", "tree"]),
        maxDepth: z.number().int().min(1).max(64),
        maxEntries: z.number().int().min(1).max(100_000),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(224 * 1024 * 1024),
        precedence: z
          .object({
            policy: z.enum(["unknown", "ranked", "cumulative"]),
            rank: z.number().int().optional(),
            evidence: nonEmptyString,
          })
          .strict()
          .refine((value) => value.policy !== "ranked" || value.rank !== undefined, {
            message: "ranked discovery requires rank",
          }),
      })
      .strict(),
  )
  .max(128)
  .superRefine((sources, ctx) => {
    const ids = new Set<string>();
    for (const source of sources) {
      if (ids.has(source.sourceId))
        ctx.addIssue({ code: "custom", message: "duplicate discovery sourceId" });
      ids.add(source.sourceId);
      if ((source.kind === "skills") !== (source.locator === "tree")) {
        ctx.addIssue({
          code: "custom",
          message: "skills require tree locators; rules and mcp require file locators",
        });
      }
      if (source.kind !== "rules" && source.precedence.policy === "cumulative") {
        ctx.addIssue({
          code: "custom",
          message: "cumulative discovery is only supported for rules",
        });
      }
    }
  });

const adapterFields = {
  discovery: discoverySchema.optional(),
  displayName: nonEmptyString.optional(),
  detect: z
    .object({
      global: nonEmptyStringArray.optional(),
      project: nonEmptyStringArray.optional(),
    })
    .strict()
    .optional(),
  rules: pathTemplate.extend({ format: z.literal("markdown").optional() }).optional(),
  mcp: pathTemplate
    .extend({
      format: z.enum(["json", "toml"]).optional(),
      serversKey: nonEmptyString.optional(),
      mergeStrategy: mergeStrategySchema.optional(),
      supportedSecretReferences: z.array(z.enum(["environment", "cellarer"])).optional(),
      dialect: dialectSchema.optional(),
    })
    .optional(),
  skills: pathTemplate.extend({ format: z.literal("dir").optional() }).optional(),
  capabilities: capabilitiesSchema.optional(),
};

const adapterPatchSchema = z.object(adapterFields).strict();
const adapterOverrideSchema = z
  .object({ enabled: z.boolean().optional(), ...adapterFields })
  .strict();

const adapterBodySchema = adapterPatchSchema
  .refine((d) => d.rules || d.mcp || d.skills, {
    message: "adapter must declare at least one of rules/mcp/skills",
  })
  .refine((d) => !d.mcp || d.mcp.supportedSecretReferences !== undefined, {
    message: "mcp adapter must declare supportedSecretReferences",
    path: ["mcp", "supportedSecretReferences"],
  });

const baseConfigShape = {
  version: z.literal(1).default(1),
  defaults: defaultsSchema.prefault({}),
  collections: collectionsSchema.default({}),
  artifacts: z.record(nonEmptyString, artifactSchema).default({}),
};

const configShape = {
  ...baseConfigShape,
  adapterOverrides: agentIdRecord(adapterOverrideSchema).default({}),
  customAdapters: agentIdRecord(adapterBodySchema).default({}),
};

const configSchema = z.object(configShape).strict();

const packagedConfigSchema = z
  .object({
    ...baseConfigShape,
    adapterOverrides: agentIdRecord(adapterOverrideSchema).default({}),
    builtinAdapters: agentIdRecord(adapterBodySchema).default({}),
  })
  .strict();

export type CellarerConfig = z.infer<typeof configSchema>;
type PackagedConfig = z.infer<typeof packagedConfigSchema>;
export type AdapterBodyConfig = z.infer<typeof adapterBodySchema>;
export type AdapterPatchConfig = z.infer<typeof adapterPatchSchema>;
export type AdapterOverrideConfig = z.infer<typeof adapterOverrideSchema>;

function inferScopes(
  explicit: Scope[] | undefined,
  template: { global?: string; project?: string } | undefined,
): Scope[] {
  if (explicit) return explicit;
  if (!template) return [];
  const scopes: Scope[] = [];
  if (template.global) scopes.push("global");
  if (template.project) scopes.push("project");
  return scopes;
}

function capabilities(
  declared: { rules?: Scope[]; mcp?: Scope[]; skills?: Scope[] } | undefined,
  spec: {
    rules?: { global?: string; project?: string };
    mcp?: { global?: string; project?: string };
    skills?: { global?: string; project?: string };
  },
): Record<Capability, Scope[]> {
  return {
    rules: inferScopes(declared?.rules, spec.rules),
    mcp: inferScopes(declared?.mcp, spec.mcp),
    skills: inferScopes(declared?.skills, spec.skills),
  };
}

export function parseConfig(text: string): CellarerConfig {
  const raw = text.trim().length === 0 ? {} : JSON.parse(text);
  return parseConfigValue(raw);
}

export function parseConfigValue(value: unknown): CellarerConfig {
  return configSchema.parse(snapshotConfigRuntimeValue(value));
}

export function parseAgentId(value: unknown): string {
  return agentIdSchema.parse(value);
}

export function projectPublicControlPlaneConfig(config: CellarerConfig): CellarerConfig {
  return registerObservablePublicControlPlaneConfig(
    deepFreezeConfigProjection(parseConfigValue(config)),
  );
}

function deepFreezeConfigProjection<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeConfigProjection(child);
  return Object.freeze(value);
}

function parsePackagedConfig(text: string): PackagedConfig {
  const raw = text.trim().length === 0 ? {} : JSON.parse(text);
  return packagedConfigSchema.parse(snapshotConfigRuntimeValue(raw));
}

export function parsePackagedConfigForSettings(text: string): {
  builtinAdapters: Record<string, unknown>;
} {
  const parsed = parsePackagedConfig(text);
  return { builtinAdapters: parsed.builtinAdapters };
}

export function parseAdapterBodyConfig(adapter: unknown): AdapterBodyConfig {
  return parseSnapshottedAdapterBodyConfig(snapshotConfigRuntimeValue(adapter));
}

export function parseAdapterPatchConfig(adapter: unknown): AdapterPatchConfig {
  return parseSnapshottedAdapterPatchConfig(snapshotConfigRuntimeValue(adapter));
}

export function parseSnapshottedAdapterBodyConfig(adapter: unknown): AdapterBodyConfig {
  return adapterBodySchema.parse(adapter);
}

export function parseSnapshottedAdapterPatchConfig(adapter: unknown): AdapterPatchConfig {
  return adapterPatchSchema.parse(adapter);
}

export function parseAdapterOverrideConfig(adapter: unknown): AdapterOverrideConfig {
  return adapterOverrideSchema.parse(snapshotConfigRuntimeValue(adapter));
}

const UNSAFE_RUNTIME_CONFIG_KEYS = new Set(["__proto__", "prototype", "constructor", "toJSON"]);

/**
 * Copies runtime config input using own data descriptors only. This is deliberately stricter
 * than JSON.stringify so accessors, Proxies, symbols, custom prototypes, and magic object keys
 * cannot influence validation or final publication.
 */
export function snapshotConfigRuntimeValue(
  value: unknown,
  options: { readonly omitUndefinedObjectProperties?: boolean } = {},
): unknown {
  return snapshotConfigRuntimeNode(value, new WeakSet<object>(), "$config", options);
}

function snapshotConfigRuntimeNode(
  value: unknown,
  ancestors: WeakSet<object>,
  path: string,
  options: { readonly omitUndefinedObjectProperties?: boolean },
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new TypeError(`${path} must not contain a non-finite number`);
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} must contain only JSON data values`);
  }
  if (isProxy(value)) throw new TypeError(`${path} must not contain a Proxy`);
  if (ancestors.has(value)) throw new TypeError(`${path} must not contain a cycle`);

  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (
    array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
  ) {
    throw new TypeError(`${path} must contain only plain objects and arrays`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key === "symbol")) {
    throw new TypeError(`${path} must not contain symbol keys`);
  }
  ancestors.add(value);
  try {
    if (array) {
      const length = descriptors.length;
      if (!length || !("value" in length) || !Number.isSafeInteger(length.value)) {
        throw new TypeError(`${path} must have a plain array length`);
      }
      const expected = [
        ...Array.from({ length: length.value as number }, (_, index) => String(index)),
        "length",
      ].sort();
      const actual = (keys as string[]).sort();
      if (
        actual.length !== expected.length ||
        actual.some((key, index) => key !== expected[index])
      ) {
        throw new TypeError(`${path} must be a dense array without custom keys`);
      }
      return expected
        .filter((key) => key !== "length")
        .sort((left, right) => Number(left) - Number(right))
        .map((key) =>
          snapshotConfigDataDescriptor(descriptors[key], ancestors, `${path}[${key}]`, options),
        );
    }

    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      if (UNSAFE_RUNTIME_CONFIG_KEYS.has(key)) {
        throw new TypeError(`${path} contains unsafe key ${JSON.stringify(key)}`);
      }
      const descriptor = descriptors[key];
      if (
        options.omitUndefinedObjectProperties &&
        descriptor &&
        "value" in descriptor &&
        descriptor.enumerable &&
        descriptor.value === undefined
      ) {
        continue;
      }
      copy[key] = snapshotConfigDataDescriptor(descriptor, ancestors, `${path}.${key}`, options);
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

function snapshotConfigDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
  ancestors: WeakSet<object>,
  path: string,
  options: { readonly omitUndefinedObjectProperties?: boolean },
): unknown {
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError(`${path} must be an enumerable own data property`);
  }
  return snapshotConfigRuntimeNode(descriptor.value, ancestors, path, options);
}

function adapterSupportedSecretReferences(
  id: string,
  mcp: AdapterBodyConfig["mcp"],
): ("environment" | "cellarer")[] {
  if (!mcp?.supportedSecretReferences) {
    throw new Error(`mcp adapter "${id}" must declare supportedSecretReferences`);
  }
  return mcp.supportedSecretReferences;
}

function adapterToSpec(id: string, a: AdapterBodyConfig): AgentSpec {
  return {
    id,
    displayName: a.displayName ?? id,
    detect: a.detect,
    discovery: a.discovery,
    rules: a.rules,
    mcp: a.mcp
      ? {
          ...a.mcp,
          supportedSecretReferences: adapterSupportedSecretReferences(id, a.mcp),
          dialect: a.mcp.dialect as McpDialect | undefined,
        }
      : undefined,
    skills: a.skills,
    capabilities: capabilities(a.capabilities, {
      rules: a.rules,
      mcp: a.mcp,
      skills: a.skills,
    }),
  };
}

async function packagedConfigTextFromReadContext(env: ConfigReadContext): Promise<string> {
  const text = await env.fs.readFile(PACKAGED_CONFIG_PATH);
  parsePackagedConfig(text);
  return text.endsWith("\n") ? text : `${text}\n`;
}

export async function packagedConfigText(env: Env): Promise<string> {
  return packagedConfigTextFromReadContext(env);
}

function userConfigTemplate(packaged: PackagedConfig): CellarerConfig {
  return {
    version: packaged.version,
    defaults: packaged.defaults,
    collections: packaged.collections,
    artifacts: packaged.artifacts,
    adapterOverrides: packaged.adapterOverrides,
    customAdapters: {},
  };
}

async function initialConfigTextFromReadContext(env: ConfigReadContext): Promise<string> {
  const initial = userConfigTemplate(
    parsePackagedConfig(await packagedConfigTextFromReadContext(env)),
  );
  return `${JSON.stringify(initial, null, 2)}\n`;
}

export async function initialConfigText(env: Env): Promise<string> {
  return initialConfigTextFromReadContext(env);
}

export async function loadConfigFromReadContext(
  env: ConfigReadContext,
  storeRoot: string,
): Promise<CellarerConfig> {
  const path = join(storeRoot, CONFIG_FILENAME);
  const text = await readFileOrNull(env, path);
  if (text === null) return parseConfig(await initialConfigTextFromReadContext(env));
  try {
    return parseConfig(text);
  } catch (err) {
    throw new InvalidConfigError(path, err);
  }
}

export async function loadConfig(env: Env, storeRoot: string): Promise<CellarerConfig> {
  return loadConfigFromReadContext(env, storeRoot);
}

export class InvalidConfigError extends Error {
  readonly configPath: string;

  constructor(configPath: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`invalid config at ${configPath}: ${message}`);
    this.name = "InvalidConfigError";
    this.configPath = configPath;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = out[key];
    out[key] = isRecord(existing) && isRecord(value) ? deepMerge(existing, value) : value;
  }
  return out as T;
}

function mergeAdapter(base: AdapterBodyConfig, patch: AdapterPatchConfig): AdapterBodyConfig {
  return adapterBodySchema.parse(deepMerge(base as unknown as Record<string, unknown>, patch));
}

export interface AdapterSpecsResult {
  specs: AgentSpec[];
  warnings: string[];
}

export async function loadAdapterSpecsFromConfig(
  env: Env,
  configuration: CellarerConfig,
): Promise<AdapterSpecsResult> {
  const warnings: string[] = [];
  const packaged = parsePackagedConfig(await packagedConfigText(env));
  const userConfig = parseConfigValue(configuration);

  return composeAdapterSpecs(packaged, userConfig, warnings);
}

export async function loadAdapterSpecs(env: Env, storeRoot: string): Promise<AdapterSpecsResult> {
  const packaged = parsePackagedConfig(await packagedConfigText(env));
  const configPath = join(storeRoot, CONFIG_FILENAME);
  const userText = await readFileOrNull(env, configPath);
  const userConfig = userText === null ? parseConfig("") : parseConfig(userText);

  return composeAdapterSpecs(packaged, userConfig, []);
}

function composeAdapterSpecs(
  packaged: PackagedConfig,
  userConfig: CellarerConfig,
  warnings: string[],
): AdapterSpecsResult {
  const effectiveBuiltins = new Map(Object.entries(packaged.builtinAdapters));
  const customById = new Map(Object.entries(userConfig.customAdapters));

  for (const [id, override] of Object.entries(userConfig.adapterOverrides)) {
    const { enabled: _enabled, ...adapterPatch } = override;
    if (Object.keys(adapterPatch).length === 0) continue;
    const builtin = effectiveBuiltins.get(id);
    if (builtin) {
      effectiveBuiltins.set(id, mergeAdapter(builtin, adapterPatch));
      continue;
    }
    const custom = customById.get(id);
    if (!custom) {
      warnings.push(`adapter override "${id}" has no built-in or custom adapter`);
      continue;
    }
    customById.set(id, mergeAdapter(custom, adapterPatch));
  }

  const specs: AgentSpec[] = [];
  for (const id of Object.keys(packaged.builtinAdapters)) {
    const adapter = effectiveBuiltins.get(id);
    if (adapter) specs.push(adapterToSpec(id, adapter));
  }
  for (const [id, adapter] of customById) {
    specs.push(adapterToSpec(id, adapter));
  }
  return { specs, warnings };
}

export async function saveConfig(
  env: Env,
  storeRoot: string,
  config: CellarerConfig,
): Promise<void> {
  const validated = parseConfigValue(config);
  const path = join(storeRoot, CONFIG_FILENAME);
  await atomicWrite(env, path, `${JSON.stringify(validated, null, 2)}\n`);
}

export async function tagArtifactCollections(
  env: Env,
  storeRoot: string,
  artifactIds: string[],
  collection: string,
): Promise<string[]> {
  const config = await loadConfig(env, storeRoot);
  const tagged: string[] = [];
  for (const id of artifactIds) {
    const existing = config.artifacts[id]?.collections ?? [];
    if (existing.includes(collection)) continue;
    config.artifacts[id] = { collections: [...existing, collection] };
    tagged.push(id);
  }
  if (tagged.length > 0) await saveConfig(env, storeRoot, config);
  return tagged;
}
