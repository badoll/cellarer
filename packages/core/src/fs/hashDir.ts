// Deterministic directory fingerprint. The manifest covers raw file bytes, node kind/mode,
// symlink targets, and empty directories without following nested symlinks.
import { join, relative } from "node:path";
import type { Env, FileStat } from "../env.js";
import { sha256 } from "../store/checksum.js";

type ManifestEntry =
  | { path: string; kind: "directory"; mode: number }
  | { path: string; kind: "file"; mode: number; digest: string }
  | { path: string; kind: "symlink"; mode: number; target: string }
  | { path: string; kind: "other"; mode: number };

export async function hashDir(env: Env, dir: string): Promise<string> {
  const root = await env.fs.stat(dir);
  if (!root.isDirectory()) throw new Error(`directory fingerprint requires a directory: "${dir}"`);
  const manifest: ManifestEntry[] = [{ path: "", kind: "directory", mode: modeOf(root) }];
  await appendEntries(env, dir, dir, manifest);
  return sha256(JSON.stringify(manifest));
}

export function emptyDirectoryFingerprint(mode: number): string {
  return sha256(JSON.stringify([{ path: "", kind: "directory", mode: mode & 0o7777 }]));
}

async function appendEntries(
  env: Env,
  base: string,
  directory: string,
  manifest: ManifestEntry[],
): Promise<void> {
  for (const name of (await env.fs.readdir(directory)).sort()) {
    const absolutePath = join(directory, name);
    const path = relative(base, absolutePath).split(/[\\/]/).join("/");
    const stat = await env.fs.lstat(absolutePath);
    const mode = modeOf(stat);

    if (stat.isSymbolicLink()) {
      manifest.push({ path, kind: "symlink", mode, target: await env.fs.readlink(absolutePath) });
      continue;
    }
    if (stat.isFile()) {
      manifest.push({
        path,
        kind: "file",
        mode,
        digest: sha256(await env.fs.readFileBytes(absolutePath)),
      });
      continue;
    }
    if (stat.isDirectory()) {
      manifest.push({ path, kind: "directory", mode });
      await appendEntries(env, base, absolutePath, manifest);
      continue;
    }
    manifest.push({ path, kind: "other", mode });
  }
}

function modeOf(stat: FileStat): number {
  return stat.mode & 0o7777;
}
