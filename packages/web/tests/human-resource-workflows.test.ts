import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealEnv, type MutationPlan } from "@cellarer/core";
import { describe, expect, it } from "vitest";
import { initStore, writeRuleArtifact } from "../../core/src/store/store.js";
import { profileSelectionKey } from "../client/profiles-page.js";
import { buildSyncSelection } from "../client/sync-selection.js";
import { createApp } from "../src/app.js";
import { deterministicMutationAuthority } from "./helpers/mutation-authority.js";

describe("human resource workflows", () => {
  it("compares Profile selections independently of Core canonical ordering", () => {
    const desired = {
      agentIds: ["codex", "claude-code"],
      scope: "project" as const,
      resourceIds: ["mcp/b", "mcp/a"],
      collectionIds: [],
      capabilities: ["mcp" as const],
      method: "copy" as const,
      mergePolicy: "merge" as const,
    };
    expect(profileSelectionKey(desired)).toBe(
      profileSelectionKey({
        ...desired,
        agentIds: [...desired.agentIds].reverse(),
        resourceIds: [...desired.resourceIds].reverse(),
      }),
    );
    expect(profileSelectionKey(desired)).not.toBe(
      profileSelectionKey({ ...desired, resourceIds: ["mcp/a"] }),
    );
  });
  it("explicit IDs override Collection/default selection and remain in preview identity", () => {
    const base = {
      agents: "codex",
      destination: "project" as const,
      dir: "/tmp/project",
      kinds: ["rules" as const],
      collections: ["work"],
    };
    const selected = buildSyncSelection({ ...base, resourceIds: ["rules/a"] });
    expect(selected.request.resources).toEqual({ ids: ["rules/a"], kinds: ["rules"] });
    expect(selected.collectionSummary).toContain("Exact resources: rules/a");
    expect(selected.key).not.toBe(buildSyncSelection({ ...base, resourceIds: ["rules/b"] }).key);
    expect(buildSyncSelection({ ...base, resourceIds: [] }).request.resources?.ids).toEqual([]);
  });

  it("forwards exact IDs through authenticated HTTP to Core and rejects empty IDs", async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cellarer-human-")));
    const storeRoot = join(root, "store");
    const workspace = join(root, "workspace");
    const env = {
      ...createRealEnv(),
      homedir: () => join(root, "home"),
      cwd: () => workspace,
      mutationAuthority: deterministicMutationAuthority(),
    };
    try {
      await fs.mkdir(workspace, { recursive: true });
      await initStore(env, storeRoot);
      await writeRuleArtifact(env, storeRoot, "a", "# A\n");
      await writeRuleArtifact(env, storeRoot, "b", "# B\n");
      const app = createApp({ env, storeRoot, auth: { mode: "trusted-embedded" } });
      const input = {
        agents: ["codex"],
        destination: "project",
        dir: workspace,
        resources: { kinds: ["rules"], ids: ["rules/a"] },
      };
      const post = (path: string, body: unknown) =>
        app.request(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const response = await post("/api/v1/sync/plan", input);
      expect(response.status, await response.clone().text()).toBe(200);
      const { data } = (await response.json()) as {
        data: {
          mutationPlan: MutationPlan;
          plan: { actions: { artifact: string; artifactIds?: string[] }[] };
        };
      };
      expect(data.plan.actions.flatMap((action) => action.artifactIds ?? [])).toEqual(["rules/a"]);
      expect((await post("/api/v1/sync/plan", { ...input, resources: { ids: [] } })).status).toBe(
        400,
      );
      const applied = await post("/api/v1/sync/apply", { mutationPlan: data.mutationPlan });
      expect(applied.status).toBe(200);
      const target = await fs.readFile(join(workspace, "AGENTS.md"), "utf8");
      expect(target).toContain("# A");
      expect(target).not.toContain("# B");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("review eligibility", () => {
  it("never enables apply for dependency or drift blocked previews", async () => {
    const { previewAuthority } = await import("../client/workflow-dialog.js");
    const plan = { authorization: {} } as MutationPlan;
    expect(previewAuthority({ plan })).toBe(plan);
    expect(previewAuthority({ plan, blocked: ["PROFILE_DEPENDENCY"] })).toBeNull();
    expect(
      previewAuthority({ mutationPlan: plan, conflicts: [{ code: "UNINSTALL_TARGET_DRIFTED" }] }),
    ).toBeNull();
    expect(
      previewAuthority({
        mutationPlan: plan,
        targets: [{ key: "one", target: "/isolated/file", blocked: true }],
      }),
    ).toBeNull();
  });
});
