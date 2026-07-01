// 统一 secret-scan 护栏 pass(从 plan.ts 抽出;§7.6/§10.3,覆盖所有能力与所有 scope)。
// 不变量 3:纯函数,原地改 actions + 追加 warnings。两个拦截来源:
//  (1) 结构化字段探测的「意外明文」(accidentalPlaintext,脏库房,按字段名/高置信判定)→ 无条件拦,无逃生。
//  (2) 对 preview.after 的高置信文本扫描(把密钥误写进 rule 片段 / mcp 任意字段 / custom server 都拦)。
// 逃生通道(§10.2「必须明文的 agent」):仅当动作标了 allowResolvedPlaintext(vault/keychain 故意注入)
// 且落点是 global(~/.claude 等非版本库目录)时,放行文本扫描命中;project(git 跟踪)一律拦。
// 命中即转 skip,并清空 preview.after —— 否则真值会留在返回的 plan 里被 web/日志读到(红线)。
import type { PlanAction, Scope } from "../../model/index.js";
import { scanTextForSecrets } from "../../secrets/detector.js";

export function applySecretScanGuard(actions: PlanAction[], scope: Scope): void {
  for (const a of actions) {
    if (a.op === "skip" || !a.preview?.after) continue;
    const textHits = scanTextForSecrets(a.preview.after);
    const escapeHatch = a.allowResolvedPlaintext === true && scope === "global";
    const textBlocked = textHits.length > 0 && !escapeHatch;
    if (!a.accidentalPlaintext && !textBlocked) continue;
    const why = a.accidentalPlaintext
      ? "store contains a plaintext secret (use a CELLARER_SECRET or env placeholder)"
      : `plaintext secret(s) [${textHits.map((f) => f.rule).join(", ")}]`;
    a.op = "skip";
    a.reason = `secret-scan: ${why} would be written to ${a.target}${scope === "project" ? " (git-tracked)" : ""}`;
    // 拦下后清掉真值预览,避免明文经返回的 DistributePlan 外泄。
    a.preview = { before: a.preview.before };
  }
}
