import { describe, expect, it } from "vitest";
import {
  controlPlaneCommandRegistry,
  getCommandDefinition,
} from "../src/protocol/command-registry.js";
import { validateJsonSchema } from "../src/protocol/input.js";

const EXPECTED_COMMANDS = [
  "resource.list",
  "resource.show",
  "agent.list",
  "agent.show",
  "agent.enable",
  "agent.disable",
  "agent.configure",
  "agent.reset",
  "agent.add",
  "agent.update",
  "agent.remove",
  "collection.list",
  "collection.show",
  "collection.create",
  "collection.update",
  "collection.delete",
  "collection.members.set",
  "collection.defaults.set",
  "config.show",
  "config.validate",
  "config.update",
  "config.reset",
  "diff",
  "verify",
  "summary",
  "discovery.summary",
  "operation.list",
  "operation.show",
  "operation.recover",
  "plan",
] as const;

describe("complete control-plane command contracts", () => {
  it("registers the complete planned surface with unique input and output schemas", () => {
    expect(controlPlaneCommandRegistry.map(({ command }) => command)).toEqual(EXPECTED_COMMANDS);
    const schemaIds = new Set(
      controlPlaneCommandRegistry.flatMap(({ inputSchemaId, outputSchemaId }) => [
        inputSchemaId,
        outputSchemaId,
      ]),
    );
    expect(schemaIds.size).toBe(EXPECTED_COMMANDS.length * 2);
    for (const definition of controlPlaneCommandRegistry) {
      expect(definition.outputSchema.properties?.data?.additionalProperties).toBe(false);
    }
  });

  it("records capability traits and a read-only plan for every mutation", () => {
    for (const definition of controlPlaneCommandRegistry) {
      if (definition.mutability === "read") continue;
      expect(definition.requiredFeatures, definition.command).toEqual(
        expect.arrayContaining(["mutation-authority", "plan-apply"]),
      );
      expect(
        definition.inputSchema.properties?.input?.properties,
        `${definition.command} must expose dryRun`,
      ).toHaveProperty("dryRun", { type: "boolean" });
    }
  });

  it("publishes canonical DTO roots instead of command-specific ad hoc shapes", () => {
    const outputData = (command: string) =>
      controlPlaneCommandRegistry.find((definition) => definition.command === command)?.outputSchema
        .properties?.data;

    expect(outputData("resource.list")?.properties).toHaveProperty("resources");
    expect(outputData("agent.list")?.properties).toHaveProperty("agents");
    expect(outputData("collection.list")?.properties).toHaveProperty("collections");
    expect(outputData("config.show")?.properties).toHaveProperty("config");
    expect(outputData("diff")?.properties).toHaveProperty("items");
    expect(outputData("verify")?.properties).toHaveProperty("healthy");
    expect(outputData("summary")?.properties).toHaveProperty("artifactCounts");
    expect(outputData("operation.list")?.properties).toHaveProperty("operations");
  });

  it("separates defaultable config validation input from canonical config output", () => {
    const definition = getCommandDefinition("config.validate");
    const inputConfig = definition?.inputSchema.properties?.input?.properties?.config;
    const outputConfig = definition?.outputSchema.properties?.data?.properties?.config;
    if (!inputConfig || !outputConfig) throw new Error("expected config.validate schemas");

    expect(validateJsonSchema({ version: 1 }, inputConfig)).toEqual([]);
    expect(validateJsonSchema({ defaults: { method: "copy" } }, inputConfig)).toEqual([]);
    expect(outputConfig.required).toEqual([
      "version",
      "defaults",
      "collections",
      "artifacts",
      "adapterOverrides",
      "customAdapters",
    ]);
    expect(inputConfig).not.toBe(outputConfig);
    expect(inputConfig.properties?.defaults?.properties?.collections?.items?.minLength).toBe(1);
    expect(outputConfig.properties?.defaults?.properties?.collections?.items?.minLength).toBe(1);
    expect(
      inputConfig.properties?.customAdapters?.additionalProperties &&
        typeof inputConfig.properties.customAdapters.additionalProperties === "object"
        ? inputConfig.properties.customAdapters.additionalProperties.properties?.rules?.properties
            ?.global?.minLength
        : undefined,
    ).toBe(1);
    expect(
      outputConfig.properties?.customAdapters?.additionalProperties &&
        typeof outputConfig.properties.customAdapters.additionalProperties === "object"
        ? outputConfig.properties.customAdapters.additionalProperties.properties?.rules?.properties
            ?.global?.minLength
        : undefined,
    ).toBe(1);
  });

  it("rejects empty adapter bodies and settings patches in registered input schemas", () => {
    const input = (command: string) => getCommandDefinition(command)?.inputSchema.properties?.input;
    const add = input("agent.add");
    const update = input("agent.update");
    const config = input("config.update");
    if (!add || !update || !config) throw new Error("expected registered mutation schemas");

    expect(validateJsonSchema({ agentId: "empty-agent", adapter: {} }, add)).not.toEqual([]);
    expect(validateJsonSchema({ agentId: "empty-agent", adapter: {} }, update)).not.toEqual([]);
    expect(validateJsonSchema({ settings: {} }, config)).toContain("$.settings: minProperties");
    expect(
      validateJsonSchema({ agentId: "multi-agent", adapter: { rules: {}, skills: {} } }, add),
    ).toEqual([]);
    expect(validateJsonSchema({ agentId: "mcp-agent", adapter: { mcp: {} } }, add)).not.toEqual([]);
  });

  it.each([
    "",
    " ",
    "agent id",
    "agent\nname",
    "-agent",
    "agent-",
    "agent/name",
    "__proto__",
    "prototype",
    "constructor",
  ])("rejects unsafe agent id %j in mutation and config schemas", (agentId) => {
    const add = getCommandDefinition("agent.add")?.inputSchema.properties?.input;
    const config =
      getCommandDefinition("config.validate")?.inputSchema.properties?.input?.properties?.config;
    if (!add || !config) throw new Error("expected agent and config schemas");

    expect(
      validateJsonSchema({ agentId, adapter: { rules: { global: "~/.agent/RULES.md" } } }, add),
    ).not.toEqual([]);
    expect(
      validateJsonSchema(
        {
          customAdapters: Object.fromEntries([
            [agentId, { rules: { global: "~/.agent/RULES.md" } }],
          ]),
        },
        config,
      ),
    ).not.toEqual([]);
  });

  it("publishes exact sealed-plan apply and closed typed plan/recovery schemas", () => {
    const plan = getCommandDefinition("plan");
    const apply = getCommandDefinition("apply");
    const recover = getCommandDefinition("operation.recover");
    const planOutput = plan?.outputSchema.properties?.data?.properties?.plan;
    const applyPlanInput = apply?.inputSchema.properties?.input?.properties?.plan;
    const recoverOutput = recover?.outputSchema.properties?.data;

    expect(plan?.requiredFeatures).toEqual(
      expect.arrayContaining(["mutation-authority", "plan-apply"]),
    );
    expect(planOutput?.properties?.operation?.const).toBe("apply");
    expect(applyPlanInput?.oneOf).toHaveLength(2);
    expect(applyPlanInput?.oneOf?.map((branch) => branch.properties?.operation?.const)).toEqual([
      "apply",
      "settings",
    ]);
    for (const branch of applyPlanInput?.oneOf ?? []) {
      expect(branch).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: expect.arrayContaining(["planId", "digest", "authorization"]),
        properties: {
          authorization: {
            additionalProperties: false,
            required: [
              "schemaVersion",
              "domain",
              "algorithm",
              "authorityId",
              "authorityEpoch",
              "seal",
            ],
          },
        },
      });
    }
    expect(applyPlanInput?.oneOf?.[0]).toEqual(planOutput);
    expect(recoverOutput?.additionalProperties).toBe(false);
    expect(recoverOutput?.properties?.diagnosis?.additionalProperties).toBe(false);
    expect(recoverOutput?.properties?.operation?.additionalProperties).toBe(false);
  });
});
