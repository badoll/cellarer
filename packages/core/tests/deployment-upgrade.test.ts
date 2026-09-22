import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDeploymentUpgradePlan, planDeploymentUpgrade } from "../src/deployments/upgrade.js";
import type { Env } from "../src/env.js";
import { diagnoseMutationRecovery } from "../src/protocol/recovery.js";
import { sha256 } from "../src/store/checksum.js";
import { loadLedger } from "../src/store/ledger.js";
import { initStore } from "../src/store/store.js";
import { ensureBaseDirs, FIXED_NOW, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("explicit deployment upgrade", () => {
  let t: TmpEnv;
  let storeRoot: string;
  let statePath: string;
  let target: string;
  let oldData: string;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    statePath = join(storeRoot, "state.json");
    target = t.path("home", "AGENTS.md");
    await initStore(t.env, storeRoot);
    await t.env.fs.writeFile(target, "managed\n");
    oldData = JSON.stringify({
      version: 2,
      owners: [
        {
          agent: "codex",
          scope: "global",
          capability: "rules",
          target,
          artifactIds: ["rules/demo"],
          receipt: {
            method: "write",
            fingerprint: sha256("managed\n"),
            backup: null,
            generated: true,
            appliedAt: FIXED_NOW.toISOString(),
          },
        },
      ],
    });
    await t.env.fs.writeFile(statePath, oldData);
  });
  afterEach(() => t.cleanup());

  it("reads and previews without upgrading, then publishes only state with preserved receipts", async () => {
    expect((await loadLedger(t.env, storeRoot)).version).toBe(2);
    const planned = await planDeploymentUpgrade(t.env, { storeRoot });
    expect(await t.env.fs.readFile(statePath)).toBe(oldData);
    expect(planned.plan.actions.map((action) => action.target)).toEqual([statePath]);
    expect(planned.value.deployments[0]?.receipt).toEqual(JSON.parse(oldData).owners[0].receipt);
    expect(planned.value.deployments[0]?.itemAttribution).toBe("unknown");
    const publish = vi.fn(t.env.fs.publishFileAtomically);
    const env = { ...t.env, fs: { ...t.env.fs, publishFileAtomically: publish } };
    const applied = await applyDeploymentUpgradePlan(env, planned.plan, { storeRoot });
    expect(applied.operation).toMatchObject({ ok: true });
    expect(JSON.parse(await t.env.fs.readFile(statePath))).toEqual(planned.value);
    expect((await loadLedger(t.env, storeRoot)).version).toBe(3);
    expect(await t.env.fs.readFile(target)).toBe("managed\n");
    expect(publish.mock.calls.some(([path]) => path === target)).toBe(false);
  });

  it("rejects duplicate physical ownership across Agents and unknown versions", async () => {
    const old = JSON.parse(oldData);
    old.owners.push({ ...old.owners[0], agent: "other" });
    for (const state of [old, { version: 99, owners: [] }]) {
      const data = JSON.stringify(state);
      await t.env.fs.writeFile(statePath, data);
      await expect(planDeploymentUpgrade(t.env, { storeRoot })).rejects.toThrow();
      expect(await t.env.fs.readFile(statePath)).toBe(data);
    }
  });

  it("rejects tampered plans and target evidence changed after preview", async () => {
    const planned = await planDeploymentUpgrade(t.env, { storeRoot });
    const tampered = {
      ...planned.plan,
      normalizedInputs: { ...planned.plan.normalizedInputs, targetEvidence: [] },
    };
    expect((await applyDeploymentUpgradePlan(t.env, tampered, { storeRoot })).operation.ok).toBe(
      false,
    );
    await t.env.fs.writeFile(target, "edited\n");
    expect(
      (await applyDeploymentUpgradePlan(t.env, planned.plan, { storeRoot })).operation.ok,
    ).toBe(false);
    expect(await t.env.fs.readFile(statePath)).toBe(oldData);
    expect(await t.env.fs.readFile(target)).toBe("edited\n");
  });

  it.each([
    "before",
    "after",
  ])("preserves one complete authoritative state on interruption %s publication", async (when) => {
    const planned = await planDeploymentUpgrade(t.env, { storeRoot });
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, options) => {
          if (path === statePath && when === "before") throw new Error("simulated crash");
          await t.env.fs.publishFileAtomically(path, data, options);
          if (path === statePath && when === "after") throw new Error("simulated crash");
        },
      },
    };
    await expect(applyDeploymentUpgradePlan(env, planned.plan, { storeRoot })).rejects.toThrow(
      /simulated crash/,
    );
    const state = JSON.parse(await t.env.fs.readFile(statePath));
    expect(state.version).toBe(when === "before" ? 2 : 3);
    expect(state.version === 3 ? state.owners : state.deployments).toBeUndefined();
    expect(await t.env.fs.readFile(target)).toBe("managed\n");
    const recovery = await diagnoseMutationRecovery(
      { ...t.env, probeProcessLiveness: async () => "dead" },
      storeRoot,
    );
    expect(recovery.status).not.toBe("clean");
    await expect(planDeploymentUpgrade(t.env, { storeRoot })).rejects.toThrow(/clean recovery/);
  });
});
