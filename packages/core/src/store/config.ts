// User config: ~/.cellarer/config.json.
// Packaged config carries built-in adapters; user config carries defaults, artifact metadata,
// and key-based adapter entries. Adapter keys are the adapter ids.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AgentSpec } from "../adapters/spec.js";
import type { Env } from "../env.js";
import { atomicWrite } from "../fs/atomicWrite.js";
import { readFileOrNull } from "../fs/probe.js";
import type { McpDialect } from "../mcp/model.js";
import type { Capability, Scope } from "../model/index.js";

export const CONFIG_FILENAME = "config.json";
export const PACKAGED_CONFIG_PATH = fileURLToPath(new URL("../../config.json", import.meta.url));

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
    collections: z.array(z.string()).default(["default"]),
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

const collectionSchema = z.object({ description: z.string().optional() }).strict();
const artifactSchema = z.object({ collections: z.array(z.string()).default([]) }).strict();
const agentMcpSchema = z.object({ mergeStrategy: mergeStrategySchema.optional() }).strict();
const agentSchema = z
  .object({
    enabled: z.boolean().optional(),
    mcp: agentMcpSchema.optional(),
  })
  .strict();

const pathTemplate = z
  .object({
    global: z.string().optional(),
    project: z.string().optional(),
  })
  .strict();

const dialectSchema = z
  .object({
    commandStyle: z.enum(["scalar", "array"]).optional(),
    envKey: z.string().optional(),
    urlKey: z.string().optional(),
    typeField: z.string().optional(),
    stdioType: z.string().optional(),
    remoteType: z.string().optional(),
  })
  .strict();

const capabilitiesSchema = z
  .object({
    rules: scopeArray.optional(),
    mcp: scopeArray.optional(),
    skills: scopeArray.optional(),
  })
  .strict();

const adapterFields = {
  displayName: z.string().min(1).optional(),
  detect: z
    .object({
      global: z.array(z.string()).optional(),
      project: z.array(z.string()).optional(),
    })
    .strict()
    .optional(),
  rules: pathTemplate.extend({ format: z.literal("markdown").optional() }).optional(),
  mcp: pathTemplate
    .extend({
      format: z.enum(["json", "toml"]).optional(),
      serversKey: z.string().optional(),
      mergeStrategy: mergeStrategySchema.optional(),
      dialect: dialectSchema.optional(),
    })
    .optional(),
  skills: pathTemplate.extend({ format: z.literal("dir").optional() }).optional(),
  capabilities: capabilitiesSchema.optional(),
};

const adapterPatchSchema = z.object(adapterFields).strict();

const adapterBodySchema = adapterPatchSchema.refine((d) => d.rules || d.mcp || d.skills, {
  message: "adapter must declare at least one of rules/mcp/skills",
});

const baseConfigShape = {
  version: z.literal(1).default(1),
  defaults: defaultsSchema.prefault({}),
  collections: z.record(z.string(), collectionSchema).default({}),
  artifacts: z.record(z.string(), artifactSchema).default({}),
  agents: z.record(z.string(), agentSchema).default({}),
};

const configShape = {
  ...baseConfigShape,
  adapters: z.record(z.string(), adapterPatchSchema).default({}),
};

const configSchema = z.object(configShape).strict();

const packagedConfigSchema = z
  .object({
    ...baseConfigShape,
    builtinAdapters: z.record(z.string(), adapterBodySchema).default({}),
  })
  .strict();

export type CellarerConfig = z.infer<typeof configSchema>;
type PackagedConfig = z.infer<typeof packagedConfigSchema>;
export type AdapterBodyConfig = z.infer<typeof adapterBodySchema>;
export type AdapterPatchConfig = z.infer<typeof adapterPatchSchema>;

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
  return configSchema.parse(raw);
}

function parsePackagedConfig(text: string): PackagedConfig {
  const raw = text.trim().length === 0 ? {} : JSON.parse(text);
  return packagedConfigSchema.parse(raw);
}

export function parsePackagedConfigForSettings(text: string): {
  builtinAdapters: Record<string, unknown>;
} {
  const parsed = parsePackagedConfig(text);
  return { builtinAdapters: parsed.builtinAdapters };
}

export function parseAdapterBodyConfig(adapter: unknown): AdapterBodyConfig {
  return adapterBodySchema.parse(adapter);
}

export function parseAdapterPatchConfig(adapter: unknown): AdapterPatchConfig {
  return adapterPatchSchema.parse(adapter);
}

function adapterToSpec(id: string, a: AdapterBodyConfig): AgentSpec {
  return {
    id,
    displayName: a.displayName ?? id,
    detect: a.detect,
    rules: a.rules,
    mcp: a.mcp
      ? {
          ...a.mcp,
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

export async function packagedConfigText(env: Env): Promise<string> {
  const text = await env.fs.readFile(PACKAGED_CONFIG_PATH);
  parsePackagedConfig(text);
  return text.endsWith("\n") ? text : `${text}\n`;
}

function userConfigTemplate(packaged: PackagedConfig): CellarerConfig {
  return {
    version: packaged.version,
    defaults: packaged.defaults,
    collections: packaged.collections,
    artifacts: packaged.artifacts,
    agents: packaged.agents,
    adapters: {},
  };
}

export async function initialConfigText(env: Env): Promise<string> {
  const initial = userConfigTemplate(parsePackagedConfig(await packagedConfigText(env)));
  return `${JSON.stringify(initial, null, 2)}\n`;
}

export async function loadConfig(env: Env, storeRoot: string): Promise<CellarerConfig> {
  const path = join(storeRoot, CONFIG_FILENAME);
  const text = await readFileOrNull(env, path);
  if (text === null) return parseConfig(await initialConfigText(env));
  try {
    return parseConfig(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid config at ${path}: ${msg}`);
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

export async function loadAdapterSpecs(env: Env, storeRoot: string): Promise<AdapterSpecsResult> {
  const warnings: string[] = [];
  const packaged = parsePackagedConfig(await packagedConfigText(env));
  const configPath = join(storeRoot, CONFIG_FILENAME);
  const userText = await readFileOrNull(env, configPath);
  const userConfig = userText === null ? parseConfig("") : parseConfig(userText);

  const effectiveBuiltins = new Map(Object.entries(packaged.builtinAdapters));
  const customById = new Map<string, AdapterBodyConfig>();

  for (const [id, adapter] of Object.entries(userConfig.adapters)) {
    const builtin = effectiveBuiltins.get(id);
    if (builtin) {
      effectiveBuiltins.set(id, mergeAdapter(builtin, adapter));
      continue;
    }

    const parsed = adapterBodySchema.safeParse(adapter);
    if (!parsed.success) {
      throw new Error(`invalid custom adapter "${id}": ${parsed.error.message}`);
    }
    customById.set(id, parsed.data);
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

export async function saveConfig(env: Env, storeRoot: string, config: CellarerConfig): Promise<void> {
  const path = join(storeRoot, CONFIG_FILENAME);
  await atomicWrite(env, path, `${JSON.stringify(config, null, 2)}\n`);
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
