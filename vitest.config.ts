import { defineConfig } from "vitest/config";

// 根 vitest 配置:用 test.projects(vitest.workspace.ts 已废弃)。
// 每个包的测试在各自目录下运行;core 是当前唯一含测试的包。
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
    ],
  },
});
