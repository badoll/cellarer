import type { AdapterMcp } from "../adapters/types.js";
import { ResourceSemanticsError, type SemanticResult } from "../resources/semantics.js";
import { parseSecretReference } from "../secrets/reference.js";
import { type McpServer, type McpServerSet, mcpDialectIdentity } from "./model.js";

/** Position support is a native contract, never inferred from the reference-kind boolean. */
export function compileMcp(
  incoming: McpServerSet,
  target: AdapterMcp,
): SemanticResult<McpServerSet> {
  try {
    const output: McpServerSet = Object.create(null);
    const dialect = target.codec.dialect;
    const profile = dialect?.semanticDialect ?? "standard";
    for (const [name, source] of Object.entries(incoming)) {
      if (source.kind === "custom") fail("requires-choice", "MCP_UNKNOWN_CONNECTION");
      const server = structuredClone(source) as Exclude<McpServer, { kind: "custom" }>;
      if (
        server.extra &&
        Object.keys(server.extra).length &&
        server.sourceDialect !== mcpDialectIdentity(dialect)
      )
        fail("requires-choice", "MCP_EXTENSION_DIALECT");
      // Unknown extension reference positions are never granted blanket expansion support.
      if (containsReference(server.extra)) fail("unsupported", "MCP_EXTENSION_REFERENCE");
      if (server.kind === "remote") {
        if (!server.transport || server.transport === "unknown")
          fail("requires-choice", "MCP_UNKNOWN_TRANSPORT");
        if (
          profile === "standard" ||
          (profile === "codex" && server.transport !== "streamable-http")
        )
          fail("unsupported", "MCP_TRANSPORT_UNSUPPORTED");
        if (containsReference(server.url) && !supportsPosition(target, "url"))
          fail("unsupported", "MCP_URL_REFERENCE");
        validateReferences(server.url, target);
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(server.headers ?? {})) {
          validateReferences(value, target);
          if (!containsReference(value) || supportsPosition(target, "headers")) {
            headers[key] = value;
            continue;
          }
          if (server.sourceDialect === mcpDialectIdentity(dialect))
            fail("unsupported", "MCP_SOURCE_LITERAL_REFERENCE");
          if (profile !== "codex") fail("unsupported", "MCP_HEADER_REFERENCE");
          const ref = parseSecretReference(value);
          if (ref?.kind === "environment") {
            server.extra = {
              ...server.extra,
              env_http_headers: { ...asRecord(server.extra?.env_http_headers), [key]: ref.name },
            };
          } else fail("unsupported", "MCP_HEADER_REFERENCE");
        }
        server.headers = headers;
      } else {
        validateReferences(server.command, target);
        if (containsReference(server.command) && !supportsPosition(target, "command"))
          fail("unsupported", "MCP_COMMAND_REFERENCE");
        for (const arg of server.args ?? []) {
          validateReferences(arg, target);
          if (containsReference(arg) && !supportsPosition(target, "args"))
            fail("unsupported", "MCP_ARGUMENT_REFERENCE");
        }
        for (const [key, value] of Object.entries(server.env ?? {})) {
          validateReferences(value, target);
          if (!containsReference(value) || supportsPosition(target, "env")) continue;
          const ref = parseSecretReference(value);
          if (profile !== "codex" || ref?.kind !== "environment" || key !== ref.name)
            fail("unsupported", "MCP_ENV_REFERENCE");
          server.extra = {
            ...server.extra,
            env_vars: [
              ...new Set([
                ...(Array.isArray(server.extra?.env_vars) ? server.extra.env_vars : []),
                key,
              ]),
            ],
          };
          delete server.env?.[key];
        }
      }
      output[name] = server;
    }
    return { status: "exact", value: output };
  } catch (error) {
    return {
      status: error instanceof ResourceSemanticsError ? error.status : "unsupported",
      reason: error instanceof ResourceSemanticsError ? error.code : "INVALID_MCP",
    };
  }
}

function fail(status: "requires-choice" | "unsupported", code: string): never {
  throw new ResourceSemanticsError(status, code);
}
function containsReference(value: unknown): boolean {
  if (typeof value === "string") return /\$\{/.test(value);
  if (Array.isArray(value)) return value.some(containsReference);
  return (
    value !== null && typeof value === "object" && Object.values(value).some(containsReference)
  );
}
function validateReferences(value: string, target: AdapterMcp): void {
  if (containsReference(value) && !parseSecretReference(value))
    fail("unsupported", "MCP_REFERENCE_EXPRESSION");
  for (const token of value.match(/\$\{[^}]*\}/g) ?? []) {
    const ref = parseSecretReference(token);
    if (!ref || !target.supportedSecretReferences.includes(ref.kind))
      fail("unsupported", "MCP_REFERENCE_KIND");
  }
}
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function supportsPosition(
  target: AdapterMcp,
  position: "command" | "args" | "env" | "url" | "headers",
): boolean {
  const dialect = target.codec.dialect;
  if (dialect?.expansionPositions) return dialect.expansionPositions.includes(position);
  return (
    dialect?.semanticDialect === "claude" ||
    (dialect?.semanticDialect === "gemini" && position === "env")
  );
}
