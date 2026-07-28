// 内容指纹(sha256)。createHash 是纯函数(确定性、无 I/O、不依赖 platform/time),
// 类比 node:path,用作纯工具不违反 Env 注入约束(约束针对 fs/process/os 副作用)。
import { createHash } from "node:crypto";

export function sha256(content: string | Uint8Array): string {
  const hash = createHash("sha256");
  if (typeof content === "string") hash.update(content, "utf8");
  else hash.update(content);
  return `sha256:${hash.digest("hex")}`;
}
