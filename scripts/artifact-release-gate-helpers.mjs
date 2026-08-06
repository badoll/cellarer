import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, sep } from "node:path";

export function optionalKeychainInstalled(installed) {
  const cliManifest = join(
    installed.projectRoot,
    "node_modules",
    "@cellarer",
    "cli",
    "package.json",
  );
  try {
    const installedRoot = realpathSync(installed.projectRoot);
    const keyringEntry = realpathSync(
      createRequire(realpathSync(cliManifest)).resolve("@napi-rs/keyring"),
    );
    const pathFromInstall = relative(installedRoot, keyringEntry);
    return (
      pathFromInstall !== ".." &&
      !pathFromInstall.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromInstall)
    );
  } catch {
    return false;
  }
}
