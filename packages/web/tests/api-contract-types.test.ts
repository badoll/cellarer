import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as ts from "typescript";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const tsRuntime = createRequire(import.meta.url)("typescript") as typeof ts;

function diagnosticsText(diagnostics: readonly ts.Diagnostic[]): string {
  return tsRuntime.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => repositoryRoot,
    getNewLine: () => "\n",
  });
}

function diagnosticsWithApiContractMutation(
  mutate: (source: string) => string,
): readonly ts.Diagnostic[] {
  const configPath = resolve(packageRoot, "tsconfig.json");
  const parsed = tsRuntime.getParsedCommandLineOfConfigFile(
    configPath,
    {
      composite: false,
      incremental: false,
      noEmit: true,
      baseUrl: repositoryRoot,
      ignoreDeprecations: "6.0",
      rootDir: repositoryRoot,
      paths: {
        "@cellarer/core": ["packages/core/src/index.ts"],
        "@cellarer/core/client-api": ["packages/core/src/protocol/client.ts"],
      },
    },
    {
      ...tsRuntime.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(diagnosticsText([diagnostic]));
      },
    },
  );
  if (parsed === undefined) throw new Error("failed to parse Web tsconfig");
  if (parsed.errors.length > 0) throw new Error(diagnosticsText(parsed.errors));

  const mutationPath = resolve(packageRoot, "src", "api-contract.ts");
  const host = tsRuntime.createCompilerHost(parsed.options);
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) => {
    const source = readFile(fileName);
    if (source === undefined || resolve(fileName) !== mutationPath) return source;
    const mutated = mutate(source);
    if (mutated === source) throw new Error("api-contract mutation did not change source");
    return mutated;
  };
  const program = tsRuntime.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    host,
  });
  return tsRuntime.getPreEmitDiagnostics(program);
}

describe("OpenAPI canonical DTO type contracts", () => {
  it.each([
    [
      "an ActivityEvent action discriminant is added only to OpenAPI",
      (source: string) =>
        source.replace(
          'action: enumSchema(["apply", "inventory-import", "scan-import", "revert"]),',
          'action: enumSchema(["apply", "inventory-import", "scan-import", "revert", "schema-drift"]),',
        ),
      /ExactSchemaContract<typeof activityEventDefinitionSchema, ActivityEvent>/u,
    ],
    [
      "an ActivityEvent property is deleted only from OpenAPI",
      (source: string) => source.replace("    summary: stringSchema(),\n", ""),
      /ExactSchemaContract<typeof activityEventDefinitionSchema, ActivityEvent>/u,
    ],
    [
      "an ActivityEvent required field becomes optional only in OpenAPI",
      (source: string) => source.replace('    "summary",\n    "secretRefs",', '    "secretRefs",'),
      /ExactSchemaContract<typeof activityEventDefinitionSchema, ActivityEvent>/u,
    ],
    [
      "a resource response wrapper field becomes optional only in OpenAPI",
      (source: string) =>
        source.replace(
          '["generatedAt", "resources", "counts", "warnings"]',
          '["generatedAt", "resources", "warnings"]',
        ),
      /ExactSchemaContract<typeof controlPlaneResourceListDataSchema, ControlPlaneResourceListDto>/u,
    ],
    [
      "an agent DTO discriminant is widened only in OpenAPI",
      (source: string) =>
        source.replace(
          'adapterKind: enumSchema(["built-in", "custom"]),',
          'adapterKind: enumSchema(["built-in", "custom", "schema-drift"]),',
        ),
      /ExactSchemaContract<typeof agentDtoDefinitionSchema, ControlPlaneAgentDto>/u,
    ],
    [
      "agent capability scopes become optional only in OpenAPI",
      (source: string) => source.replace('["rules", "mcp", "skills"]', '["rules"]'),
      /ExactSchemaContract<typeof agentDtoDefinitionSchema, ControlPlaneAgentDto>/u,
    ],
    [
      "an agent response wrapper field becomes optional only in OpenAPI",
      (source: string) =>
        source.replace(
          '["storeRoot", "scope", "agents", "warnings"]',
          '["storeRoot", "scope", "agents"]',
        ),
      /ExactSchemaContract<typeof controlPlaneAgentListDataSchema, ControlPlaneAgentListDto>/u,
    ],
    [
      "a status response wrapper field becomes optional only in OpenAPI",
      (source: string) => source.replace('["generatedAt", "items"]', '["items"]'),
      /ExactSchemaContract<typeof statusListDataSchema, StatusListData>/u,
    ],
  ])("rejects %s", (_name, mutate, expectedContract) => {
    expect(diagnosticsText(diagnosticsWithApiContractMutation(mutate))).toMatch(expectedContract);
  });

  it.each([
    [
      "the scalar number type is narrowed to integer",
      (source: string) =>
        source.replace(
          '  type: ["string", "number", "boolean", "null"],',
          '  type: ["string", "integer", "boolean", "null"],',
        ),
      /ExactJsonScalarTypeList<typeof jsonScalarSchema.type>/u,
    ],
    [
      "the scalar type list contains a duplicate",
      (source: string) =>
        source.replace(
          '  type: ["string", "number", "boolean", "null"],',
          '  type: ["string", "number", "boolean", "null", "number"],',
        ),
      /ExactJsonScalarTypeList<typeof jsonScalarSchema.type>/u,
    ],
    [
      "the scalar boolean type is missing",
      (source: string) =>
        source.replace(
          '  type: ["string", "number", "boolean", "null"],',
          '  type: ["string", "number", "null"],',
        ),
      /ExactJsonScalarTypeList<typeof jsonScalarSchema.type>/u,
    ],
    [
      "the recursive array branch is deleted from JsonValue",
      (source: string) => source.replace("    arraySchema(jsonValueSchema()),\n", ""),
      /InferJsonValueDefinition<typeof jsonValueDefinitionSchema, CanonicalJsonValue>/u,
    ],
    [
      "the recursive object branch is deleted from JsonValue",
      (source: string) => source.replace("    objectSchema({}, [], jsonValueSchema()),\n", ""),
      /InferJsonValueDefinition<typeof jsonValueDefinitionSchema, CanonicalJsonValue>/u,
    ],
    [
      "the recursive object branch stops using JsonValue as additionalProperties",
      (source: string) =>
        source.replace("    objectSchema({}, [], jsonValueSchema()),\n", "    objectSchema(),\n"),
      /InferJsonValueDefinition<typeof jsonValueDefinitionSchema, CanonicalJsonValue>/u,
    ],
  ])("rejects when %s", (_name, mutate, expectedContract) => {
    expect(diagnosticsText(diagnosticsWithApiContractMutation(mutate))).toMatch(expectedContract);
  });
});
