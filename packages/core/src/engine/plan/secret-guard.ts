import { join } from "node:path";
import type { Env } from "../../env.js";
import type { DistributePlan, PlanAction, Scope, SecretGuardFinding } from "../../model/index.js";
import {
  type ActiveSecretValue,
  discoverSecretReferences,
  knownSecretValueOffsets,
} from "../../secrets/active-values.js";
import {
  type SecretPatternMatch,
  scanStructuredFileSecretFindings,
  scanTextForSecretMatches,
  scanTextForSecrets,
} from "../../secrets/detector.js";
import {
  inventoryActiveSecretValues,
  resolveActiveSecretValues,
} from "../../secrets/provider-runtime.js";
import { captureSafeRecursiveSource, type SafeRecursiveSnapshot } from "../../secrets/safe-tree.js";
import type { CellarerConfig } from "../../store/config.js";

export interface SecretGuardOptions {
  storeRoot: string;
  config: CellarerConfig;
  secretMode?: "env" | "vault" | "keychain";
  vaultPassphrase?: string;
  keychainService?: string;
  requireAvailableReferences?: boolean;
  stagedSources?: ReadonlyMap<string, SafeRecursiveSnapshot>;
  /** Canonical authorization reconstruction must never let an untrusted plan trigger providers. */
  providerAccess?: "allowed" | "forbidden";
}

interface SourceFile {
  artifact: string;
  source: string;
  content: string;
}

interface SourceScan {
  findings: SecretGuardFinding[];
  patternMatches: SecretPatternMatch[];
}

interface PatternSuppression {
  source: string;
  rule: string;
  patternVersion: number;
}

export class RecursiveSecretGuardError extends Error {
  readonly findings: readonly SecretGuardFinding[];

  constructor(findings: readonly SecretGuardFinding[]) {
    super(`recursive secret guard blocked staged output (${findings.length} finding(s))`);
    this.name = "RecursiveSecretGuardError";
    this.findings = findings;
  }
}

// Retained as a small pure pass for callers/tests that construct content actions directly. The
// production planner uses applyRecursiveSecretGuard below so Skills and known values are included.
export function applySecretScanGuard(actions: PlanAction[], scope: Scope): void {
  for (const action of actions) {
    if (action.op === "skip" || !action.preview?.after) continue;
    const textHits = action.preview?.after ? scanTextForSecrets(action.preview.after) : [];
    if (!action.accidentalPlaintext && textHits.length === 0) continue;
    const reason = action.accidentalPlaintext
      ? "store contains a plaintext secret (use a CELLARER_SECRET or env placeholder)"
      : `plaintext secret(s) [${textHits.map((finding) => finding.rule).join(", ")}]`;
    action.op = "skip";
    action.reason = `secret-scan: ${reason} would be written to ${action.target}${
      scope === "project" ? " (git-tracked)" : ""
    }`;
    action.preview = { before: action.preview.before };
  }
}

export async function applyRecursiveSecretGuard(
  env: Env,
  plan: DistributePlan,
  scope: Scope,
  options: SecretGuardOptions,
): Promise<SecretGuardFinding[]> {
  const findings = await scanRecursiveStagedTree(env, plan.actions, options);
  if (findings.length > 0) blockCompleteMutation(plan.actions, scope, findings.length);
  return findings;
}

export async function assertRecursiveSecretGuard(
  env: Env,
  actions: readonly PlanAction[],
  options: SecretGuardOptions,
): Promise<void> {
  const findings = await scanRecursiveStagedTree(env, actions, options);
  if (findings.length > 0) throw new RecursiveSecretGuardError(findings);
}

async function scanRecursiveStagedTree(
  env: Env,
  actions: readonly PlanAction[],
  options: SecretGuardOptions,
): Promise<SecretGuardFinding[]> {
  const active = actions.filter((action) => action.op !== "skip");
  if (active.length === 0) return [];
  const knownValues = await configuredKnownSecretValues(env, active, options);
  const findings: SecretGuardFinding[] = [];
  const scans = new Map<string, SourceScan>();

  for (const action of active) {
    for (const artifact of action.artifactIds ?? []) {
      if (scans.has(artifact)) continue;
      const sourceFiles = await artifactSourceFiles(
        env,
        options.storeRoot,
        artifact,
        options.stagedSources,
      );
      const suppressions = options.config.artifacts[artifact]?.secretPatternSuppressions ?? [];
      const scan = scanSourceFiles(sourceFiles, suppressions, knownValues);
      scans.set(artifact, scan);
      findings.push(...scan.findings);
    }
  }

  for (const action of active) {
    if (action.accidentalPlaintext) {
      findings.push({
        artifact: action.artifact,
        source: action.target,
        line: 1,
        rule: "sensitive-field",
      });
    }
    const content = action.preview?.after;
    if (!content) continue;
    const sourcePatternCounts = patternCounts(
      (action.artifactIds ?? []).flatMap((artifact) => scans.get(artifact)?.patternMatches ?? []),
    );
    for (const match of scanTextForSecretMatches(content)) {
      const key = patternMatchKey(match);
      const remaining = sourcePatternCounts.get(key) ?? 0;
      if (remaining > 0) {
        sourcePatternCounts.set(key, remaining - 1);
        continue;
      }
      findings.push({
        artifact: action.artifact,
        source: action.target,
        line: lineAt(content, match.index),
        rule: match.rule,
        patternVersion: match.patternVersion,
      });
    }
    findings.push(...knownValueFindings(action.artifact, action.target, content, knownValues));
    findings.push(...structuredFindings(action.artifact, action.target, content));
  }

  return dedupeFindings(findings);
}

async function configuredKnownSecretValues(
  env: Env,
  actions: readonly PlanAction[],
  options: SecretGuardOptions,
): Promise<ActiveSecretValue[]> {
  const active = actions.filter((action) => action.op !== "skip");
  if (active.length === 0) return [];
  if (options.providerAccess === "forbidden") return [];
  const references = await referencedSecretsForActions(
    env,
    active,
    options.storeRoot,
    options.stagedSources,
  );
  const mode = options.secretMode ?? options.config.defaults.secretMode;
  const providerOptions = {
    secretMode: mode,
    vaultPassphrase: options.vaultPassphrase,
    keychainService: options.keychainService,
    requireAvailable: options.requireAvailableReferences,
  };
  await resolveActiveSecretValues(env, options.storeRoot, references, providerOptions);
  return inventoryActiveSecretValues(env, options.storeRoot, providerOptions);
}

export function discoverActiveSecretValuesForActions(
  env: Env,
  actions: readonly PlanAction[],
  options: SecretGuardOptions,
): Promise<ActiveSecretValue[]> {
  return configuredKnownSecretValues(env, actions, options);
}

async function referencedSecretsForActions(
  env: Env,
  actions: readonly PlanAction[],
  storeRoot: string,
  stagedSources?: ReadonlyMap<string, SafeRecursiveSnapshot>,
): Promise<ReturnType<typeof discoverSecretReferences>> {
  const references = new Map<string, ReturnType<typeof discoverSecretReferences>[number]>();
  for (const action of actions) {
    if (action.op === "skip" || action.capability !== "mcp") continue;
    const texts: string[] = [];
    if (action.preview?.after) texts.push(action.preview.after);
    for (const artifact of action.artifactIds ?? []) {
      if (parseArtifactId(artifact)?.kind !== "mcp") continue;
      for (const file of await artifactSourceFiles(env, storeRoot, artifact, stagedSources)) {
        texts.push(file.content);
      }
    }
    const activeNames = new Set(action.secretRefs ?? []);
    for (const reference of discoverSecretReferences(texts)) {
      if (activeNames.has(reference.name))
        references.set(reference.kind + reference.name, reference);
    }
  }
  return [...references.values()];
}

async function artifactSourceFiles(
  env: Env,
  storeRoot: string,
  artifact: string,
  stagedSources?: ReadonlyMap<string, SafeRecursiveSnapshot>,
): Promise<SourceFile[]> {
  const parsed = parseArtifactId(artifact);
  if (!parsed) return [];
  const source =
    parsed.kind === "rules"
      ? `rules/${parsed.name}.md`
      : parsed.kind === "mcp"
        ? `mcp/${parsed.name}.json`
        : `skills/${parsed.name}`;
  const absolutePath = join(storeRoot, "store", source);
  const snapshot =
    stagedSources?.get(absolutePath) ?? (await captureSafeRecursiveSource(env, absolutePath));
  return snapshot.files.map((file) => ({
    artifact,
    source: file.relativePath ? `${source}/${file.relativePath}` : source,
    content: file.content,
  }));
}

function parseArtifactId(
  artifact: string,
): { kind: "rules" | "mcp" | "skills"; name: string } | null {
  const match = /^(rules|mcp|skills)\/([A-Za-z0-9._-]+)$/.exec(artifact);
  if (!match?.[1] || !match[2] || match[2] === "." || match[2] === "..") return null;
  return { kind: match[1] as "rules" | "mcp" | "skills", name: match[2] };
}

function scanSourceFiles(
  files: readonly SourceFile[],
  suppressions: readonly PatternSuppression[],
  knownValues: readonly ActiveSecretValue[],
): SourceScan {
  const findings: SecretGuardFinding[] = [];
  const patternMatches: SecretPatternMatch[] = [];
  for (const file of files) {
    const content = file.content;
    const matches = scanTextForSecretMatches(content);
    patternMatches.push(...matches);
    for (const match of matches) {
      if (isSuppressed(file.source, match, suppressions)) continue;
      findings.push({
        artifact: file.artifact,
        source: file.source,
        line: lineAt(content, match.index),
        rule: match.rule,
        patternVersion: match.patternVersion,
      });
    }
    findings.push(...knownValueFindings(file.artifact, file.source, content, knownValues));
    findings.push(...structuredFindings(file.artifact, file.source, content));
  }
  return { findings, patternMatches };
}

function structuredFindings(
  artifact: string,
  source: string,
  content: string,
): SecretGuardFinding[] {
  return scanStructuredFileSecretFindings(source, content).map((finding) => ({
    artifact,
    source,
    line: 1,
    rule: finding.rule,
    patternVersion: 1,
  }));
}

function knownValueFindings(
  artifact: string,
  source: string,
  content: string,
  knownValues: readonly ActiveSecretValue[],
): SecretGuardFinding[] {
  return knownSecretValueOffsets(content, knownValues).map((index) => ({
    artifact,
    source,
    line: lineAt(content, index),
    rule: "known-secret-value",
  }));
}

function isSuppressed(
  source: string,
  match: SecretPatternMatch,
  suppressions: readonly PatternSuppression[],
): boolean {
  return suppressions.some(
    (suppression) =>
      suppression.source === source &&
      suppression.rule === match.rule &&
      suppression.patternVersion === match.patternVersion,
  );
}

function patternCounts(matches: readonly SecretPatternMatch[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of matches) {
    const key = patternMatchKey(match);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function patternMatchKey(match: SecretPatternMatch): string {
  return `${match.rule}\u0000${match.patternVersion}\u0000${match.value}`;
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (content.charCodeAt(position) === 10) line += 1;
  }
  return line;
}

function dedupeFindings(findings: readonly SecretGuardFinding[]): SecretGuardFinding[] {
  const unique = new Map<string, SecretGuardFinding>();
  for (const finding of findings) {
    const key = JSON.stringify([
      finding.artifact,
      finding.source,
      finding.line,
      finding.rule,
      finding.patternVersion,
    ]);
    unique.set(key, finding);
  }
  return [...unique.values()].sort(
    (left, right) =>
      findingPriority(left) - findingPriority(right) ||
      left.source.localeCompare(right.source) ||
      left.line - right.line ||
      left.rule.localeCompare(right.rule),
  );
}

function findingPriority(finding: SecretGuardFinding): number {
  if (finding.rule === "known-secret-value") return 0;
  if (finding.rule === "sensitive-field") return 2;
  if (["command-secret-argument", "url-userinfo", "url-secret-query"].includes(finding.rule)) {
    return 3;
  }
  return 1;
}

function blockCompleteMutation(actions: PlanAction[], scope: Scope, findingCount: number): void {
  for (const action of actions) {
    if (action.op === "skip") continue;
    action.op = "skip";
    action.reason = `secret-scan: complete staged mutation blocked by ${findingCount} non-disclosing plaintext/credential finding(s)${
      scope === "project" ? " (git-tracked)" : ""
    }`;
    action.preview = undefined;
  }
}
