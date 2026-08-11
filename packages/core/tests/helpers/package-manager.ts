export interface PackageManagerInvocation {
  readonly file: string;
  readonly args: readonly string[];
}

export function packageManagerInvocation(
  platform: NodeJS.Platform,
  comSpec: string | undefined,
  args: readonly string[],
  npmExecPath: string | undefined = process.env.npm_execpath,
  nodeExecPath = process.execPath,
): PackageManagerInvocation {
  if (platform === "win32") {
    if (npmExecPath !== undefined && npmExecPath.length > 0) {
      return { file: nodeExecPath, args: [npmExecPath, ...args] };
    }
    if (comSpec === undefined || comSpec.length === 0) {
      throw new Error("ComSpec is required to invoke the pnpm Windows shim");
    }
    const quotedArgs = args.map((arg) => {
      if (/["%!\r\n^&|<>()]/u.test(arg)) {
        throw new Error("unsafe character in controlled pnpm argument");
      }
      return `"${arg}"`;
    });
    return {
      file: comSpec,
      args: ["/d", "/s", "/c", ["pnpm", ...quotedArgs].join(" ")],
    };
  }
  return { file: "pnpm", args };
}
