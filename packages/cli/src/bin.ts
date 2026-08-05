#!/usr/bin/env node
import { createSafeConsole } from "./output.js";
import { buildProgram } from "./program.js";

// 顶层守卫:把 core 抛出的错误(损坏台账/配置等)打印为简洁信息而非裸栈;非零退出。
try {
  await buildProgram().parseAsync(process.argv);
} catch (err) {
  const console = createSafeConsole(err);
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`cellarer: ${msg}`);
  process.exitCode = 1;
}
