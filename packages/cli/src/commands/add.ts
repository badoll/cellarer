import { add, createRealEnv, resolveStoreRoot } from "@cellarer/core";
import { Command } from "commander";

// 从源导入制品到库房(kickoff §13)。本迭代:本地路径导入;owner/repo 与 URL 给友好桩。
// CLI 是薄壳(不变量 1):只解析参数 + 调 core add,展示结果。
export function addCommand(): Command {
  return new Command("add")
    .description("从源导入制品到库房(本地路径;owner/repo 与 URL 暂未实现)")
    .argument("<source>", "源:本地路径(.md→rules / .json→mcp / 目录→skills)")
    .option("--force", "同名制品已存在时覆盖(默认跳过)")
    .action(async (source: string, opts: { force?: boolean }) => {
      const env = createRealEnv();
      const storeRoot = resolveStoreRoot(env);
      try {
        const r = await add(env, { storeRoot, source, force: opts.force });
        for (const i of r.imported) console.log(`✓ 已导入 ${i.kind}/${i.name} → ${i.path}`);
        for (const s of r.skipped) console.log(`- 跳过 ${s.kind}/${s.name}(${s.reason})`);
        for (const j of r.rejected) console.error(`✗ 拒绝 ${j.kind}/${j.name}(${j.reason})`);
        if (r.rejected.length > 0) process.exitCode = 1;
        if (r.imported.length === 0 && r.skipped.length === 0 && r.rejected.length === 0) {
          console.log("未导入任何制品。");
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}
