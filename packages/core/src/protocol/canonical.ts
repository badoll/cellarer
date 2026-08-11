import { resolve } from "node:path";
import type {
  Env,
  MutationAuthority,
  MutationAuthorityLease,
  MutationAuthorityRequest,
} from "../env.js";
import {
  assertNoSecretValues,
  registerObservableMutationAuthorization,
} from "../secrets/observable.js";
import { sha256 } from "../store/checksum.js";
import type { AssertExact, ExactContract } from "./client-types.js";
import type {
  DurableMutationPlan,
  MutationAuthorizationEnvelope,
  MutationOperation,
  MutationPlan,
  MutationPlanInput,
  TargetStateReceipt,
} from "./models.js";
import {
  DURABLE_MUTATION_PLAN_DOMAIN,
  EXECUTABLE_MUTATION_PLAN_DOMAIN,
  MUTATION_AUTHORIZATION_ALGORITHM,
  MUTATION_AUTHORIZATION_SCHEMA_VERSION,
  MUTATION_PLAN_SCHEMA_VERSION,
} from "./models.js";

const CANONICAL_ISO_UTC_TIMESTAMP =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

declare const currentMutationAuthorityScopeBrand: unique symbol;

export type CurrentMutationAuthorityScope = Readonly<{
  [currentMutationAuthorityScopeBrand]: true;
}>;

interface CurrentMutationAuthorityScopeRecord {
  readonly authority: MutationAuthority;
  readonly lease: MutationAuthorityLease;
  active: boolean;
}

// A scope is a runtime capability, not a structural TypeScript brand. Only objects created while
// this module owns a current authority lease are present in this table, and captured scopes remain
// permanently inactive after their callback exits.
const currentMutationAuthorityScopes = new WeakMap<object, CurrentMutationAuthorityScopeRecord>();

export const MUTATION_OPERATIONS = [
  "initialize",
  "apply",
  "revert",
  "settings",
  "secret-metadata",
  "store-import",
  "resource-lifecycle",
  "sync-uninstall",
] as const satisfies readonly MutationOperation[];

export const MUTATION_ACTION_KINDS = [
  "write",
  "merge",
  "overwrite",
  "symlink",
  "copy",
  "remove-target",
  "restore-snapshot",
  "sync-gitignore",
  "publish-file",
  "preserve-file",
  "mkdir",
  "keychain-secret-set",
  "keychain-secret-delete",
  "add-rules",
  "add-mcp",
  "add-skills",
  "add-skill-provenance",
  "install-resource-revision",
  "publish-resource-metadata",
  "rename-resource-content",
  "install-resource-content",
  "remove-resource-path",
  "write-resource-bundle",
  "scan-rules",
  "scan-mcp",
  "scan-skills",
] as const;

export function assertStrictMutationPlanRuntime(
  plan: unknown,
  expectedOperation?: MutationOperation,
): asserts plan is MutationPlan {
  assertSupportedMutationPlanRuntime(plan);
  if (
    !hasExactKeys(plan, [
      "actions",
      "authorization",
      "baseRevision",
      "digest",
      "expires",
      "normalizedInputs",
      "operation",
      "planId",
      "schemaVersion",
      "targetPreconditions",
    ])
  ) {
    throw new TypeError("mutation plan has an invalid runtime schema");
  }
  if (
    typeof plan.planId !== "string" ||
    plan.planId.length === 0 ||
    !MUTATION_OPERATIONS.includes(plan.operation as MutationOperation) ||
    (expectedOperation !== undefined && plan.operation !== expectedOperation) ||
    typeof plan.baseRevision !== "number" ||
    !Number.isSafeInteger(plan.baseRevision) ||
    plan.baseRevision < 0 ||
    !isPlainRecord(plan.normalizedInputs) ||
    !Array.isArray(plan.actions) ||
    !Array.isArray(plan.targetPreconditions) ||
    typeof plan.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(plan.digest) ||
    !isStrictMutationAuthorizationEnvelope(plan.authorization, EXECUTABLE_MUTATION_PLAN_DOMAIN)
  ) {
    throw new TypeError("mutation plan has an invalid runtime schema");
  }
  canonicalJson(plan.normalizedInputs);
  for (const action of plan.actions) {
    if (
      !hasExactKeys(
        action,
        action && typeof action === "object" && "postcondition" in action
          ? ["actionId", "kind", "payload", "postcondition", "target"]
          : ["actionId", "kind", "payload", "target"],
      ) ||
      typeof action.actionId !== "string" ||
      action.actionId.length === 0 ||
      typeof action.kind !== "string" ||
      !MUTATION_ACTION_KINDS.includes(action.kind as (typeof MUTATION_ACTION_KINDS)[number]) ||
      typeof action.target !== "string" ||
      action.target.length === 0 ||
      !isPlainRecord(action.payload) ||
      ("postcondition" in action && !isStrictTargetStateReceipt(action.postcondition))
    ) {
      throw new TypeError("mutation plan has an invalid runtime schema");
    }
    canonicalJson(action.payload);
  }
  for (const precondition of plan.targetPreconditions) {
    if (
      !hasExactKeys(precondition, ["actionId", "expected", "target"]) ||
      typeof precondition.actionId !== "string" ||
      precondition.actionId.length === 0 ||
      typeof precondition.target !== "string" ||
      precondition.target.length === 0 ||
      !isStrictTargetStateReceipt(precondition.expected)
    ) {
      throw new TypeError("mutation plan has an invalid runtime schema");
    }
  }
}

export function isStrictMutationAuthorizationEnvelope<
  Domain extends MutationAuthorizationEnvelope["domain"],
>(value: unknown, domain: Domain): value is MutationAuthorizationEnvelope<Domain> {
  return (
    hasExactKeys(value, [
      "algorithm",
      "authorityEpoch",
      "authorityId",
      "domain",
      "schemaVersion",
      "seal",
    ]) &&
    value.schemaVersion === MUTATION_AUTHORIZATION_SCHEMA_VERSION &&
    value.domain === domain &&
    value.algorithm === MUTATION_AUTHORIZATION_ALGORITHM &&
    typeof value.authorityId === "string" &&
    value.authorityId.length > 0 &&
    typeof value.authorityEpoch === "number" &&
    Number.isSafeInteger(value.authorityEpoch) &&
    value.authorityEpoch > 0 &&
    typeof value.seal === "string" &&
    /^hmac-sha256:[0-9a-f]{64}$/.test(value.seal)
  );
}

function isStrictTargetStateReceipt(value: unknown): value is TargetStateReceipt {
  if (!isPlainRecord(value)) return false;
  if (value.state === "absent") return hasExactKeys(value, ["state"]);
  if (value.state !== "present" || typeof value.fingerprint !== "string") return false;
  const keys = ["fingerprint", "state"];
  if ("recoverySnapshot" in value) {
    keys.push("recoverySnapshot", "recoverySnapshotDigest", "recoverySnapshotMode");
    if (
      typeof value.recoverySnapshot !== "string" ||
      typeof value.recoverySnapshotDigest !== "string" ||
      !Number.isInteger(value.recoverySnapshotMode)
    ) {
      return false;
    }
  }
  return hasExactKeys(value, keys);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function assertSupportedMutationPlanRuntime(plan: unknown): void {
  if (typeof plan !== "object" || plan === null) {
    throw new TypeError("mutation plan must be an object");
  }
  const candidate = plan as {
    schemaVersion?: unknown;
    expires?: { policy?: unknown; expiresAt?: unknown } | null;
  };
  if (candidate.schemaVersion !== MUTATION_PLAN_SCHEMA_VERSION) {
    throw new TypeError(
      `unsupported mutation plan schema version; supported version is ${MUTATION_PLAN_SCHEMA_VERSION}`,
    );
  }
  if (typeof candidate.expires !== "object" || candidate.expires === null) {
    throw new TypeError("mutation plan expiry policy must be an object");
  }
  if (candidate.expires.policy === "none") return;
  if (candidate.expires.policy === "expires-at") {
    if (
      typeof candidate.expires.expiresAt !== "string" ||
      !isCanonicalIsoUtcTimestamp(candidate.expires.expiresAt)
    ) {
      throw new TypeError(
        "mutation plan expires-at policy requires a canonical ISO UTC timestamp with a valid date",
      );
    }
    return;
  }
  throw new TypeError(
    'unsupported mutation plan expiry policy; supported policies are "none" and "expires-at"',
  );
}

function isCanonicalIsoUtcTimestamp(value: string): boolean {
  if (!CANONICAL_ISO_UTC_TIMESTAMP.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function canonicalJson(value: unknown): string {
  assertNoSecretValues(value, "plan");
  return encodeCanonicalJson(value);
}

function encodeCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("canonical JSON does not support non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => encodeCanonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical JSON supports only plain objects");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encodeCanonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`canonical JSON does not support ${typeof value}`);
}

export function canonicalMutationPlan(plan: MutationPlanInput | MutationPlan): string {
  const { authorization: _authorization, digest: _digest, ...payload } = plan as MutationPlan;
  return canonicalJson(payload);
}

export function mutationPlanDigest(plan: MutationPlanInput | MutationPlan): string {
  return sha256(canonicalMutationPlan(plan));
}

function createMutationPlanImplementation(input: MutationPlanInput) {
  assertSupportedMutationPlanRuntime(input);
  const encoded = canonicalMutationPlan(input);
  const snapshot = JSON.parse(encoded) as MutationPlanInput;
  // Public integrity-only helper for presentation and hostile-input fixtures. Its deliberately
  // invalid envelope cannot pass executable authorization; raw digest/re-sign helpers stay private.
  return deepFreeze({
    ...snapshot,
    digest: sha256(encoded),
    authorization: {
      schemaVersion: MUTATION_AUTHORIZATION_SCHEMA_VERSION,
      domain: EXECUTABLE_MUTATION_PLAN_DOMAIN,
      algorithm: MUTATION_AUTHORIZATION_ALGORITHM,
      authorityId: "unsealed" as string,
      authorityEpoch: 0 as number,
      seal: `hmac-sha256:${"0".repeat(64)}` as string,
    },
  } as const);
}

export function createMutationPlan(input: MutationPlanInput): MutationPlan {
  return createMutationPlanImplementation(input);
}

export type MutationPlanProducerContract = AssertExact<
  ExactContract<ReturnType<typeof createMutationPlanImplementation>, MutationPlan>
>;

export function createAuthorizedMutationPlan(
  env: Env,
  storeRoot: string,
  input: MutationPlanInput,
): MutationPlan {
  const authority = requireMutationAuthority(env);
  const integrityPlan = createMutationPlan(input);
  const request = mutationAuthorityRequest(env, storeRoot, integrityPlan);
  const authorization = authority.seal(request);
  if (!isStrictMutationAuthorizationEnvelope(authorization, EXECUTABLE_MUTATION_PLAN_DOMAIN)) {
    throw new TypeError("mutation authority returned an invalid authorization envelope");
  }
  if (!authority.verify(request, authorization)) {
    throw new TypeError("mutation authority could not verify its authorization envelope");
  }
  const observableAuthorization = registerObservableMutationAuthorization(
    authorization,
    EXECUTABLE_MUTATION_PLAN_DOMAIN,
  );
  return deepFreeze({ ...integrityPlan, authorization: observableAuthorization });
}

export function verifyMutationPlanAuthorization(
  env: Env,
  storeRoot: string,
  plan: MutationPlan,
): boolean {
  try {
    const authority = requireMutationAuthority(env);
    if (
      !isStrictMutationAuthorizationEnvelope(plan.authorization, EXECUTABLE_MUTATION_PLAN_DOMAIN)
    ) {
      return false;
    }
    if (!authority.verify(mutationAuthorityRequest(env, storeRoot, plan), plan.authorization)) {
      return false;
    }
    registerObservableMutationAuthorization(plan.authorization, EXECUTABLE_MUTATION_PLAN_DOMAIN);
    return true;
  } catch {
    return false;
  }
}

export function requireMutationAuthority(env: Env): MutationAuthority {
  const authority = env.mutationAuthority;
  if (
    typeof authority !== "object" ||
    authority === null ||
    typeof authority.seal !== "function" ||
    typeof authority.verify !== "function" ||
    typeof authority.isCurrent !== "function" ||
    typeof authority.acquireLease !== "function" ||
    typeof authority.publishJournalTip !== "function" ||
    typeof authority.matchesJournalTip !== "function"
  ) {
    throw new TypeError("mutation authority is unavailable");
  }
  return authority;
}

export async function acquireCurrentMutationAuthorityLease(
  env: Env,
): Promise<MutationAuthorityLease | null> {
  const authority = requireMutationAuthority(env);
  if (!(await authority.isCurrent().catch(() => false))) return null;
  const lease = await authority.acquireLease().catch(() => null);
  if (!lease) return null;
  if (!(await lease.isCurrent().catch(() => false))) {
    await lease.release().catch(() => undefined);
    return null;
  }
  return lease;
}

export async function withCurrentMutationAuthorityLease<T>(
  env: Env,
  run: (lease: MutationAuthorityLease) => Promise<T>,
  suppliedLease?: MutationAuthorityLease,
): Promise<T> {
  requireMutationAuthority(env);
  const lease =
    suppliedLease ?? (await acquireCurrentMutationAuthorityLease(env).catch(() => null));
  if (!lease || !(await lease.isCurrent().catch(() => false))) {
    if (lease && !suppliedLease) await lease.release().catch(() => undefined);
    throw new TypeError("mutation authority is not current");
  }
  try {
    return await run(lease);
  } finally {
    if (!suppliedLease) await lease.release();
  }
}

export async function withCurrentMutationAuthorityScope<T>(
  env: Env,
  run: (scope: CurrentMutationAuthorityScope) => Promise<T>,
): Promise<T> {
  const authority = requireMutationAuthority(env);
  const lease = await acquireCurrentMutationAuthorityLease(env).catch(() => null);
  if (!lease) throw new TypeError("mutation authority is not current");
  const scope = Object.freeze(Object.create(null)) as CurrentMutationAuthorityScope;
  const record: CurrentMutationAuthorityScopeRecord = { authority, lease, active: true };
  currentMutationAuthorityScopes.set(scope, record);
  try {
    return await run(scope);
  } finally {
    record.active = false;
    await lease.release();
  }
}

export async function assertCurrentMutationAuthorityScope(
  env: Env,
  scope: CurrentMutationAuthorityScope,
): Promise<MutationAuthorityLease> {
  const authority = requireMutationAuthority(env);
  const record =
    typeof scope === "object" && scope !== null ? currentMutationAuthorityScopes.get(scope) : null;
  if (
    !record?.active ||
    record.authority !== authority ||
    !(await authority.isCurrent().catch(() => false)) ||
    !(await record.lease.isCurrent().catch(() => false))
  ) {
    throw new TypeError("mutation authority scope is not current");
  }
  return record.lease;
}

function mutationAuthorityRequest(
  env: Env,
  storeRoot: string,
  plan: MutationPlan,
): MutationAuthorityRequest {
  const { authorization: _authorization, ...canonicalPayload } = plan;
  return {
    schemaVersion: MUTATION_AUTHORIZATION_SCHEMA_VERSION,
    domain: EXECUTABLE_MUTATION_PLAN_DOMAIN,
    normalizedStoreRoot: resolve(env.cwd(), storeRoot),
    operation: plan.operation,
    baseRevision: plan.baseRevision,
    canonicalPayload: canonicalJson(canonicalPayload),
  };
}

export function verifyMutationPlanDigest(plan: MutationPlan): boolean {
  try {
    return mutationPlanDigest(plan) === plan.digest;
  } catch {
    return false;
  }
}

export function createDurableMutationPlan(
  env: Env,
  storeRoot: string,
  plan: MutationPlan,
): DurableMutationPlan {
  assertSupportedMutationPlanRuntime(plan);
  if (!verifyMutationPlanDigest(plan) || !verifyMutationPlanAuthorization(env, storeRoot, plan)) {
    throw new TypeError("cannot persist an unauthorized mutation plan");
  }
  const input = {
    schemaVersion: plan.schemaVersion,
    planId: plan.planId,
    operation: plan.operation,
    baseRevision: plan.baseRevision,
    normalizedInputsDigest: sha256(canonicalJson(plan.normalizedInputs)),
    targetPreconditions: plan.targetPreconditions,
    actions: plan.actions.map(({ actionId, kind, target, payload, postcondition }) => ({
      actionId,
      kind,
      target,
      payloadDigest: sha256(canonicalJson(payload)),
      ...(["keychain-secret-set", "keychain-secret-delete"].includes(kind) ? { payload } : {}),
      ...(postcondition === undefined ? {} : { postcondition }),
    })),
    expires: plan.expires,
    digest: plan.digest,
  };
  const encoded = canonicalJson(input);
  const integrityPlan = {
    ...(JSON.parse(encoded) as typeof input),
    durableDigest: sha256(encoded),
  };
  const authority = requireMutationAuthority(env);
  const request = durableMutationAuthorityRequest(env, storeRoot, integrityPlan);
  const authorization = authority.seal(request);
  if (!isStrictMutationAuthorizationEnvelope(authorization, DURABLE_MUTATION_PLAN_DOMAIN)) {
    throw new TypeError("mutation authority returned an invalid durable authorization envelope");
  }
  if (!authority.verify(request, authorization)) {
    throw new TypeError("mutation authority could not verify its durable authorization envelope");
  }
  const observableAuthorization = registerObservableMutationAuthorization(
    authorization,
    DURABLE_MUTATION_PLAN_DOMAIN,
  );
  return deepFreeze({
    ...integrityPlan,
    authorization: observableAuthorization,
  });
}

export function verifyDurableMutationPlanDigest(plan: DurableMutationPlan): boolean {
  try {
    const { authorization: _authorization, durableDigest: _durableDigest, ...input } = plan;
    return sha256(canonicalJson(input)) === plan.durableDigest;
  } catch {
    return false;
  }
}

export function verifyDurableMutationPlanAuthorization(
  env: Env,
  storeRoot: string,
  plan: DurableMutationPlan,
): boolean {
  try {
    const authority = requireMutationAuthority(env);
    if (!isStrictMutationAuthorizationEnvelope(plan.authorization, DURABLE_MUTATION_PLAN_DOMAIN)) {
      return false;
    }
    return authority.verify(
      durableMutationAuthorityRequest(env, storeRoot, plan),
      plan.authorization,
    );
  } catch {
    return false;
  }
}

function durableMutationAuthorityRequest(
  env: Env,
  storeRoot: string,
  plan: Omit<DurableMutationPlan, "authorization"> | DurableMutationPlan,
): MutationAuthorityRequest<typeof DURABLE_MUTATION_PLAN_DOMAIN> {
  const { authorization: _authorization, ...canonicalPayload } = plan as DurableMutationPlan;
  return {
    schemaVersion: MUTATION_AUTHORIZATION_SCHEMA_VERSION,
    domain: DURABLE_MUTATION_PLAN_DOMAIN,
    normalizedStoreRoot: resolve(env.cwd(), storeRoot),
    operation: plan.operation,
    baseRevision: plan.baseRevision,
    canonicalPayload: canonicalJson(canonicalPayload),
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
