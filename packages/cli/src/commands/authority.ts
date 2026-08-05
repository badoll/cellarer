import { Command } from "commander";
import { resolveContext } from "../context.js";
import { rotateMutationAuthority } from "../mutation-authority.js";
import { safeConsole as console } from "../output.js";
import { commandSuccess, executeCliCommand } from "../protocol/execution.js";

export function authorityCommand(): Command {
  const command = new Command("authority").description("维护 Store 范围的 mutation authority");

  command
    .command("rotate")
    .description("显式轮换本机 keychain 中的 mutation authority")
    .action(async (_opts: object, actionCommand: Command) => {
      await executeCliCommand(
        actionCommand,
        async () => {
          const { env, storeRoot } = await resolveContext({}, "required");
          const authority = await rotateMutationAuthority(env, storeRoot);
          env.mutationAuthority = authority;
          return commandSuccess({ operation: { rotated: true } });
        },
        (outcome) => {
          if (!outcome.ok) return;
          console.log(
            "✓ mutation authority 已轮换；旧 plan/journal 已失效，必须按 manual recovery 处理。",
          );
        },
      );
    });

  return command;
}
