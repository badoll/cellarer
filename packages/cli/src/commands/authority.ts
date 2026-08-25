import { Command } from "commander";
import { resolveContext } from "../context.js";
import { rotateMutationAuthority } from "../mutation-authority.js";
import { safeConsole as console } from "../output.js";
import {
  type CommandContractMetadata,
  defineCommandContract,
} from "../protocol/command-contract.js";
import { commandSuccess } from "../protocol/execution.js";

export function authorityCommandRoot(): Command {
  return new Command("authority").description("维护 Store 范围的 mutation authority");
}

export function createAuthorityRotateCommandContract(
  definition: CommandContractMetadata<"authority.rotate">,
) {
  return defineCommandContract<
    "authority.rotate",
    Record<string, never>,
    { readonly operation: { readonly rotated: true } }
  >(definition, {
    createCommand: () =>
      new Command("rotate").description("显式轮换本机 keychain 中的 mutation authority"),
    normalize: () => ({}),
    execute: async () => {
      const { env, storeRoot } = await resolveContext({}, "required");
      const authority = await rotateMutationAuthority(env, storeRoot);
      env.mutationAuthority = authority;
      return commandSuccess({ operation: { rotated: true as const } });
    },
    presentText: (outcome) => {
      if (!outcome.ok) return;
      console.log(
        "✓ mutation authority 已轮换；旧 plan/journal 已失效，必须按 manual recovery 处理。",
      );
    },
    mapError: () => undefined,
  });
}
