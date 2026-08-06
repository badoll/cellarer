import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import {
  type CliErrorCode,
  type Env,
  type HeadlessLifetimeLease,
  MUTATION_AUTHORITY_ACCOUNT_PREFIX,
  MUTATION_AUTHORITY_CREDENTIAL_SERVICE,
  type MutationAuthority,
  type MutationAuthorityRequest,
  type MutationAuthorizationEnvelope,
  type ProtectedJournalTip,
  withMutationAuthorityRotationExclusion,
} from "@cellarer/core";
import { tryAuthorityCredentialStore } from "./keychain.js";
import { CliHandledError } from "./protocol/errors.js";

type SecretStore = NonNullable<Env["secretStore"]>;
type MutationAuthorityLease = Awaited<ReturnType<MutationAuthority["acquireLease"]>>;

export const HEADLESS_MUTATION_AUTHORITY_ENV = "CELLARER_MUTATION_AUTHORITY";

const AUTHORIZATION_ALGORITHM = "HMAC-SHA-256" as const;
const AUTHORIZATION_SCHEMA_VERSION = 1 as const;
const MASTER_KEY_BYTES = 32;
const BASE64URL_256 = /^[A-Za-z0-9_-]{43}$/;
const AUTHORITY_ID = /^[A-Za-z0-9._-]{1,128}$/;
const headlessAuthorities = new WeakSet<MutationAuthority>();
const heldHeadlessOwners = new Map<string, HeldHeadlessOwner>();

interface AuthorityMaterial {
  readonly authorityId: string;
  readonly authorityEpoch: number;
  readonly masterKey: Buffer;
}

interface HeldHeadlessOwner {
  readonly authorityId: string;
  readonly authorityEpoch: number;
  readonly lease: HeadlessLifetimeLease;
}

export type MutationAuthorityCompositionMode = "none" | "optional" | "required" | "provision";

export async function attachMutationAuthority(
  env: Env,
  storeRoot: string,
  mode: MutationAuthorityCompositionMode,
  credentialStore: SecretStore | null | undefined = persistentCredentialStore(),
): Promise<void> {
  try {
    let normalizedStoreRoot: string;
    try {
      normalizedStoreRoot = await canonicalizeStoreRoot(env, storeRoot, {
        create: mode === "provision",
      });
    } catch (error) {
      if ((mode === "none" || mode === "optional") && isMissingPathError(error)) return;
      throw error;
    }
    if (mode === "none") return;
    if (env.mutationAuthority) return;
    if (mode === "provision") {
      env.mutationAuthority = await provisionMutationAuthority(
        env,
        normalizedStoreRoot,
        credentialStore,
      );
      return;
    }
    try {
      const authority = await loadMutationAuthority(env, normalizedStoreRoot, credentialStore);
      if (authority) {
        env.mutationAuthority = authority;
        return;
      }
    } catch (error) {
      if (mode === "required") throw error;
      return;
    }
    if (mode === "required") {
      throw authorityError(
        "POLICY_VIOLATION",
        "mutation authority is unavailable; run cellarer init",
      );
    }
  } finally {
    // The composition root consumes the protected channel. Core/Web receive a copied environment
    // map without raw authority material; process.env itself is not mutated.
    if (Object.hasOwn(env.env, HEADLESS_MUTATION_AUTHORITY_ENV)) {
      const sanitized = { ...env.env };
      delete sanitized[HEADLESS_MUTATION_AUTHORITY_ENV];
      env.env = sanitized;
    }
  }
}

export async function loadMutationAuthority(
  env: Env,
  storeRoot: string,
  credentialStore: SecretStore | null | undefined = persistentCredentialStore(),
): Promise<MutationAuthority | undefined> {
  const normalizedStoreRoot = await canonicalizeStoreRoot(env, storeRoot);
  const protectedEnvironmentValue = env.env[HEADLESS_MUTATION_AUTHORITY_ENV];
  if (protectedEnvironmentValue !== undefined) {
    const material = parseHeadlessMaterial(protectedEnvironmentValue, normalizedStoreRoot);
    const owner = await acquireHeadlessAuthorityOwner(env, normalizedStoreRoot, material);
    const authority = createMutationAuthority(material, normalizedStoreRoot, env, undefined, owner);
    headlessAuthorities.add(authority);
    return authority;
  }

  const encoded = await readPersistentCredential(normalizedStoreRoot, credentialStore);
  if (encoded === undefined) return undefined;
  return createMutationAuthority(
    parsePersistentMaterial(encoded),
    normalizedStoreRoot,
    env,
    credentialStore,
    undefined,
  );
}

export async function provisionMutationAuthority(
  env: Env,
  storeRoot: string,
  credentialStore: SecretStore | null | undefined = persistentCredentialStore(),
): Promise<MutationAuthority> {
  const normalizedStoreRoot = await canonicalizeStoreRoot(env, storeRoot, { create: true });
  if (env.env[HEADLESS_MUTATION_AUTHORITY_ENV] !== undefined) {
    const authority = await loadMutationAuthority(env, normalizedStoreRoot, credentialStore);
    if (!authority) {
      throw authorityError("POLICY_VIOLATION", "mutation authority is unavailable");
    }
    return authority;
  }
  if (!credentialStore) {
    throw authorityError("POLICY_VIOLATION", "mutation authority provider is unavailable");
  }

  const coordination = await acquireAuthorityCoordination(env, normalizedStoreRoot);
  try {
    const existing = await readPersistentCredential(normalizedStoreRoot, credentialStore);
    if (existing !== undefined) {
      return createMutationAuthority(
        parsePersistentMaterial(existing),
        normalizedStoreRoot,
        env,
        credentialStore,
        undefined,
      );
    }

    const material: AuthorityMaterial = {
      authorityId: localAuthorityId(env, normalizedStoreRoot),
      authorityEpoch: 1,
      masterKey: randomBytes(MASTER_KEY_BYTES),
    };
    const encoded = encodePersistentMaterial(material);
    await writeAndVerifyPersistentCredential(
      normalizedStoreRoot,
      encoded,
      "provisioning",
      credentialStore,
    );
    return createMutationAuthority(material, normalizedStoreRoot, env, credentialStore, undefined);
  } finally {
    await coordination.release();
  }
}

export async function rotateMutationAuthority(
  env: Env,
  storeRoot: string,
  credentialStore: SecretStore | null | undefined = persistentCredentialStore(),
): Promise<MutationAuthority> {
  const normalizedStoreRoot = await canonicalizeStoreRoot(env, storeRoot);
  if (
    env.env[HEADLESS_MUTATION_AUTHORITY_ENV] !== undefined ||
    (env.mutationAuthority !== undefined && headlessAuthorities.has(env.mutationAuthority))
  ) {
    throw authorityError(
      "POLICY_VIOLATION",
      `replace ${HEADLESS_MUTATION_AUTHORITY_ENV} through the protected environment to rotate it`,
    );
  }
  if (!credentialStore) {
    throw authorityError("POLICY_VIOLATION", "mutation authority provider is unavailable");
  }
  const coordination = await acquireAuthorityCoordination(env, normalizedStoreRoot);
  try {
    try {
      return await withMutationAuthorityRotationExclusion(env, normalizedStoreRoot, async () => {
        const encoded = await readPersistentCredential(normalizedStoreRoot, credentialStore);
        if (encoded === undefined) {
          throw authorityError(
            "POLICY_VIOLATION",
            "mutation authority is not provisioned; run cellarer init",
          );
        }
        const current = parsePersistentMaterial(encoded);
        if (current.authorityEpoch >= Number.MAX_SAFE_INTEGER) {
          current.masterKey.fill(0);
          throw authorityError(
            "DOMAIN_VALIDATION_FAILED",
            "mutation authority epoch cannot be advanced",
          );
        }
        const replacement: AuthorityMaterial = {
          authorityId: current.authorityId,
          authorityEpoch: current.authorityEpoch + 1,
          masterKey: randomBytes(MASTER_KEY_BYTES),
        };
        current.masterKey.fill(0);
        const replacementEncoded = encodePersistentMaterial(replacement);
        await writeAndVerifyPersistentCredential(
          normalizedStoreRoot,
          replacementEncoded,
          "rotation",
          credentialStore,
        );
        return createMutationAuthority(
          replacement,
          normalizedStoreRoot,
          env,
          credentialStore,
          undefined,
        );
      });
    } catch (error) {
      throw mapAuthorityRotationError(error);
    }
  } finally {
    await coordination.release();
  }
}

export async function canonicalizeStoreRoot(
  env: Env,
  storeRoot: string,
  options: { create?: boolean } = {},
): Promise<string> {
  const absoluteStoreRoot = resolve(env.cwd(), storeRoot);
  if (options.create) {
    await env.fs.mkdir(absoluteStoreRoot, { recursive: true, mode: 0o700 });
  }
  return env.fs.realpath(absoluteStoreRoot);
}

function isMissingPathError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

function authorityAccount(normalizedStoreRoot: string): string {
  return `${MUTATION_AUTHORITY_ACCOUNT_PREFIX}${createHash("sha256").update(normalizedStoreRoot).digest("hex")}`;
}

function journalTipAccount(normalizedStoreRoot: string): string {
  return `${MUTATION_AUTHORITY_ACCOUNT_PREFIX}${createHash("sha256")
    .update("cellarer-protected-journal-tip\0")
    .update(normalizedStoreRoot)
    .digest("hex")}`;
}

async function readPersistentCredential(
  normalizedStoreRoot: string,
  provider: SecretStore | null | undefined,
): Promise<string | undefined> {
  if (!provider) return undefined;
  const result = await provider.get(
    MUTATION_AUTHORITY_CREDENTIAL_SERVICE,
    authorityAccount(normalizedStoreRoot),
  );
  if ("error" in result) {
    throw authorityError("POLICY_VIOLATION", "mutation authority provider is unavailable");
  }
  return result.found ? result.value : undefined;
}

async function writeAndVerifyPersistentCredential(
  normalizedStoreRoot: string,
  encoded: string,
  operation: "provisioning" | "rotation",
  provider: SecretStore | null | undefined,
): Promise<void> {
  if (!provider) {
    throw authorityError("POLICY_VIOLATION", "mutation authority provider is unavailable");
  }
  const account = authorityAccount(normalizedStoreRoot);
  try {
    await provider.set(MUTATION_AUTHORITY_CREDENTIAL_SERVICE, account, encoded);
  } catch {
    throw authorityError("EXECUTION_FAILED", `mutation authority ${operation} failed`);
  }
  const readBack = await readPersistentCredential(normalizedStoreRoot, provider);
  if (!readBack || !safeStringEqual(readBack, encoded)) {
    throw authorityError(
      "EXECUTION_FAILED",
      `mutation authority ${operation} read-back verification failed`,
    );
  }
}

function localAuthorityId(env: Env, normalizedStoreRoot: string): string {
  return `local-${createHash("sha256")
    .update("cellarer-local-authority-id\0")
    .update(normalizedStoreRoot)
    .update("\0")
    .update(env.randomId())
    .digest("hex")}`;
}

function parseHeadlessMaterial(value: string, normalizedStoreRoot: string): AuthorityMaterial {
  const parts = value.split(":");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw authorityError("INVALID_INPUT", "protected environment authority is malformed");
  }
  const authorityEpoch = parseEpoch(parts[1]);
  const masterKey = parseKey(parts[2]);
  const authorityId = `headless-${createHash("sha256")
    .update("cellarer-headless-authority-id\0")
    .update(normalizedStoreRoot)
    .update("\0")
    .update(masterKey)
    .digest("hex")}`;
  return { authorityId, authorityEpoch, masterKey };
}

function parsePersistentMaterial(value: string): AuthorityMaterial {
  const parts = value.split(":");
  if (parts.length !== 4 || parts[0] !== "v1" || !parts[1] || !AUTHORITY_ID.test(parts[1])) {
    throw authorityError("RECOVERY_REQUIRED", "stored mutation authority is malformed");
  }
  return {
    authorityId: parts[1],
    authorityEpoch: parseEpoch(parts[2], "stored mutation authority is malformed"),
    masterKey: parseKey(parts[3], "stored mutation authority is malformed"),
  };
}

function encodePersistentMaterial(material: AuthorityMaterial): string {
  return `v1:${material.authorityId}:${material.authorityEpoch}:${material.masterKey.toString("base64url")}`;
}

function parseEpoch(
  value: string | undefined,
  message = "protected environment authority is malformed",
) {
  if (!value || !/^[1-9][0-9]*$/.test(value)) throw malformedAuthorityError(message);
  const epoch = Number(value);
  if (!Number.isSafeInteger(epoch) || epoch <= 0) throw malformedAuthorityError(message);
  return epoch;
}

function parseKey(
  value: string | undefined,
  message = "protected environment authority is malformed",
) {
  if (!value || !BASE64URL_256.test(value)) throw malformedAuthorityError(message);
  const key = Buffer.from(value, "base64url");
  if (key.length !== MASTER_KEY_BYTES || key.toString("base64url") !== value)
    throw malformedAuthorityError(message);
  return key;
}

function createMutationAuthority(
  material: AuthorityMaterial,
  normalizedStoreRoot: string,
  env: Env,
  credentialStore: SecretStore | null | undefined,
  headlessOwner: HeldHeadlessOwner | undefined,
): MutationAuthority {
  const scopedKey = createHmac("sha256", material.masterKey)
    .update("cellarer-store-mutation-authority\0")
    .update(normalizedStoreRoot)
    .digest();
  material.masterKey.fill(0);
  const { authorityId, authorityEpoch } = material;
  let processLocalJournalTip: ProtectedJournalTip | undefined;

  const mac = <Domain extends MutationAuthorizationEnvelope["domain"]>(
    request: MutationAuthorityRequest<Domain>,
    envelope: Omit<MutationAuthorizationEnvelope<Domain>, "seal">,
  ): string =>
    `hmac-sha256:${createHmac("sha256", scopedKey)
      .update("cellarer-mutation-authority\0")
      .update(request.domain)
      .update("\0")
      .update(
        JSON.stringify({
          request: {
            schemaVersion: request.schemaVersion,
            domain: request.domain,
            normalizedStoreRoot: request.normalizedStoreRoot,
            operation: request.operation,
            baseRevision: request.baseRevision,
            canonicalPayload: request.canonicalPayload,
          },
          envelope,
        }),
      )
      .digest("hex")}`;

  const seal = <Domain extends MutationAuthorizationEnvelope["domain"]>(
    request: MutationAuthorityRequest<Domain>,
  ): MutationAuthorizationEnvelope<Domain> => {
    const envelope = {
      schemaVersion: AUTHORIZATION_SCHEMA_VERSION,
      domain: request.domain,
      algorithm: AUTHORIZATION_ALGORITHM,
      authorityId,
      authorityEpoch,
    };
    return Object.freeze({ ...envelope, seal: mac(request, envelope) });
  };

  const verify = <Domain extends MutationAuthorizationEnvelope["domain"]>(
    request: MutationAuthorityRequest<Domain>,
    envelope: MutationAuthorizationEnvelope<Domain>,
  ): boolean => {
    if (
      request.normalizedStoreRoot !== normalizedStoreRoot ||
      envelope.schemaVersion !== AUTHORIZATION_SCHEMA_VERSION ||
      envelope.domain !== request.domain ||
      envelope.algorithm !== AUTHORIZATION_ALGORITHM ||
      envelope.authorityId !== authorityId ||
      envelope.authorityEpoch !== authorityEpoch
    ) {
      return false;
    }
    const { seal: _seal, ...metadata } = envelope;
    return safeStringEqual(envelope.seal, mac(request, metadata));
  };

  const isCurrent = async (): Promise<boolean> => {
    if (headlessOwner) {
      return headlessLeaseIsCurrent(headlessOwner.lease);
    }
    try {
      const encoded = await readPersistentCredential(normalizedStoreRoot, credentialStore);
      if (!encoded) return false;
      const current = parsePersistentMaterial(encoded);
      const currentScopedKey = createHmac("sha256", current.masterKey)
        .update("cellarer-store-mutation-authority\0")
        .update(normalizedStoreRoot)
        .digest();
      current.masterKey.fill(0);
      const matches =
        current.authorityId === authorityId &&
        current.authorityEpoch === authorityEpoch &&
        currentScopedKey.length === scopedKey.length &&
        timingSafeEqual(currentScopedKey, scopedKey);
      currentScopedKey.fill(0);
      return matches;
    } catch {
      return false;
    }
  };

  const acquireLease = async (): Promise<MutationAuthorityLease> => {
    const coordination = await acquireAuthorityCoordination(env, normalizedStoreRoot);
    let released = false;
    return Object.freeze({
      isCurrent: async () => !released && (await isCurrent()),
      release: async () => {
        if (released) return;
        await coordination.release();
        released = true;
      },
    });
  };

  const publishJournalTip = async (tip: ProtectedJournalTip): Promise<void> => {
    assertProtectedJournalTip(tip);
    if (headlessOwner) {
      processLocalJournalTip = { ...tip };
      return;
    }
    if (!credentialStore) throw new Error("protected journal tip provider is unavailable");
    const account = journalTipAccount(normalizedStoreRoot);
    const encoded = JSON.stringify(tip);
    try {
      await credentialStore.set(MUTATION_AUTHORITY_CREDENTIAL_SERVICE, account, encoded);
      const readBack = await readPersistentJournalTip(normalizedStoreRoot, credentialStore);
      if (!readBack || !sameProtectedJournalTip(readBack, tip)) {
        throw new Error("protected journal tip read-back verification failed");
      }
    } catch {
      throw new Error("protected journal tip publication failed");
    }
  };

  const matchesJournalTip = async (tip: ProtectedJournalTip): Promise<boolean> => {
    try {
      assertProtectedJournalTip(tip);
      const current = headlessOwner
        ? processLocalJournalTip
        : await readPersistentJournalTip(normalizedStoreRoot, credentialStore);
      return current !== undefined && sameProtectedJournalTip(current, tip);
    } catch {
      return false;
    }
  };

  return Object.freeze(
    Object.defineProperties(
      {},
      {
        seal: { value: seal, enumerable: false },
        verify: { value: verify, enumerable: false },
        isCurrent: { value: isCurrent, enumerable: false },
        acquireLease: { value: acquireLease, enumerable: false },
        publishJournalTip: { value: publishJournalTip, enumerable: false },
        matchesJournalTip: { value: matchesJournalTip, enumerable: false },
      },
    ),
  ) as MutationAuthority;
}

function headlessOwnerProcessKey(
  normalizedStoreRoot: string,
  processId: number,
  hostname: string,
): string {
  return `${normalizedStoreRoot}\0${hostname}\0${processId}`;
}

async function acquireHeadlessAuthorityOwner(
  env: Env,
  normalizedStoreRoot: string,
  material: Pick<AuthorityMaterial, "authorityId" | "authorityEpoch">,
): Promise<HeldHeadlessOwner> {
  const lifetimeOwner = env.headlessLifetimeOwner;
  if (!lifetimeOwner) {
    throw authorityError(
      "LOCK_CONFLICT",
      "headless mutation authority owner is active or unavailable",
    );
  }
  const processId = env.processId();
  const hostname = env.hostname();
  const processKey = headlessOwnerProcessKey(normalizedStoreRoot, processId, hostname);
  const held = heldHeadlessOwners.get(processKey);
  if (held && (await headlessLeaseIsCurrent(held.lease))) {
    if (
      held.authorityId === material.authorityId &&
      held.authorityEpoch === material.authorityEpoch
    ) {
      return held;
    }
    throw authorityError(
      "LOCK_CONFLICT",
      "headless mutation authority owner is active or unavailable",
    );
  }
  if (held) {
    heldHeadlessOwners.delete(processKey);
  }

  let lease: HeadlessLifetimeLease;
  try {
    lease = await lifetimeOwner.acquire(normalizedStoreRoot);
  } catch {
    throw authorityError(
      "LOCK_CONFLICT",
      "headless mutation authority owner is active or unavailable",
    );
  }
  if (!(await headlessLeaseIsCurrent(lease))) {
    throw authorityError(
      "LOCK_CONFLICT",
      "headless mutation authority owner is active or unavailable",
    );
  }

  // Concurrent loads in one process may await the same kernel acquisition. Re-check the
  // process-local authority binding after the await so a different epoch cannot share that lease.
  const winner = heldHeadlessOwners.get(processKey);
  if (winner && (await headlessLeaseIsCurrent(winner.lease))) {
    if (
      winner.authorityId === material.authorityId &&
      winner.authorityEpoch === material.authorityEpoch
    ) {
      return winner;
    }
    throw authorityError(
      "LOCK_CONFLICT",
      "headless mutation authority owner is active or unavailable",
    );
  }

  const owner = Object.freeze({
    authorityId: material.authorityId,
    authorityEpoch: material.authorityEpoch,
    lease,
  });
  heldHeadlessOwners.set(processKey, owner);
  return owner;
}

async function headlessLeaseIsCurrent(lease: HeadlessLifetimeLease): Promise<boolean> {
  try {
    return await lease.isCurrent();
  } catch {
    return false;
  }
}

async function readPersistentJournalTip(
  normalizedStoreRoot: string,
  provider: SecretStore | null | undefined,
): Promise<ProtectedJournalTip | undefined> {
  if (!provider) return undefined;
  const result = await provider.get(
    MUTATION_AUTHORITY_CREDENTIAL_SERVICE,
    journalTipAccount(normalizedStoreRoot),
  );
  if ("error" in result) throw new Error("protected journal tip provider is unavailable");
  if (!result.found) return undefined;
  const parsed: unknown = JSON.parse(result.value);
  assertProtectedJournalTip(parsed);
  return parsed;
}

function assertProtectedJournalTip(value: unknown): asserts value is ProtectedJournalTip {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== ["operationId", "seal", "sequence"].join("\0") ||
    typeof (value as ProtectedJournalTip).operationId !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test((value as ProtectedJournalTip).operationId) ||
    !Number.isSafeInteger((value as ProtectedJournalTip).sequence) ||
    (value as ProtectedJournalTip).sequence < 1 ||
    typeof (value as ProtectedJournalTip).seal !== "string" ||
    !/^hmac-sha256:[0-9a-f]{64}$/.test((value as ProtectedJournalTip).seal)
  ) {
    throw new TypeError("protected journal tip is invalid");
  }
}

function sameProtectedJournalTip(left: ProtectedJournalTip, right: ProtectedJournalTip): boolean {
  return (
    left.operationId === right.operationId &&
    left.sequence === right.sequence &&
    safeStringEqual(left.seal, right.seal)
  );
}

interface AuthorityCoordinationLease {
  release(): Promise<void>;
}

async function acquireAuthorityCoordination(
  env: Env,
  normalizedStoreRoot: string,
): Promise<AuthorityCoordinationLease> {
  await env.fs.mkdir(normalizedStoreRoot, { recursive: true, mode: 0o700 });
  const path = join(normalizedStoreRoot, "authority-coordination.lock");
  const owner = `${JSON.stringify({
    schemaVersion: 1,
    processId: env.processId(),
    hostname: env.hostname(),
    nonce: env.randomId(),
  })}\n`;
  for (let attempt = 0; attempt < 4_096; attempt += 1) {
    if (await env.fs.writeFileExclusive(path, owner, { mode: 0o600 })) {
      let released = false;
      return {
        release: async () => {
          if (released) return;
          const current = await env.fs.readFile(path).catch((error: unknown) => {
            if ((error as { code?: string }).code === "ENOENT") return null;
            throw error;
          });
          if (current !== owner) {
            throw authorityError(
              "LOCK_CONFLICT",
              "mutation authority coordination owner changed before release",
            );
          }
          await env.fs.rm(path);
          released = true;
        },
      };
    }
    // Every iteration crosses the injected filesystem boundary. Yielding here lets the holder
    // publish and release without introducing an un-injected clock or timer into Core.
    await Promise.resolve();
  }
  throw authorityError("LOCK_CONFLICT", "mutation authority coordination is unavailable");
}

function persistentCredentialStore(): SecretStore | undefined {
  return tryAuthorityCredentialStore() ?? undefined;
}

function safeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function authorityError(code: CliErrorCode, message: string) {
  return new CliHandledError({ code, message });
}

function malformedAuthorityError(message: string): CliHandledError {
  return authorityError(
    message.startsWith("protected environment") ? "INVALID_INPUT" : "RECOVERY_REQUIRED",
    message,
  );
}

function mapAuthorityRotationError(error: unknown): unknown {
  if (error instanceof CliHandledError) return error;
  const message = error instanceof Error ? error.message : "";
  if (
    message === "mutation authority rotation refused while an active operation journal exists" ||
    message === "mutation authority rotation refused while recovery is active"
  ) {
    return new CliHandledError({ code: "RECOVERY_REQUIRED", message });
  }
  if (message === "mutation authority rotation refused while a mutation is active") {
    return new CliHandledError({ code: "LOCK_CONFLICT", message });
  }
  if (message === "mutation authority rotation safety check failed") {
    return new CliHandledError({ code: "EXECUTION_FAILED", message });
  }
  return error;
}
