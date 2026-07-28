import type { Env } from "../env.js";
import { assertSafeAtomicPublicationPath } from "../fs/safety.js";
import { sha256 } from "../store/checksum.js";

export class PublicationPostconditionError extends Error {
  readonly code = "PUBLICATION_POSTCONDITION_FAILED" as const;

  constructor(
    readonly path: string,
    expectation: string,
  ) {
    super(`published file ${path} does not match its signed ${expectation}`);
    this.name = "PublicationPostconditionError";
  }
}

export async function publishVerifiedStoreFile(
  env: Env,
  storeRoot: string,
  path: string,
  data: string,
  mode: number,
  label: string,
): Promise<void> {
  await env.fs.mkdir(storeRoot, { recursive: true, mode: 0o700 });
  await assertSafeAtomicPublicationPath(env, path, storeRoot, label);
  const digest = sha256(new TextEncoder().encode(data));
  await env.fs.publishFileAtomically(path, data, { mode });
  await verifyFilePublication(env, path, digest, mode);
  await assertSafeAtomicPublicationPath(env, path, storeRoot, `${label} postcondition`);
}

export async function verifyFilePublication(
  env: Env,
  path: string,
  digest: string,
  mode?: number,
): Promise<void> {
  const beforeRead = await env.fs.lstat(path).catch(() => null);
  const actualDigest = await env.fs
    .readFileBytes(path)
    .then(sha256)
    .catch(() => null);
  const afterRead = await env.fs.lstat(path).catch(() => null);
  const modeMatches =
    mode === undefined ||
    env.platform === "win32" ||
    (afterRead !== null && (afterRead.mode & 0o777) === (mode & 0o777));
  if (
    !beforeRead?.isFile() ||
    beforeRead.isSymbolicLink() ||
    !afterRead?.isFile() ||
    afterRead.isSymbolicLink() ||
    actualDigest !== digest ||
    !modeMatches
  ) {
    throw new PublicationPostconditionError(path, "digest or mode");
  }
}

export async function verifyAbsentPublication(env: Env, path: string): Promise<void> {
  const stat = await env.fs.lstat(path).catch((error: unknown) => {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  });
  if (stat !== null) throw new PublicationPostconditionError(path, "absence postcondition");
}
