import {
  CLIENT_API_CONTRACT_ID,
  CLIENT_API_VERSION,
  type InventoryRefreshResult,
  type InventorySecretAdoptionOrphanEvidence,
  type InventorySecretAdoptionProvider,
  type InventorySecretFieldSelector,
  type MutationPlan,
  type PostCommitInventoryRefresh,
} from "@cellarer/core/client-api";
import { readApiJson } from "./api-state.js";

const SESSION_PATH = "/api/v1/auth/session";
const HEALTH_PATH = "/api/v1/health";
const VERSION_PATH = "/api/v1/version";
const CAPABILITIES_PATH = "/api/v1/capabilities";

let sessionBootstrap: Promise<void> | undefined;
let discoveryNegotiation: Promise<ClientApiDiscovery> | undefined;

export interface ClientApiDiscovery {
  readonly apiVersion: typeof CLIENT_API_VERSION;
  readonly contractId: typeof CLIENT_API_CONTRACT_ID;
  readonly operations: readonly string[];
}

export type VersionedClientApiPath = `/api/v1/${string}`;
export type VersionedClientApiInput = VersionedClientApiPath | URL | Request;

// The bundled SPA has exactly one transport boundary. Credentials remain in an HttpOnly,
// same-origin cookie; no bearer material is accepted from location/search/argv-derived URLs.
export async function apiFetch(
  input: VersionedClientApiInput,
  init: RequestInit = {},
): Promise<Response> {
  const path = localApiPath(input);
  if (!path.startsWith("/api/v1/")) {
    throw new Error("Bundled client requests must use a versioned /api/v1 path");
  }
  if (path !== HEALTH_PATH && path !== SESSION_PATH) await ensureBrowserSession();
  if (requiresNegotiation(path)) await negotiateClientApi();

  const requestInit: RequestInit = { ...init, credentials: "same-origin" };
  let response = await fetch(input, requestInit);
  if (response.status === 401 && path !== SESSION_PATH) {
    sessionBootstrap = undefined;
    discoveryNegotiation = undefined;
    await ensureBrowserSession();
    if (requiresNegotiation(path)) await negotiateClientApi();
    response = await fetch(input, requestInit);
  }
  return response;
}

export async function negotiateClientApi(): Promise<ClientApiDiscovery> {
  await ensureBrowserSession();
  discoveryNegotiation ??= Promise.all([
    fetch(VERSION_PATH, { credentials: "same-origin" }).then((response) =>
      readApiJson<{ readonly apiVersion: string; readonly contractId: string }>(response),
    ),
    fetch(CAPABILITIES_PATH, { credentials: "same-origin" }).then((response) =>
      readApiJson<{
        readonly apiVersion: string;
        readonly contractId: string;
        readonly operations: readonly string[];
      }>(response),
    ),
  ])
    .then(([version, capabilities]) => {
      if (
        version.apiVersion !== CLIENT_API_VERSION ||
        version.contractId !== CLIENT_API_CONTRACT_ID ||
        capabilities.apiVersion !== CLIENT_API_VERSION ||
        capabilities.contractId !== CLIENT_API_CONTRACT_ID
      ) {
        throw new Error("incompatible local client API version or contract");
      }
      return {
        apiVersion: CLIENT_API_VERSION,
        contractId: CLIENT_API_CONTRACT_ID,
        operations: capabilities.operations,
      };
    })
    .catch((error: unknown) => {
      discoveryNegotiation = undefined;
      throw error;
    });
  return discoveryNegotiation;
}

export interface AppliedControlPlaneMutationResult {
  readonly postCommitInventoryRefresh?: PostCommitInventoryRefresh;
}

export async function applyPlannedControlPlaneMutation<T = AppliedControlPlaneMutationResult>(
  planPath: "/api/v1/agents/plan" | "/api/v1/collections/plan" | "/api/v1/settings/plan",
  input: unknown,
): Promise<T> {
  const planned = await readApiJson<{ plan: unknown }>(
    await apiFetch(planPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return readApiJson<T>(
    await apiFetch("/api/v1/mutations/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mutationPlan: planned.plan }),
    }),
  );
}

export async function fetchInventory(
  options: { readonly agentId?: string; readonly dir?: string } = {},
): Promise<InventoryRefreshResult> {
  const path = options.agentId
    ? `/api/v1/inventory/${encodeURIComponent(options.agentId)}`
    : "/api/v1/inventory";
  const query = new URLSearchParams();
  if (options.dir) query.set("dir", options.dir);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const requestPath = `${path}${suffix}` as VersionedClientApiPath;
  return readApiJson<InventoryRefreshResult>(await apiFetch(requestPath));
}

export interface InventoryStoreImportPlanInput {
  readonly candidateIds: readonly string[];
  readonly agentId?: string;
  readonly dir?: string;
  readonly intoCollection?: string;
}

export interface InventoryStoreImportPlanResult {
  readonly inventory: InventoryRefreshResult;
  readonly candidateIds: readonly string[];
  readonly mutationPlan: MutationPlan;
}

export interface InventoryStoreImportApplyResult {
  readonly mutationPlan: MutationPlan;
  readonly candidateIds: readonly string[];
  readonly resourceIds: readonly string[];
  readonly operation: { readonly ok: boolean };
  readonly warnings: readonly string[];
}

export async function planInventoryStoreImport(
  input: InventoryStoreImportPlanInput,
): Promise<InventoryStoreImportPlanResult> {
  return readApiJson<InventoryStoreImportPlanResult>(
    await apiFetch("/api/v1/inventory/import/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function applyInventoryStoreImport(
  mutationPlan: MutationPlan,
): Promise<InventoryStoreImportApplyResult> {
  return readApiJson<InventoryStoreImportApplyResult>(
    await apiFetch("/api/v1/inventory/import/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mutationPlan }),
    }),
  );
}

export interface InventorySecretAdoptionPlanInput {
  readonly candidateId: string;
  readonly selector: InventorySecretFieldSelector;
  readonly provider: "vault" | "keychain";
  readonly agentId?: string;
  readonly dir?: string;
}

export interface InventorySecretAdoptionPlanResult {
  readonly inventory: InventoryRefreshResult;
  readonly candidateId: string;
  readonly selector: InventorySecretFieldSelector;
  readonly provider: InventorySecretAdoptionProvider;
  readonly targetName: string;
  readonly mutationPlan: MutationPlan;
}

export interface InventorySecretAdoptionApplyResult {
  readonly mutationPlan: MutationPlan;
  readonly candidateId: string | null;
  readonly provider: InventorySecretAdoptionProvider | null;
  readonly targetName: string | null;
  readonly status: "applied" | "rejected" | "provider-precondition-conflict" | "orphaned-reference";
  readonly operation: { readonly ok: boolean };
  readonly orphan?: InventorySecretAdoptionOrphanEvidence;
}

export async function planInventorySecretAdoption(
  input: InventorySecretAdoptionPlanInput,
): Promise<InventorySecretAdoptionPlanResult> {
  return readApiJson<InventorySecretAdoptionPlanResult>(
    await apiFetch("/api/v1/inventory/adoption/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function applyInventorySecretAdoption(
  mutationPlan: MutationPlan,
): Promise<InventorySecretAdoptionApplyResult> {
  return readApiJson<InventorySecretAdoptionApplyResult>(
    await apiFetch("/api/v1/inventory/adoption/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mutationPlan }),
    }),
  );
}

async function ensureBrowserSession(): Promise<void> {
  sessionBootstrap ??= fetch(SESSION_PATH, {
    method: "POST",
    credentials: "same-origin",
  }).then((response) => {
    if (!response.ok) throw new Error(`API session bootstrap failed (${response.status})`);
  });
  try {
    await sessionBootstrap;
  } catch (error) {
    sessionBootstrap = undefined;
    throw error;
  }
}

function localApiPath(input: VersionedClientApiInput): string {
  if (typeof input === "string") return input.split("?", 1)[0] ?? input;
  if (input instanceof URL) return input.pathname;
  return new URL(input.url).pathname;
}

function requiresNegotiation(path: string): boolean {
  return (
    path !== HEALTH_PATH &&
    path !== SESSION_PATH &&
    path !== VERSION_PATH &&
    path !== CAPABILITIES_PATH
  );
}
