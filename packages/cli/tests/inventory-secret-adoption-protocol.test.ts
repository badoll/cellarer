import { describe, expect, it } from "vitest";
import { createCliCommandCatalog } from "../src/commands/command-catalog.js";

describe("Inventory secret-adoption CLI protocol", () => {
  it("publishes exact plan/apply contracts without plaintext-shaped fields", () => {
    const catalog = createCliCommandCatalog();
    const plan = catalog.requireContract("inventory.adopt.plan");
    const apply = catalog.requireContract("inventory.adopt.apply");

    expect(plan).toMatchObject({
      command: "inventory.adopt.plan",
      mutability: "write",
      requiredFeatures: expect.arrayContaining([
        "inventory-secret-adoption",
        "reference-only-secrets",
      ]),
    });
    expect(apply).toMatchObject({
      command: "inventory.adopt.apply",
      mutability: "write",
      requiredFeatures: expect.arrayContaining(["human-confirmation", "plan-apply"]),
    });
    expect(plan.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        input: {
          additionalProperties: false,
          required: ["candidateId", "selector", "provider"],
        },
      },
    });
    expect(apply.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        input: {
          additionalProperties: false,
          required: ["mutationPlan", "confirmed"],
          properties: { confirmed: { const: true } },
        },
      },
    });

    const protocolBytes = JSON.stringify({
      planInput: plan.inputSchema,
      planOutput: plan.outputSchema,
      applyInput: apply.inputSchema,
      applyOutput: apply.outputSchema,
    });
    expect(protocolBytes).not.toMatch(/"(?:secretValue|plaintext|value)"\s*:/u);
  });
});
