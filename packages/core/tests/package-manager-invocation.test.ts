import { describe, expect, it } from "vitest";
import { packageManagerInvocation } from "./helpers/package-manager.js";

describe("package manager invocation", () => {
  it("uses direct execFile arguments on POSIX", () => {
    expect(packageManagerInvocation("darwin", undefined, ["pack", "--json"])).toEqual({
      file: "pnpm",
      args: ["pack", "--json"],
    });
  });

  it("uses ComSpec to launch the pnpm shim on Windows", () => {
    expect(
      packageManagerInvocation(
        "win32",
        "C:\\Windows\\System32\\cmd.exe",
        ["pack", "--json", "--pack-destination", "C:\\Temp\\core pack"],
        "",
      ),
    ).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", 'pnpm "pack" "--json" "--pack-destination" "C:\\Temp\\core pack"'],
    });
  });

  it("launches npm_execpath through Node without rejecting legal Windows path characters", () => {
    const nodeExecPath = "C:\\Program Files\\nodejs\\node.exe";
    const npmExecPath = "C:\\Toolchains\\pnpm & (controlled)^\\pnpm.cjs";
    expect(
      packageManagerInvocation(
        "win32",
        "C:\\Windows\\System32\\cmd.exe",
        ["pack", "--pack-destination", "C:\\Temp\\artifact & (controlled)^"],
        npmExecPath,
        nodeExecPath,
      ),
    ).toEqual({
      file: nodeExecPath,
      args: [npmExecPath, "pack", "--pack-destination", "C:\\Temp\\artifact & (controlled)^"],
    });
  });

  it("fails closed instead of interpolating shell control characters", () => {
    expect(() =>
      packageManagerInvocation(
        "win32",
        "C:\\Windows\\System32\\cmd.exe",
        ["pack", "C:\\Temp\\artifact & whoami"],
        "",
      ),
    ).toThrow(/unsafe character/u);
  });
});
