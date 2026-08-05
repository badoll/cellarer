import { type AddResult, add, type SecretMode, type SkillCandidate } from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { createCliGitClient } from "../git-client.js";
import { createSafeConsole } from "../output.js";
import { readProtectedPassphraseInput } from "./secret.js";

interface AddCliOpts {
  force?: boolean;
  list?: boolean;
  skill?: string[];
  all?: boolean;
  collection?: string;
  yes?: boolean;
  json?: boolean;
  secretMode?: string;
  vaultPassphraseFd?: string;
  keychainService?: string;
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
    .option("--secret-mode <mode>", "密钥来源:env(默认)| vault | keychain")
    .option("--vault-passphrase-fd <number>", "从继承的文件描述符读取 vault 口令")
    .option("--keychain-service <name>", "keychain service 名称(默认 cellarer)")
    .option("--json", "输出 JSON report")
    .action(async (source: string, opts: AddCliOpts) => {
      if ((opts.skill?.length ?? 0) > 0 && opts.all) {
        console.error("--skill and --all are mutually exclusive");
        process.exitCode = 1;
        return;
      }
      const ctx = await resolveContext({}, opts.list ? "optional" : "required");
      const secretMode = parseSecretMode(opts.secretMode);
      const vaultPassphrase =
        secretMode === "vault"
          ? await readProtectedPassphraseInput(opts.vaultPassphraseFd)
          : undefined;
      const json = opts.json || process.env.CELLARER_JSON === "1";
      try {
        const r = await add(ctx.env, {
          storeRoot: ctx.storeRoot,
          source,
          force: opts.force,
          list: opts.list,
          skills: opts.skill,
          all: opts.all,
          collection: opts.collection,
          yes: opts.yes,
          gitClient: createCliGitClient(),
          secretMode,
          vaultPassphrase,
          keychainService: opts.keychainService,
        });
        const resultConsole = createSafeConsole(r);
        if (json) {
          resultConsole.log(JSON.stringify(r, null, 2));
          if (r.rejected.length > 0 || r.operation?.ok === false) process.exitCode = 1;
          return;
        }
        printResult(r, opts, resultConsole);
      } catch (err) {
        const errorConsole = createSafeConsole(err);
        if (json) {
          errorConsole.log(
            JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2),
          );
        } else {
          errorConsole.error(err instanceof Error ? err.message : String(err));
        }
        process.exitCode = 1;
      }
    });
}

function parseSecretMode(value: string | undefined): SecretMode | undefined {
  if (value === undefined) return undefined;
  if (["env", "vault", "keychain"].includes(value)) return value as SecretMode;
  throw new TypeError(`无效 --secret-mode "${value}";可选:env | vault | keychain`);
}

function printResult(
  r: AddResult,
  opts: AddCliOpts,
  output: Pick<Console, "log" | "warn" | "error">,
): void {
  if (opts.list) {
    printCandidates(r.candidates, output);
    return;
  }
  for (const i of r.imported) output.log(`✓ 已导入 ${i.kind}/${i.name} → ${i.path}`);
  for (const s of r.skipped) output.log(`- 跳过 ${s.kind}/${s.name}(${s.reason})`);
  for (const j of r.rejected) output.error(`✗ 拒绝 ${j.kind}/${j.name}(${j.reason})`);
  for (const w of r.warnings) output.warn(`⚠ ${w}`);
  if (r.operation?.ok === false) {
    output.error(`✗ mutation ${r.operation.conflict.code}: ${r.operation.conflict.message}`);
  }
  if (r.rejected.length > 0 || r.operation?.ok === false) process.exitCode = 1;
  if (r.imported.length === 0 && r.skipped.length === 0 && r.rejected.length === 0) {
    output.log("未导入任何资源。");
  }
}

function printCandidates(
  candidates: SkillCandidate[],
  output: Pick<Console, "log" | "warn" | "error">,
): void {
  if (candidates.length === 0) {
    output.log("未发现可导入的 skills。");
    return;
  }
  output.log("可导入 skills:");
  for (const c of candidates) {
    const flags = [c.internal ? "internal" : "", c.rejected ? "rejected" : ""]
      .filter(Boolean)
      .join(", ");
    const tag = flags ? ` [${flags}]` : "";
    const reason = c.rejectionReason ? ` — ${c.rejectionReason}` : "";
    output.log(`  ${c.name}${tag} — ${c.description || "(no description)"}${reason}`);
  }
}
