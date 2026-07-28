import {
  type AddResult,
  add,
  createRealEnv,
  resolveStoreRoot,
  type SkillCandidate,
} from "@cellarer/core";
import { Command } from "commander";
import { createCliGitClient } from "../git-client.js";

interface AddCliOpts {
  force?: boolean;
  list?: boolean;
  skill?: string[];
  all?: boolean;
  collection?: string;
  yes?: boolean;
  json?: boolean;
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

// 从源导入资源到库房。CLI 是薄壳:解析参数 + 注入 GitClient effect + 展示 core report。
export function addCommand(): Command {
  return new Command("add")
    .description("从本地路径或 GitHub source 导入资源到库房")
    .argument("<source>", "源:本地 .md/.json/skill 目录、GitHub owner/repo 或 GitHub URL")
    .option("--force", "同名资源已存在时覆盖(默认跳过)")
    .option("--list", "只列出可导入的 skill candidates,不写库房")
    .option("--skill <name>", "导入指定 skill;可重复传入", collect, [])
    .option("--all", "导入所有 eligible skills")
    .option("--collection <name>", "给导入资源归入 collection;internal 会包含 internal skills")
    .option("--yes", "跳过确认提示(当前 add 为非交互,保留命令面兼容)")
    .option("--json", "输出 JSON report")
    .action(async (source: string, opts: AddCliOpts) => {
      const env = createRealEnv();
      const storeRoot = resolveStoreRoot(env);
      const json = opts.json || process.env.CELLARER_JSON === "1";
      try {
        const r = await add(env, {
          storeRoot,
          source,
          force: opts.force,
          list: opts.list,
          skills: opts.skill,
          all: opts.all,
          collection: opts.collection,
          yes: opts.yes,
          gitClient: createCliGitClient(),
        });
        if (json) {
          console.log(JSON.stringify(r, null, 2));
          if (r.rejected.length > 0 || r.operation?.ok === false) process.exitCode = 1;
          return;
        }
        printResult(r, opts);
      } catch (err) {
        if (json) {
          console.log(
            JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2),
          );
        } else {
          console.error(err instanceof Error ? err.message : String(err));
        }
        process.exitCode = 1;
      }
    });
}

function printResult(r: AddResult, opts: AddCliOpts): void {
  if (opts.list) {
    printCandidates(r.candidates);
    return;
  }
  for (const i of r.imported) console.log(`✓ 已导入 ${i.kind}/${i.name} → ${i.path}`);
  for (const s of r.skipped) console.log(`- 跳过 ${s.kind}/${s.name}(${s.reason})`);
  for (const j of r.rejected) console.error(`✗ 拒绝 ${j.kind}/${j.name}(${j.reason})`);
  for (const w of r.warnings) console.warn(`⚠ ${w}`);
  if (r.operation?.ok === false) {
    console.error(`✗ mutation ${r.operation.conflict.code}: ${r.operation.conflict.message}`);
  }
  if (r.rejected.length > 0 || r.operation?.ok === false) process.exitCode = 1;
  if (r.imported.length === 0 && r.skipped.length === 0 && r.rejected.length === 0) {
    console.log("未导入任何资源。");
  }
}

function printCandidates(candidates: SkillCandidate[]): void {
  if (candidates.length === 0) {
    console.log("未发现可导入的 skills。");
    return;
  }
  console.log("可导入 skills:");
  for (const c of candidates) {
    const flags = [c.internal ? "internal" : "", c.rejected ? "rejected" : ""]
      .filter(Boolean)
      .join(", ");
    const tag = flags ? ` [${flags}]` : "";
    const reason = c.rejectionReason ? ` — ${c.rejectionReason}` : "";
    console.log(`  ${c.name}${tag} — ${c.description || "(no description)"}${reason}`);
  }
}
