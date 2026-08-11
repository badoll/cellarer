import path, { type PlatformPath } from "node:path";

export function isPathInside(
  candidate: string,
  root: string,
  pathApi: PlatformPath = path,
): boolean {
  const relativePath = pathApi.relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(relativePath))
  );
}
