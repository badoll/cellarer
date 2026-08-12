import { promises as nodeFs } from "node:fs";
import type { CurrentUserOnlyPermissions } from "../env.js";

export function createRealCredentialAdapter(): {
  readonly currentUserOnlyPermissions: CurrentUserOnlyPermissions;
} {
  return {
    currentUserOnlyPermissions: {
      supported: (platform) => platform !== "win32",
      set: (path) => nodeFs.chmod(path, 0o600),
      verify: async (path) => {
        const stat = await nodeFs.lstat(path);
        return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0;
      },
    },
  };
}
