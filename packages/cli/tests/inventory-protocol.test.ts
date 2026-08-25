import { describe, expect, it } from "vitest";
import { createCliCommandCatalog } from "../src/commands/command-catalog.js";
import { buildProgram } from "../src/program.js";

describe("Inventory CLI protocol", () => {
  it("publishes prompt-free refresh and exact plan/apply contracts with closed schemas", () => {
    const catalog = createCliCommandCatalog();
    const contract = catalog.requireContract("inventory.refresh");
    const plan = catalog.requireContract("inventory.import.plan");
    const apply = catalog.requireContract("inventory.import.apply");

    expect(contract).toMatchObject({
      command: "inventory.refresh",
      mutability: "read",
      streaming: false,
      requiredFeatures: ["unified-resource-inventory"],
    });
    expect(contract.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            agentId: { type: "string" },
            dir: { type: "string" },
          },
        },
      },
    });
    expect(contract.outputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        data: {
          type: "object",
          additionalProperties: false,
          required: ["generatedAt", "candidates", "findings", "counts", "completeness"],
        },
      },
    });
    expect(plan).toMatchObject({
      command: "inventory.import.plan",
      mutability: "write",
      streaming: false,
      requiredFeatures: expect.arrayContaining(["inventory-store-import", "mutation-authority"]),
    });
    expect(plan.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        input: {
          additionalProperties: false,
          required: ["candidateIds"],
        },
      },
    });
    expect(apply).toMatchObject({
      command: "inventory.import.apply",
      mutability: "write",
      requiredFeatures: expect.arrayContaining(["inventory-store-import", "plan-apply"]),
    });
    expect(apply.outputSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        data: {
          additionalProperties: false,
          required: ["mutationPlan", "candidateIds", "resourceIds", "operation", "warnings"],
        },
      },
    });

    const inventory = buildProgram().commands.find((command) => command.name() === "inventory");
    expect(inventory?.commands.map((command) => command.name())).toEqual(["refresh", "import"]);
    expect(inventory?.commands[0]?.options.map((option) => option.long)).toEqual([
      "--agent",
      "--dir",
    ]);
    expect(inventory?.commands[1]?.commands.map((command) => command.name())).toEqual([
      "plan",
      "apply",
    ]);
  });
});
