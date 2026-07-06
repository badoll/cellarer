// Local append-only activity history for the Web dashboard. It records operation
// summaries only; state.json remains the current apply ledger.
import { join } from "node:path";
import { z } from "zod";
import type { Env } from "./env.js";
import { readFileOrNull } from "./fs/probe.js";
import type { Capability, Scope } from "./model/index.js";
import { scanTextForSecrets } from "./secrets/detector.js";

export type ActivityAction = "apply" | "scan-import" | "revert";
export type ActivityActor = "you" | "system";

const actionSchema = z.enum(["apply", "scan-import", "revert"]);
const actorSchema = z.enum(["you", "system"]);
const capabilitySchema = z.enum(["rules", "mcp", "skills"]);
const scopeSchema = z.enum(["global", "project"]);

const referencesSchema = z
  .object({
    ledgerEntryKeys: z.array(z.string()).default([]),
    artifactIds: z.array(z.string()).default([]),
  })
  .strict();

const activityEventSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1),
    time: z.string().min(1),
    actor: actorSchema,
    action: actionSchema,
    scope: scopeSchema.optional(),
    projectDir: z.string().optional(),
    agents: z.array(z.string()).default([]),
    capabilities: z.array(capabilitySchema).default([]),
    affectedCount: z.number().int().nonnegative(),
    warningsCount: z.number().int().nonnegative().default(0),
    summary: z.string(),
    references: referencesSchema.optional(),
    secretRefs: z.array(z.string()).default([]),
  })
  .strict();

export type ActivityEvent = z.infer<typeof activityEventSchema>;

export interface ActivityInput {
  actor?: ActivityActor;
  action: ActivityAction;
  scope?: Scope;
  projectDir?: string;
  agents?: string[];
  capabilities?: Capability[];
  affectedCount: number;
  warningsCount?: number;
  summary: string;
  references?: {
    ledgerEntryKeys?: string[];
    artifactIds?: string[];
  };
  secretRefs?: string[];
}

export interface ActivityFilter {
  limit?: number;
  actions?: ActivityAction[];
  scope?: Scope;
  agents?: string[];
}

export interface ActivityListResult {
  events: ActivityEvent[];
  warnings: string[];
}

let activityCounter = 0;

export function activityPath(storeRoot: string): string {
  return join(storeRoot, "activity.jsonl");
}

export async function appendActivity(
  env: Env,
  storeRoot: string,
  input: ActivityInput,
): Promise<ActivityEvent> {
  activityCounter += 1;
  const time = env.now().toISOString();
  const event = activityEventSchema.parse(
    sanitizeEvent({
      version: 1,
      id: `${time}-${activityCounter}`,
      time,
      actor: input.actor ?? "you",
      action: input.action,
      scope: input.scope,
      projectDir: input.projectDir,
      agents: unique(input.agents ?? []),
      capabilities: unique(input.capabilities ?? []),
      affectedCount: input.affectedCount,
      warningsCount: input.warningsCount ?? 0,
      summary: input.summary,
      references: input.references
        ? {
            ledgerEntryKeys: unique(input.references.ledgerEntryKeys ?? []),
            artifactIds: unique(input.references.artifactIds ?? []),
          }
        : undefined,
      secretRefs: unique(input.secretRefs ?? []),
    }),
  );
  await env.fs.mkdir(storeRoot, { recursive: true });
  await env.fs.appendFile(activityPath(storeRoot), `${JSON.stringify(event)}\n`);
  return event;
}

export async function listActivity(
  env: Env,
  storeRoot: string,
  filter: ActivityFilter = {},
): Promise<ActivityListResult> {
  const text = await readFileOrNull(env, activityPath(storeRoot));
  if (text === null) return { events: [], warnings: [] };

  const warnings: string[] = [];
  const events: ActivityEvent[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const parsed = sanitizeEvent(activityEventSchema.parse(JSON.parse(line)));
      if (matchesFilter(parsed, filter)) events.push(parsed);
    } catch (err) {
      const msg = cleanString(err instanceof Error ? err.message : String(err));
      warnings.push(`activity.jsonl line ${i + 1} skipped: ${msg}`);
    }
  }

  const latest = events.reverse();
  return {
    events: typeof filter.limit === "number" ? latest.slice(0, filter.limit) : latest,
    warnings,
  };
}

export function summarizeActivity(
  env: Env,
  storeRoot: string,
  limit = 8,
): Promise<ActivityListResult> {
  return listActivity(env, storeRoot, { limit });
}

function matchesFilter(event: ActivityEvent, filter: ActivityFilter): boolean {
  if (filter.actions && !filter.actions.includes(event.action)) return false;
  if (filter.scope && event.scope !== filter.scope) return false;
  if (filter.agents && filter.agents.length > 0) {
    if (!event.agents.some((agent) => filter.agents?.includes(agent))) return false;
  }
  return true;
}

function sanitizeEvent(event: ActivityEvent): ActivityEvent {
  return {
    ...event,
    projectDir: cleanOptionalString(event.projectDir),
    agents: event.agents.map(cleanString),
    summary: cleanString(event.summary),
    references: event.references
      ? {
          ledgerEntryKeys: event.references.ledgerEntryKeys.map(cleanString),
          artifactIds: event.references.artifactIds.map(cleanString),
        }
      : undefined,
    secretRefs: event.secretRefs.map(cleanString),
  };
}

function cleanOptionalString(value: string | undefined): string | undefined {
  return value === undefined ? undefined : cleanString(value);
}

function cleanString(value: string): string {
  return scanTextForSecrets(value).length > 0 ? "[redacted secret]" : value;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
