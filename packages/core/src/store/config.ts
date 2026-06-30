// cellarer.toml 解析与校验(kickoff §7.2 schema)。zod strict + smol-toml 读。
// 注意:smol-toml stringify 不保留注释(见计划 §6),写回走最小字段更新策略,本文件只负责读。
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { Env } from "../env.js";
import { readFileOrNull } from "../fs/probe.js";

const methodSchema = z.enum(["symlink", "copy"]);
const secretModeSchema = z.enum(["env", "vault", "keychain"]);
const mergeStrategySchema = z.enum(["merge", "overwrite"]);

// per-OS 默认覆盖(注意点 3:Windows 软链兜底)。
const osDefaultsSchema = z
  .object({
    method: methodSchema.optional(),
  })
  .strict();

const defaultsSchema = z
  .object({
    method: methodSchema.default("symlink"),
    channels: z.array(z.string()).default(["common"]),
    secret_mode: secretModeSchema.default("env"),
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

const channelSchema = z.object({ description: z.string().optional() }).strict();
const artifactSchema = z.object({ channels: z.array(z.string()).default([]) }).strict();

const agentMcpSchema = z.object({ merge_strategy: mergeStrategySchema.optional() }).strict();
const agentSchema = z
  .object({
    enabled: z.boolean().optional(),
    mcp: agentMcpSchema.optional(),
  })
  .strict();

const configSchema = z
  .object({
    // prefault({}):让缺省的 defaults 也跑一遍 schema 以填充嵌套默认值
    // (zod v4 default 不递归运行嵌套默认)。
    defaults: defaultsSchema.prefault({}),
    channels: z.record(z.string(), channelSchema).default({}),
    artifacts: z.record(z.string(), artifactSchema).default({}),
    agents: z.record(z.string(), agentSchema).default({}),
  })
  .strict();

export type CellarerConfig = z.infer<typeof configSchema>;

// 解析 TOML 文本 → 校验后的强类型配置(strict:未知键报错)。
export function parseConfig(text: string): CellarerConfig {
  const raw = text.trim().length === 0 ? {} : parseToml(text);
  return configSchema.parse(raw);
}

// 从库房根读取 cellarer.toml;不存在则返回全默认配置;损坏则报可操作错误。
export async function loadConfig(env: Env, storeRoot: string): Promise<CellarerConfig> {
  const path = join(storeRoot, "cellarer.toml");
  const text = await readFileOrNull(env, path);
  if (text === null) return parseConfig("");
  try {
    return parseConfig(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid config at ${path}: ${msg}`);
  }
}

// 给一批制品打通道标签(scan --into-channel 用)。
// 注:smol-toml stringify 丢注释(§6),故不整体重写,而是「追加」缺失的 [artifacts."<id>"] 块,
// 保留用户既有内容与注释。已存在该制品标签的跳过(避免重复/破坏用户手改)。返回新打标的 id 列表。
export async function tagArtifactChannels(
  env: Env,
  storeRoot: string,
  artifactIds: string[],
  channel: string,
): Promise<string[]> {
  const path = join(storeRoot, "cellarer.toml");
  const existing = (await readFileOrNull(env, path)) ?? "";
  // 已校验存在的制品标签键(原样字符串匹配,容忍格式差异从宽:出现即认为已标)。
  const tagged: string[] = [];
  const blocks: string[] = [];
  for (const id of artifactIds) {
    const header = `[artifacts."${id}"]`;
    if (existing.includes(header)) continue; // 已有标签 → 不动
    blocks.push(`${header}\nchannels = ["${channel}"]`);
    tagged.push(id);
  }
  if (blocks.length === 0) return [];
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  const next = `${existing}${sep}\n${blocks.join("\n\n")}\n`;
  // 写前自校验:确保追加后仍是合法配置(strict),否则不落地。
  parseConfig(next);
  await env.fs.writeFile(path, next);
  return tagged;
}
