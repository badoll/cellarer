import { describe, expect, it } from "vitest";
import type { JsonSchema } from "../src/protocol/schemas.js";

type RuntimeValidator = (value: unknown, schema: JsonSchema, path?: string) => string[];

async function runtimeValidator(): Promise<RuntimeValidator | undefined> {
  const module = (await import("../src/protocol/input.js")) as Record<string, unknown>;
  const candidate = module.validateJsonSchema;
  return typeof candidate === "function" ? (candidate as RuntimeValidator) : undefined;
}

describe("structured request JSON Schema validator", () => {
  it("exports the runtime validator used before Core invocation", async () => {
    expect(await runtimeValidator()).toBeTypeOf("function");
  });

  it("validates number values and typed dynamic maps recursively", async () => {
    const validate = await runtimeValidator();
    expect(validate).toBeTypeOf("function");
    if (!validate) return;
    const schema: JsonSchema = {
      type: "object",
      properties: {
        backup: { type: ["string", "null"] },
        weights: {
          type: "object",
          properties: {},
          additionalProperties: { type: "number", minimum: 0 },
        },
      },
      required: ["backup", "weights"],
      additionalProperties: false,
    };

    expect(validate({ backup: 7, weights: { safe: 1 } }, schema)).toContain(
      "$.backup: type string,null",
    );
    expect(validate({ backup: null, weights: { unsafe: "1" } }, schema)).toContain(
      "$.weights.unsafe: type number",
    );
    expect(validate({ backup: null, weights: { safe: 1.5 } }, schema)).toEqual([]);
  });

  it("enforces allOf closure and exact oneOf match counts", async () => {
    const validate = await runtimeValidator();
    expect(validate).toBeTypeOf("function");
    if (!validate) return;
    const allOf: JsonSchema = {
      allOf: [
        {
          type: "object",
          properties: { kind: { const: "safe" } },
          required: ["kind"],
          additionalProperties: false,
        },
      ],
    };
    const oneOf: JsonSchema = {
      oneOf: [
        { type: "number", minimum: 0 },
        { type: "integer", minimum: 0 },
      ],
    };

    expect(validate({ kind: "safe", extra: true }, allOf)).toContain(
      "$: unexpected property extra",
    );
    expect(validate(1, oneOf)).toContain("$: oneOf (matched 2)");
    expect(validate("1", oneOf)).toContain("$: oneOf (matched 0)");
  });

  it("enforces minimum object fields and at-least-one schema branches", async () => {
    const validate = await runtimeValidator();
    expect(validate).toBeTypeOf("function");
    if (!validate) return;
    const schema: JsonSchema = {
      type: "object",
      properties: {
        rules: { type: "object", properties: {}, additionalProperties: false },
        mcp: { type: "object", properties: {}, additionalProperties: false },
        skills: { type: "object", properties: {}, additionalProperties: false },
      },
      additionalProperties: false,
      minProperties: 1,
      anyOf: [{ required: ["rules"] }, { required: ["mcp"] }, { required: ["skills"] }],
    };

    expect(validate({}, schema)).toEqual(
      expect.arrayContaining(["$: minProperties", "$: anyOf (matched 0)"]),
    );
    expect(validate({ rules: {}, skills: {} }, schema)).toEqual([]);
  });

  it("fails closed without throwing on hostile value or schema reflection", async () => {
    const validate = await runtimeValidator();
    expect(validate).toBeTypeOf("function");
    if (!validate) return;
    const hostileValue = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile ownKeys");
        },
      },
    );
    const hostileSchema = new Proxy({ type: "object" } as JsonSchema, {
      get() {
        throw new Error("hostile schema getter");
      },
    });

    expect(() => validate(hostileValue, { type: "object" })).not.toThrow();
    expect(validate(hostileValue, { type: "object" })).not.toEqual([]);
    expect(() => validate({}, hostileSchema)).not.toThrow();
    expect(validate({}, hostileSchema)).not.toEqual([]);
  });
});
