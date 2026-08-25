import type {
  AppliedInventorySecretAdoption,
  PlannedInventorySecretAdoption,
} from "@cellarer/core";
import { describe, expect, it, vi } from "vitest";
import { createCliCommandCatalog } from "../src/commands/command-catalog.js";

describe("Inventory secret-adoption commands", () => {
  it("keeps planning provider-free and requires confirmation before apply", async () => {
    const planned = { mutationPlan: { planId: "adoption-plan" } } as PlannedInventorySecretAdoption;
    const applied = {
      status: "applied",
      operation: { ok: true },
    } as AppliedInventorySecretAdoption;
    const service = {
      plan: vi.fn(async () => planned),
      apply: vi.fn(async () => applied),
    };
    const catalog = createCliCommandCatalog({ inventorySecretAdoptionService: service });
    const plan = catalog.requireContract("inventory.adopt.plan");
    const apply = catalog.requireContract("inventory.adopt.apply");
    const execution = {
      invocation: { output: "json", nonInteractive: true },
      event: vi.fn(),
    } as never;
    const selector = { kind: "environment", server: "demo", name: "API_TOKEN" } as const;

    const outcome = await plan.execute(
      { candidateId: "candidate", selector, provider: "vault" },
      execution,
    );
    expect(outcome).toMatchObject({ ok: true, data: planned });
    expect(service.plan).toHaveBeenCalledOnce();
    expect(service.apply).not.toHaveBeenCalled();

    await expect(
      apply.execute({ mutationPlan: planned.mutationPlan, confirmed: false }, execution),
    ).rejects.toMatchObject({ cliError: { code: "INPUT_REQUIRED" } });
    expect(service.apply).not.toHaveBeenCalled();

    const appliedOutcome = await apply.execute(
      { mutationPlan: planned.mutationPlan, confirmed: true },
      execution,
    );
    expect(appliedOutcome).toMatchObject({ ok: true, data: applied });
    expect(service.apply).toHaveBeenCalledOnce();
    expect(JSON.stringify(appliedOutcome)).not.toContain("cli-known-value-canary");
  });
});
