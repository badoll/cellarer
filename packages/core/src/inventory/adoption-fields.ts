import type { McpServer } from "../mcp/model.js";
import type {
  InventorySecretAdoptionOffer,
  InventorySecretFieldSelector,
} from "../protocol/client-types.js";
import { detectSecret, isSensitiveSecretFieldName } from "../secrets/detector.js";
import { parseSecretReference } from "../secrets/reference.js";
import { sha256 } from "../store/checksum.js";

export function inventorySecretAdoptionOffers(
  serverName: string,
  server: McpServer,
): readonly InventorySecretAdoptionOffer[] {
  if (server.kind === "custom") return Object.freeze([]);
  const offers: InventorySecretAdoptionOffer[] = [];
  if (server.kind === "stdio") {
    for (const [name, value] of Object.entries(server.env ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (!isSensitiveSecretFieldName(name) || !isAdoptableSecret(value, name)) continue;
      offers.push(offer({ kind: "environment", server: serverName, name }));
    }
    for (let index = 0; index < (server.args ?? []).length; index += 1) {
      const argument = server.args?.[index];
      if (argument === undefined) continue;
      const assignment = /^--?([^=]+)=(.*)$/.exec(argument);
      if (
        assignment?.[1] &&
        isSensitiveSecretFieldName(assignment[1]) &&
        isAdoptableSecret(assignment[2] ?? "", assignment[1])
      ) {
        offers.push(
          offer({
            kind: "argument",
            server: serverName,
            name: assignment[1],
            index,
            style: "assignment",
          }),
        );
        continue;
      }
      const flag = /^--?(.+)$/.exec(argument)?.[1];
      const value = server.args?.[index + 1];
      if (
        flag &&
        value !== undefined &&
        isSensitiveSecretFieldName(flag) &&
        isAdoptableSecret(value, flag)
      ) {
        offers.push(
          offer({
            kind: "argument",
            server: serverName,
            name: flag,
            index: index + 1,
            style: "value",
          }),
        );
        index += 1;
      }
    }
    return frozenDistinctOffers(offers);
  }

  for (const [name, value] of Object.entries(server.headers ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!isSensitiveSecretFieldName(name) || !isAdoptableSecret(value, name)) continue;
    offers.push(offer({ kind: "header", server: serverName, name }));
  }
  const url = parseHttpUrl(server.url);
  if (url) {
    const counts = new Map<string, number>();
    for (const [name] of url.searchParams) counts.set(name, (counts.get(name) ?? 0) + 1);
    for (const [name, value] of url.searchParams) {
      if (
        counts.get(name) === 1 &&
        isSensitiveSecretFieldName(name) &&
        isAdoptableSecret(value, name)
      ) {
        offers.push(offer({ kind: "url-query", server: serverName, name }));
      }
    }
  }
  return frozenDistinctOffers(offers);
}

function isAdoptableSecret(value: string, name: string): boolean {
  if (value.length === 0 || parseSecretReference(value) !== null) return false;
  return detectSecret(value, name) !== null;
}

function offer(selector: InventorySecretFieldSelector): InventorySecretAdoptionOffer {
  return Object.freeze({
    selector: Object.freeze({ ...selector }),
    targetName: inventorySecretAdoptionTargetName(selector),
  });
}

export function inventorySecretAdoptionTargetName(selector: InventorySecretFieldSelector): string {
  const selectorId = sha256(JSON.stringify(selector)).slice("sha256:".length, 15);
  return `mcp-${safeName(selector.server)}-${selector.kind}-${safeName(selector.name)}-${selectorId}`;
}

function frozenDistinctOffers(
  offers: readonly InventorySecretAdoptionOffer[],
): readonly InventorySecretAdoptionOffer[] {
  const distinct = new Map(
    offers.map((item) => [`${JSON.stringify(item.selector)}\0${item.targetName}`, item]),
  );
  const values = [...distinct.values()].sort((left, right) =>
    JSON.stringify(left.selector).localeCompare(JSON.stringify(right.selector)),
  );
  return Object.freeze(values.length === 1 ? values : []);
}

function safeName(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "field";
}

function parseHttpUrl(value: string): URL | null {
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
