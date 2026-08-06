import { isAbsolute, join, normalize } from "node:path";
import type { RuleFragment } from "../adapters/types.js";
import type { Env } from "../env.js";
import { type McpServer, serverFromRaw } from "../mcp/model.js";
import type { Artifact, Capability } from "../model/index.js";
import {
  captureAnchoredSafeRecursiveSource,
  type SafeRecursiveSnapshot,
  sliceSafeRecursiveSnapshot,
  UnsafeRecursiveSourceError,
} from "../secrets/safe-tree.js";

export type CapabilityRootExpected =
  | { readonly state: "absent" }
  | {
      readonly state: "present";
      readonly fingerprint: string;
      readonly identity: string;
      readonly mode: number;
    };

export interface CapabilityRootProvenanceDescriptor {
  readonly capability: Capability;
  readonly path: string;
  readonly expected: CapabilityRootExpected;
}

export interface CapabilityRootCapture {
  readonly descriptors: readonly CapabilityRootProvenanceDescriptor[];
  readonly snapshots: ReadonlyMap<Capability, SafeRecursiveSnapshot | null>;
}

export async function captureCapabilityRootSnapshots(
  env: Env,
  storeRoot: string,
  capabilities: readonly Capability[],
): Promise<CapabilityRootCapture> {
  const normalizedStoreRoot = normalize(
    isAbsolute(storeRoot) ? storeRoot : join(env.cwd(), storeRoot),
  );
  const requested = [...new Set(capabilities)].sort((left, right) => left.localeCompare(right));
  const snapshots = new Map<Capability, SafeRecursiveSnapshot | null>();
  const descriptors: CapabilityRootProvenanceDescriptor[] = [];
  for (const capability of requested) {
    const path = join(normalizedStoreRoot, "store", capability);
    const snapshot = await captureAnchoredSafeRecursiveSource(env, normalizedStoreRoot, path);
    if (snapshot && snapshot.kind !== "directory") {
      throw new UnsafeRecursiveSourceError(path, "non-regular");
    }
    snapshots.set(capability, snapshot);
    const root = snapshot?.tree.nodes.find((node) => node.relativePath === "");
    descriptors.push({
      capability,
      path,
      expected:
        snapshot && root
          ? {
              state: "present",
              fingerprint: snapshot.fingerprint,
              identity: snapshot.identity,
              mode: root.mode,
            }
          : { state: "absent" },
    });
  }
  return Object.freeze({ descriptors: Object.freeze(descriptors), snapshots });
}

export function artifactsFromCapabilitySnapshot(
  storeRoot: string,
  capability: Capability,
  snapshot: SafeRecursiveSnapshot | null,
): Artifact[] {
  if (!snapshot) return [];
  const entries = snapshot.tree.nodes.filter((node) => !node.relativePath.includes("/"));
  const names = entries.flatMap((node) => {
    if (capability === "rules" && node.kind === "file" && node.relativePath.endsWith(".md")) {
      return [node.relativePath.slice(0, -3)];
    }
    if (capability === "mcp" && node.kind === "file" && node.relativePath.endsWith(".json")) {
      return [node.relativePath.slice(0, -5)];
    }
    if (capability === "skills" && node.kind === "directory" && node.relativePath.length > 0) {
      return [node.relativePath];
    }
    return [];
  });
  return names
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({
      id: `${capability}/${name}`,
      kind: capability,
      name,
      sourcePath: join(
        storeRoot,
        "store",
        capability,
        capability === "rules" ? `${name}.md` : capability === "mcp" ? `${name}.json` : name,
      ),
      collections: [],
    }));
}

export function artifactSnapshotsFromCapabilityRoots(
  artifacts: readonly Artifact[],
  roots: ReadonlyMap<Capability, SafeRecursiveSnapshot | null>,
): Map<string, SafeRecursiveSnapshot> {
  const snapshots = new Map<string, SafeRecursiveSnapshot>();
  for (const artifact of artifacts) {
    const root = roots.get(artifact.kind);
    if (!root) throw new UnsafeRecursiveSourceError(artifact.sourcePath, "stale");
    const relativePath =
      artifact.kind === "rules"
        ? `${artifact.name}.md`
        : artifact.kind === "mcp"
          ? `${artifact.name}.json`
          : artifact.name;
    snapshots.set(artifact.sourcePath, sliceSafeRecursiveSnapshot(root, relativePath));
  }
  return snapshots;
}

export function ruleFragmentFromSnapshot(
  artifact: Artifact,
  snapshot: SafeRecursiveSnapshot,
): RuleFragment {
  if (snapshot.kind !== "file" || snapshot.files.length !== 1) {
    throw new UnsafeRecursiveSourceError(artifact.sourcePath, "non-regular");
  }
  return { relPath: `rules/${artifact.name}.md`, content: snapshot.files[0]?.content ?? "" };
}

export function mcpServerFromSnapshot(
  artifact: Artifact,
  snapshot: SafeRecursiveSnapshot,
): { name: string; server: McpServer } {
  if (snapshot.kind !== "file" || snapshot.files.length !== 1) {
    throw new UnsafeRecursiveSourceError(artifact.sourcePath, "non-regular");
  }
  try {
    return {
      name: artifact.name,
      server: serverFromRaw(JSON.parse(snapshot.files[0]?.content ?? "")),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid mcp artifact ${artifact.sourcePath}: ${message}`);
  }
}
