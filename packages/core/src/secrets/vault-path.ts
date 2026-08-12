import { join } from "node:path";

export function vaultPath(storeRoot: string): string {
  return join(storeRoot, "secrets", "vault.age");
}
