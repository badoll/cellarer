import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { add } from "../src/engine/add.js";
import { initStore } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("engine/add — local source import", () => {
  let t: TmpEnv;
  let storeRoot: string;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });
  afterEach(() => t.cleanup());

  it("imports a local .md file into store/rules", async () => {
    const src = t.path("style.md");
    await t.env.fs.writeFile(src, "# coding style\nuse tabs");
    const r = await add(t.env, { storeRoot, source: src });
    expect(r.imported).toEqual([
      {
        kind: "rules",
        name: "style",
        path: t.path("home", ".cellarer", "store", "rules", "style.md"),
      },
    ]);
    expect(
      await t.env.fs.readFile(t.path("home", ".cellarer", "store", "rules", "style.md")),
    ).toContain("use tabs");
  });

  it("imports a local .json file into store/mcp (normalized)", async () => {
    const src = t.path("ctx.json");
    await t.env.fs.writeFile(src, JSON.stringify({ command: "npx", args: ["ctx7"] }));
    const r = await add(t.env, { storeRoot, source: src });
    expect(r.imported[0]?.kind).toBe("mcp");
    expect(r.imported[0]?.name).toBe("ctx");
    const written = await t.env.fs.readFile(
      t.path("home", ".cellarer", "store", "mcp", "ctx.json"),
    );
    expect(JSON.parse(written).command).toBe("npx");
  });

  it("imports a local directory into store/skills", async () => {
    const src = t.path("my-skill");
    await t.env.fs.mkdir(src, { recursive: true });
    await t.env.fs.writeFile(t.path("my-skill", "SKILL.md"), "# skill");
    const r = await add(t.env, { storeRoot, source: src });
    expect(r.imported[0]?.kind).toBe("skills");
    expect(r.imported[0]?.name).toBe("my-skill");
    expect(
      await t.env.fs.readFile(
        t.path("home", ".cellarer", "store", "skills", "my-skill", "SKILL.md"),
      ),
    ).toBe("# skill");
  });

  it("skips a same-named artifact by default, overwrites with --force", async () => {
    const src = t.path("style.md");
    await t.env.fs.writeFile(src, "v1");
    await add(t.env, { storeRoot, source: src });
    // 第二次同名:默认跳过。
    await t.env.fs.writeFile(src, "v2");
    const skip = await add(t.env, { storeRoot, source: src });
    expect(skip.imported).toHaveLength(0);
    expect(skip.skipped[0]?.reason).toMatch(/already exists/);
    expect(await t.env.fs.readFile(t.path("home", ".cellarer", "store", "rules", "style.md"))).toBe(
      "v1",
    );
    // --force:覆盖。
    const forced = await add(t.env, { storeRoot, source: src, force: true });
    expect(forced.imported).toHaveLength(1);
    expect(await t.env.fs.readFile(t.path("home", ".cellarer", "store", "rules", "style.md"))).toBe(
      "v2",
    );
  });

  it("rejects importing content with a plaintext secret (no plaintext into store)", async () => {
    const src = t.path("leak.md");
    // 高置信明文密钥(GitHub PAT 形态)。
    await t.env.fs.writeFile(src, "token: ghp_0123456789abcdefghijklmnopqrstuvwx");
    const r = await add(t.env, { storeRoot, source: src });
    expect(r.imported).toHaveLength(0);
    expect(r.rejected[0]?.kind).toBe("rules");
    expect(r.rejected[0]?.reason).toMatch(/plaintext secret/);
    // 库房里绝不出现该制品。
    await expect(
      t.env.fs.readFile(t.path("home", ".cellarer", "store", "rules", "leak.md")),
    ).rejects.toThrow();
  });

  it("rejects a skill dir containing a plaintext secret in any file", async () => {
    const src = t.path("bad-skill");
    await t.env.fs.mkdir(src, { recursive: true });
    await t.env.fs.writeFile(t.path("bad-skill", "SKILL.md"), "# ok");
    await t.env.fs.writeFile(t.path("bad-skill", "cfg.txt"), "AKIAABCDEFGHIJKLMNOP");
    const r = await add(t.env, { storeRoot, source: src });
    expect(r.rejected[0]?.kind).toBe("skills");
    await expect(
      t.env.fs.stat(t.path("home", ".cellarer", "store", "skills", "bad-skill")),
    ).rejects.toThrow();
  });

  it("rejects an mcp source with a structured (non-prefix) secret in env (stronger than text scan)", async () => {
    const src = t.path("leaky.json");
    // 32-hex,不含任何 high-value 前缀 → 纯文本扫描漏,但字段名 API_KEY + 高熵会被结构化检测命中。
    await t.env.fs.writeFile(
      src,
      JSON.stringify({ command: "npx", env: { API_KEY: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" } }),
    );
    const r = await add(t.env, { storeRoot, source: src });
    expect(r.imported).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/mcp field/);
    // 库房绝不出现该明文制品。
    await expect(
      t.env.fs.readFile(t.path("home", ".cellarer", "store", "mcp", "leaky.json")),
    ).rejects.toThrow();
  });

  it("accepts an mcp source that uses placeholders (no plaintext)", async () => {
    const src = t.path("ok.json");
    await t.env.fs.writeFile(
      src,
      JSON.stringify({ command: "npx", env: { API_KEY: "${CELLARER_SECRET:API_KEY}" } }),
    );
    const r = await add(t.env, { storeRoot, source: src });
    expect(r.imported[0]?.kind).toBe("mcp");
  });

  it("rejects a skill dir containing a symlink (would smuggle host content into the store)", async () => {
    const secret = t.path("host-secret.txt");
    await t.env.fs.writeFile(secret, "ghp_0123456789abcdefghijklmnopqrstuvwx");
    const src = t.path("link-skill");
    await t.env.fs.mkdir(src, { recursive: true });
    await t.env.fs.writeFile(t.path("link-skill", "SKILL.md"), "# ok");
    // 软链指向宿主机文件:lstat 跳过扫描但 cp 会原样拷入 → 必须拒绝。
    await t.env.fs.symlink(secret, t.path("link-skill", "creds"), "file");
    const r = await add(t.env, { storeRoot, source: src });
    expect(r.imported).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/symlink/);
    await expect(
      t.env.fs.stat(t.path("home", ".cellarer", "store", "skills", "link-skill")),
    ).rejects.toThrow();
  });

  it("gives a friendly stub error for owner/repo git sources", async () => {
    await expect(add(t.env, { storeRoot, source: "vercel-labs/skills" })).rejects.toThrow(
      /git.*暂未实现|owner\/repo/,
    );
  });

  it("gives a friendly stub error for URL sources", async () => {
    await expect(add(t.env, { storeRoot, source: "https://example.com/x.md" })).rejects.toThrow(
      /URL.*暂未实现/,
    );
  });

  it("rejects an unsupported local file type", async () => {
    const src = t.path("weird.xyz");
    await t.env.fs.writeFile(src, "content");
    await expect(add(t.env, { storeRoot, source: src })).rejects.toThrow(
      /unsupported source file type/,
    );
  });
});
