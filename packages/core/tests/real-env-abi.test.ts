import { describe, expect, it } from "vitest";
import { snapshotRuntimeSupport } from "../src/real-env.js";

describe("dependency-free snapshot runtime allowlist", () => {
  it.each([
    ["darwin", "x64"],
    ["darwin", "arm64"],
    ["linux", "x64"],
    ["linux", "arm64"],
  ] as const)("supports the Node runtime primitive on %s/%s", (platform, arch) => {
    expect(snapshotRuntimeSupport(platform, arch)).toEqual({ platform, arch });
  });

  it.each([
    ["win32", "x64"],
    ["freebsd", "x64"],
    ["openbsd", "x64"],
    ["linux", "ia32"],
    ["linux", "loong64"],
    ["linux", "riscv64"],
    ["solaris", "mips64"],
  ] as const)("fails closed for unsupported %s/%s before FFI is loaded", (platform, arch) => {
    expect(() => snapshotRuntimeSupport(platform, arch)).toThrow(
      expect.objectContaining({ code: "CELLARER_SNAPSHOT_UNSUPPORTED" }),
    );
  });
});
