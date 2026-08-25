import { describe, expect, it } from "vitest";
import { createCliCommandCatalog } from "../src/commands/command-catalog.js";
import { buildProgram } from "../src/program.js";

describe("Inventory CLI protocol", () => {
  it("publishes one prompt-free read contract with closed schemas", () => {
    const catalog = createCliCommandCatalog();
    const contract = catalog.requireContract("inventory.refresh");

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

    const inventory = buildProgram().commands.find((command) => command.name() === "inventory");
    expect(inventory?.commands.map((command) => command.name())).toEqual(["refresh"]);
    expect(inventory?.commands[0]?.options.map((option) => option.long)).toEqual([
      "--agent",
      "--dir",
    ]);
  });
});
