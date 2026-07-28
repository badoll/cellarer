import { sha256 } from "../store/checksum.js";
import type { DurableMutationPlan, MutationPlan, MutationPlanInput } from "./models.js";
import { MUTATION_PLAN_SCHEMA_VERSION } from "./models.js";

const CANONICAL_ISO_UTC_TIMESTAMP =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

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
      `unsupported mutation plan schema version ${describeRuntimeValue(candidate.schemaVersion)}; supported version is ${MUTATION_PLAN_SCHEMA_VERSION}`,
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
    `unsupported mutation plan expiry policy ${describeRuntimeValue(candidate.expires.policy)}; supported policies are "none" and "expires-at"`,
  );
}

function isCanonicalIsoUtcTimestamp(value: string): boolean {
  if (!CANONICAL_ISO_UTC_TIMESTAMP.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("canonical JSON does not support non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical JSON supports only plain objects");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`canonical JSON does not support ${typeof value}`);
}

export function canonicalMutationPlan(plan: MutationPlanInput | MutationPlan): string {
  const { digest: _digest, ...payload } = plan as MutationPlan;
  return canonicalJson(payload);
}

export function mutationPlanDigest(plan: MutationPlanInput | MutationPlan): string {
  return sha256(canonicalMutationPlan(plan));
}

export function createMutationPlan(input: MutationPlanInput): MutationPlan {
  assertSupportedMutationPlanRuntime(input);
  const encoded = canonicalMutationPlan(input);
  const snapshot = JSON.parse(encoded) as MutationPlanInput;
  return deepFreeze({ ...snapshot, digest: sha256(encoded) });
}

export function verifyMutationPlanDigest(plan: MutationPlan): boolean {
  try {
    return mutationPlanDigest(plan) === plan.digest;
  } catch {
    return false;
  }
}

export function createDurableMutationPlan(plan: MutationPlan): DurableMutationPlan {
  assertSupportedMutationPlanRuntime(plan);
  if (!verifyMutationPlanDigest(plan)) {
    throw new TypeError("cannot persist a mutation plan with an invalid digest");
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
      ...(postcondition === undefined ? {} : { postcondition }),
    })),
    expires: plan.expires,
    digest: plan.digest,
  };
  const encoded = canonicalJson(input);
  return deepFreeze({
    ...(JSON.parse(encoded) as typeof input),
    durableDigest: sha256(encoded),
  });
}

export function verifyDurableMutationPlanDigest(plan: DurableMutationPlan): boolean {
  try {
    const { durableDigest: _durableDigest, ...input } = plan;
    return sha256(canonicalJson(input)) === plan.durableDigest;
  } catch {
    return false;
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function describeRuntimeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  if (value === null || ["boolean", "number", "bigint"].includes(typeof value)) {
    return String(value);
  }
  return `<${typeof value}>`;
}
