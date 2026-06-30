// 备份:写前对既有目标做 .bak(借 ruler 行为)。
// 规则:目标不存在 → 不备份;目标是 cellarer 生成物 → 不备份(避免备份自己的输出);
// .bak 已存在 → 保留首次备份不覆盖(保住用户最初的原始内容)。
import type { Env } from "../env.js";
import { isGenerated } from "../markers.js";
import { lstatOrNull, readFileOrNull } from "./probe.js";

// .bak 后缀单一来源:backup 写它、gitignore 据它纳管,必须一致。
export const BAK_SUFFIX = ".bak";
export function backupPathFor(target: string): string {
  return `${target}${BAK_SUFFIX}`;
}

// 返回 .bak 路径(已创建或已存在),无需备份时返回 null。
export async function backupIfNeeded(env: Env, target: string): Promise<string | null> {
  const content = await readFileOrNull(env, target);
  if (content === null) return null; // 不存在 → 无需备份
  if (isGenerated(content)) return null; // cellarer 生成物 → 不备份

  const bak = backupPathFor(target);
  if (await lstatOrNull(env, bak)) return bak; // .bak 已存在 → 保留,不覆盖

  await env.fs.writeFile(bak, content);
  return bak;
}
