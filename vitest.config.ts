import { defineConfig } from "vitest/config";

// 根 vitest 配置:用 test.projects(vitest.workspace.ts 已废弃)。
// 每个包的测试在各自目录下运行。
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "core",
          root: "./packages/core",
          include: ["tests/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "cli",
          root: "./packages/cli",
          include: ["tests/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "web",
          root: "./packages/web",
          include: ["tests/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "tooling",
          root: ".",
          include: ["scripts/**/*.test.mjs"],
          environment: "node",
        },
      },
    ],
  },
});
