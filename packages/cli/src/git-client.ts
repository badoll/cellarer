import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitClient } from "@cellarer/core";

const execFileAsync = promisify(execFile);

export function createCliGitClient(): GitClient {
  return {
    async stageGitHub(source) {
      const dir = await fs.mkdtemp(join(tmpdir(), "cellarer-git-"));
      try {
        if (source.ref) {
          await execGit(["init", dir]);
          await execGit(["-C", dir, "remote", "add", "origin", source.cloneUrl]);
          await execGit(["-C", dir, "fetch", "--depth", "1", "origin", source.ref]);
          await execGit(["-C", dir, "checkout", "--detach", "FETCH_HEAD"]);
        } else {
          await execGit(["clone", "--depth", "1", source.cloneUrl, dir]);
        }
        const { stdout } = await execGit(["-C", dir, "rev-parse", "HEAD"]);
        return {
          path: dir,
          resolvedUrl: source.resolvedUrl,
          ref: source.ref ?? "HEAD",
          commit: stdout.trim(),
          subpath: source.subpath,
          cleanup: () => fs.rm(dir, { recursive: true, force: true }),
        };
      } catch (err) {
        await fs.rm(dir, { recursive: true, force: true });
        throw err;
      }
    },
  };
}

async function execGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("git", args, { encoding: "utf8" });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(e.stderr?.trim() || e.message || "git command failed");
  }
}
