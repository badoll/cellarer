import { isAbsolute, join, normalize } from "node:path";
import type { AgentAdapter, AgentPaths, DiscoveryDescriptor } from "../adapters/types.js";
import type { Env } from "../env.js";
import { isWithinRoot } from "../fs/safety.js";
import type { Capability, Scope } from "../model/index.js";
import type { CellarerConfig } from "../store/config.js";

const CAPABILITIES: readonly Capability[] = ["rules", "mcp", "skills"];

export type InventoryEnumerationFindingCode =
  | "ADAPTER_DETECTION_FAILED"
  | "ADAPTER_PATHS_FAILED"
  | "SOURCE_OUTSIDE_BOUNDARY";

export interface InventoryEnumerationFinding {
  readonly code: InventoryEnumerationFindingCode;
  readonly adapterId: string;
  readonly scope: Scope;
  readonly kind?: Capability;
}

export interface InventorySource {
  readonly id: string;
  readonly adapterId: string;
  readonly displayName: string;
  readonly scope: Scope;
  readonly kind: Capability;
  readonly path: string;
  readonly boundaryRoot?: string;
  readonly enabled: boolean;
  readonly detected: boolean;
  readonly discovery?: DiscoveryDescriptor;
  readonly discoveryMode?: "declared" | "placement-only";
}

export interface InventoryEnumeration {
  readonly projectRoot?: string;
  readonly sources: readonly InventorySource[];
  readonly findings: readonly InventoryEnumerationFinding[];
}

export interface InventoryEnumerationOptions {
  readonly adapters: readonly AgentAdapter[];
  readonly configuration: CellarerConfig;
  readonly projectRoot?: string;
  readonly agentId?: string;
}

export class InventoryAdapterNotFoundError extends Error {
  readonly code = "INVENTORY_ADAPTER_NOT_FOUND";
  readonly adapterId: string;

  constructor(adapterId: string) {
    super(`Inventory adapter is not registered: ${adapterId}`);
    this.name = "InventoryAdapterNotFoundError";
    this.adapterId = adapterId;
  }
}

export async function enumerateInventorySources(
  env: Env,
  options: InventoryEnumerationOptions,
): Promise<InventoryEnumeration> {
  const projectRoot = options.projectRoot
    ? await env.fs.realpath(
        normalize(
          isAbsolute(options.projectRoot)
            ? options.projectRoot
            : join(env.cwd(), options.projectRoot),
        ),
      )
    : undefined;
  const registered = [...options.adapters].sort((left, right) => left.id.localeCompare(right.id));
  const adapters = options.agentId
    ? registered.filter((adapter) => adapter.id === options.agentId)
    : registered;
  if (options.agentId && adapters.length === 0) {
    throw new InventoryAdapterNotFoundError(options.agentId);
  }

  const sources: InventorySource[] = [];
  const findings: InventoryEnumerationFinding[] = [];
  const scopes: readonly { readonly scope: Scope; readonly root: string }[] = projectRoot
    ? [
        { scope: "global", root: env.homedir() },
        { scope: "project", root: projectRoot },
      ]
    : [{ scope: "global", root: env.homedir() }];

  for (const adapter of adapters) {
    const enabled = options.configuration.adapterOverrides[adapter.id]?.enabled !== false;
    for (const { scope, root } of scopes) {
      const detected = await detectAdapter(env, adapter, scope, projectRoot, findings);
      let declarations: readonly DiscoveryDescriptor[];
      try {
        if (adapter.discovery) {
          declarations = adapter.discovery(
            env,
            scope,
            scope === "project" ? projectRoot : undefined,
          );
        } else {
          const paths = adapterPaths(env, adapter, scope, projectRoot, findings);
          if (!paths) continue;
          declarations = CAPABILITIES.flatMap((kind) => {
            const path = pathFor(paths, kind);
            return path && adapter.capabilities[kind].includes(scope)
              ? [
                  {
                    sourceId: `${scope}-${kind}`,
                    scope,
                    kind,
                    path,
                    locator: kind === "skills" ? ("tree" as const) : ("file" as const),
                    maxDepth: 16,
                    maxEntries: 10000,
                    maxBytes: 16777216,
                    precedence: {
                      policy: "unknown" as const,
                      evidence: "Placement-only fallback; native discovery is unknown.",
                    },
                  },
                ]
              : [];
          });
        }
      } catch {
        findings.push({ code: "ADAPTER_PATHS_FAILED", adapterId: adapter.id, scope });
        continue;
      }
      for (const declaration of declarations) {
        const { kind, path } = declaration;
        if (declaration.scope !== scope) continue;
        const normalizedPath = normalize(path);
        if (normalizedPath === normalize(root) || !isWithinRoot(root, normalizedPath)) {
          findings.push({ code: "SOURCE_OUTSIDE_BOUNDARY", adapterId: adapter.id, scope, kind });
          continue;
        }
        sources.push(
          Object.freeze({
            id: `${adapter.id}:${scope}:${kind}:${declaration.sourceId}:${normalizedPath}`,
            discovery: declaration,
            discoveryMode: adapter.discovery ? "declared" : "placement-only",
            adapterId: adapter.id,
            displayName: adapter.displayName,
            scope,
            kind,
            path: normalizedPath,
            boundaryRoot: root,
            enabled,
            detected,
          }),
        );
      }
    }
  }

  sources.sort((left, right) => left.id.localeCompare(right.id));
  return Object.freeze({
    ...(projectRoot ? { projectRoot } : {}),
    sources: Object.freeze(sources),
    findings: Object.freeze(findings),
  });
}

async function detectAdapter(
  env: Env,
  adapter: AgentAdapter,
  scope: Scope,
  projectRoot: string | undefined,
  findings: InventoryEnumerationFinding[],
): Promise<boolean> {
  try {
    return (await adapter.detect(env, scope, scope === "project" ? projectRoot : undefined))
      .installed;
  } catch {
    findings.push({ code: "ADAPTER_DETECTION_FAILED", adapterId: adapter.id, scope });
    return false;
  }
}

function adapterPaths(
  env: Env,
  adapter: AgentAdapter,
  scope: Scope,
  projectRoot: string | undefined,
  findings: InventoryEnumerationFinding[],
): AgentPaths | null {
  try {
    return adapter.paths(env, scope, scope === "project" ? projectRoot : undefined);
  } catch {
    findings.push({ code: "ADAPTER_PATHS_FAILED", adapterId: adapter.id, scope });
    return null;
  }
}

function pathFor(paths: AgentPaths, capability: Capability): string | undefined {
  if (capability === "rules") return paths.rules;
  if (capability === "mcp") return paths.mcp;
  return paths.skillsDir;
}

export type InventorySourceInspection<T> =
  | { readonly source: InventorySource; readonly ok: true; readonly value: T }
  | { readonly source: InventorySource; readonly ok: false };

export async function inspectInventorySourcesBounded<T>(
  sources: readonly InventorySource[],
  concurrency: number,
  inspect: (source: InventorySource) => Promise<T>,
  onCompleted?: (result: InventorySourceInspection<T>) => void,
  signal?: AbortSignal,
): Promise<readonly InventorySourceInspection<T>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError("Inventory inspection concurrency must be a positive integer");
  }
  const results = new Array<InventorySourceInspection<T>>(sources.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < sources.length) {
      if (signal?.aborted) return;
      const index = nextIndex;
      nextIndex += 1;
      const source = sources[index];
      if (!source) continue;
      try {
        results[index] = Object.freeze({ source, ok: true, value: await inspect(source) });
      } catch {
        results[index] = Object.freeze({ source, ok: false });
      }
      if (signal?.aborted) return;
      const result = results[index];
      if (result) onCompleted?.(result);
    }
  }

  const workerCount = Math.min(concurrency, sources.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (signal?.aborted) throw new Error("Inventory refresh cancelled");
  return Object.freeze(results);
}
