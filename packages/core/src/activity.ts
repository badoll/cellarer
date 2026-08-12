// Local append-only activity history for the Web dashboard. It records operation
// summaries only; state.json remains the current apply ledger.
import { join } from "node:path";
import { z } from "zod";
import type { Env } from "./env.js";
import { readFileOrNull } from "./fs/probe.js";
import type { Capability, Scope } from "./model/index.js";
import type {
  ActivityAction,
  ActivityActor,
  ActivityEvent,
  AssertExact,
  ExactContract,
} from "./protocol/client-types.js";
import {
  observableOptionsForEnv,
  redactObservableText,
  serializeObservable,
} from "./secrets/observable.js";

export type { ActivityAction, ActivityActor, ActivityEvent } from "./protocol/client-types.js";

const actionSchema = z.enum(["apply", "scan-import", "revert"]);
const actorSchema = z.enum(["you", "system"]);
const capabilitySchema = z.enum(["rules", "mcp", "skills"]);
const scopeSchema = z.enum(["global", "project"]);

const resourcesSchema = z
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
    resources: resourcesSchema.optional(),
    secretRefs: z.array(z.string()).default([]),
  })
  .strict();

type ActivityEventSchemaInput = Omit<
  ActivityEvent,
  "agents" | "capabilities" | "warningsCount" | "resources" | "secretRefs"
> & {
  agents?: ActivityEvent["agents"];
  capabilities?: ActivityEvent["capabilities"];
  warningsCount?: ActivityEvent["warningsCount"];
  resources?: Partial<NonNullable<ActivityEvent["resources"]>>;
  secretRefs?: ActivityEvent["secretRefs"];
};

export type ActivityEventSchemaInputContract = AssertExact<
  ExactContract<z.input<typeof activityEventSchema>, ActivityEventSchemaInput>
>;
export type ActivityEventSchemaOutputContract = AssertExact<
  ExactContract<z.output<typeof activityEventSchema>, ActivityEvent>
>;

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
  resources?: {
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

export function activityPath(storeRoot: string): string {
  return join(storeRoot, "activity.jsonl");
}

async function appendActivityImplementation(env: Env, storeRoot: string, input: ActivityInput) {
  const time = env.now().toISOString();
  const event = activityEventSchema.parse(
    sanitizeEvent(
      {
        version: 1,
        id: `${time}-${env.randomId()}`,
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
        resources: input.resources
          ? {
              ledgerEntryKeys: unique(input.resources.ledgerEntryKeys ?? []),
              artifactIds: unique(input.resources.artifactIds ?? []),
            }
          : undefined,
        secretRefs: unique(input.secretRefs ?? []),
      } satisfies ActivityEvent,
      env,
    ),
  );
  await env.fs.mkdir(storeRoot, { recursive: true });
  const serialized = serializeObservable("activity", event, observableOptionsForEnv(env));
  const published = activityEventSchema.parse(JSON.parse(serialized));
  await env.fs.appendFile(activityPath(storeRoot), `${serialized}\n`);
  return published;
}

export async function appendActivity(
  env: Env,
  storeRoot: string,
  input: ActivityInput,
): Promise<ActivityEvent> {
  return appendActivityImplementation(env, storeRoot, input);
}

export type ActivityEventProducerContract = AssertExact<
  ExactContract<Awaited<ReturnType<typeof appendActivityImplementation>>, ActivityEvent>
>;

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
      const parsed = sanitizeEvent(activityEventSchema.parse(JSON.parse(line)), env);
      if (matchesFilter(parsed, filter)) events.push(parsed);
    } catch (err) {
      const msg = cleanString(err instanceof Error ? err.message : String(err), env);
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

function sanitizeEvent(event: ActivityEvent, env: Env): ActivityEvent {
  return {
    ...event,
    projectDir: cleanOptionalString(event.projectDir, env),
    agents: event.agents.map((value) => cleanString(value, env)),
    summary: cleanString(event.summary, env),
    resources: event.resources
      ? {
          ledgerEntryKeys: event.resources.ledgerEntryKeys.map((value) => cleanString(value, env)),
          artifactIds: event.resources.artifactIds.map((value) => cleanString(value, env)),
        }
      : undefined,
    secretRefs: event.secretRefs.map((value) => cleanString(value, env)),
  };
}

function cleanOptionalString(value: string | undefined, env: Env): string | undefined {
  return value === undefined ? undefined : cleanString(value, env);
}

function cleanString(value: string, env: Env): string {
  return redactObservableText(value, observableOptionsForEnv(env));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
