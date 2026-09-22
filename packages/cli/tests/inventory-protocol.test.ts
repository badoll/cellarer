import { describe, expect, it } from "vitest";
import { createCliCommandCatalog } from "../src/commands/command-catalog.js";
import { buildProgram } from "../src/program.js";
import { commandSchemaFragments } from "../src/protocol/command-schema-fragments.js";
import { validateJsonSchema } from "../src/protocol/input.js";

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
          properties: {
            coverage: { type: "array" },
            effectiveResources: { type: "array" },
            resolutionContext: { enum: ["user", "project"] },
          },
        },
      },
    });
    const dataSchema = contract.outputSchema.properties?.data;
    if (!dataSchema) throw new Error("missing Inventory data schema");
    expect(
      validateJsonSchema(
        {
          generatedAt: "2026-09-22T00:00:00Z",
          candidates: [],
          findings: [],
          counts: {
            total: 0,
            ready: 0,
            needsAttention: 0,
            inStore: 0,
            observedSources: 1,
            failedSources: 0,
          },
          completeness: "complete",
          resolutionContext: "project",
          coverage: [
            {
              adapterId: "codex",
              sourceId: "project-skills",
              scope: "project",
              kind: "skills",
              location: "<project>/.agents/skills",
              bounds: { maxDepth: 16, maxEntries: 10000, maxBytes: 16777216 },
              dimension: "source",
              status: "observed",
              mode: "declared",
              reason: "Bounded source.",
            },
          ],
          effectiveResources: [],
        },
        dataSchema,
      ),
    ).toEqual([]);
    const discovery = (precedence: unknown) => ({
      skills: { global: "~/.write" },
      discovery: [
        {
          sourceId: "fixture",
          scope: "global",
          kind: "skills",
          path: "~/.read",
          locator: "tree",
          maxDepth: 16,
          maxEntries: 1000,
          maxBytes: 10000,
          precedence,
        },
      ],
    });
    for (const precedence of [
      { policy: "unknown", evidence: "fixture" },
      { policy: "ranked", rank: 1, evidence: "fixture" },
    ]) {
      expect(validateJsonSchema(discovery(precedence), commandSchemaFragments.adapterBody)).toEqual(
        [],
      );
    }
    for (const precedence of [
      { policy: "ranked", evidence: "fixture" },
      { policy: "unknown", evidence: "fixture", unexpected: true },
    ]) {
      expect(
        validateJsonSchema(discovery(precedence), commandSchemaFragments.adapterBody),
      ).not.toEqual([]);
    }
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
    expect(inventory?.commands.map((command) => command.name())).toEqual([
      "refresh",
      "import",
      "adopt",
    ]);
    expect(inventory?.commands[0]?.options.map((option) => option.long)).toEqual([
      "--agent",
      "--dir",
    ]);
    expect(inventory?.commands[1]?.commands.map((command) => command.name())).toEqual([
      "plan",
      "apply",
    ]);
    expect(inventory?.commands[2]?.commands.map((command) => command.name())).toEqual([
      "plan",
      "apply",
    ]);
  });
});
