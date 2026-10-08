import { execFile } from "node:child_process";
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import type * as ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  baselineRootRuntimeKeys,
  baselineRootTypeNames,
  baselineTouchedModulePublicSignatures,
  baselineTouchedPublicSignatures,
} from "./fixtures/package-exports-baseline.js";
import { packageManagerInvocation } from "./helpers/package-manager.js";

const execFileAsync = promisify(execFile);
const gunzipAsync = promisify(gunzip);
const tsRuntime = createRequire(import.meta.url)("typescript") as typeof ts;
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const packageRequire = createRequire(join(packageRoot, "package.json"));
const portableDeclarationAllowlist = [
  "dist/protocol/client-types.d.ts",
  "dist/protocol/client.d.ts",
];
const baselineTouchedRootModules = new Set([
  "./activity.js",
  "./control-plane.js",
  "./dashboard.js",
  "./engine/plan.js",
  "./engine/status.js",
  "./engine/types.js",
  "./model/index.js",
  "./protocol/canonical.js",
  "./protocol/cli.js",
  "./protocol/client.js",
  "./protocol/models.js",
  "./resources/catalog.js",
  "./resources/model.js",
  "./settings.js",
  "./store/config.js",
]);
const baselineTouchedRootValues = [
  "activityPath",
  "listActivity",
  "summarizeActivity",
  "diffControlPlane",
  "listControlPlaneAgents",
  "listControlPlaneCollections",
  "listControlPlaneOperations",
  "listControlPlaneResources",
  "showControlPlaneAgent",
  "showControlPlaneCollection",
  "showControlPlaneConfig",
  "showControlPlaneOperation",
  "showControlPlaneResource",
  "statusControlPlane",
  "summaryControlPlane",
  "validateControlPlaneConfig",
  "verifyControlPlane",
  "dashboardSummary",
  "statusIdentityKey",
  "inCollections",
  "plan",
  "status",
  "canonicalJson",
  "canonicalMutationPlan",
  "createDurableMutationPlan",
  "createMutationPlan",
  "verifyDurableMutationPlanDigest",
  "CLI_PROTOCOL_VERSION",
  "CLIENT_API_CONTRACT_ID",
  "CLIENT_API_MAX_INVENTORY_IMPORT_BODY_BYTES",
  "CLIENT_API_MAX_REQUEST_BODY_BYTES",
  "CLIENT_API_VERSION",
  "clientErrorFromMutationConflict",
  "clientFailure",
  "clientSuccess",
  "resolveClientRequestId",
  "MUTATION_PLAN_SCHEMA_VERSION",
  "OPERATION_JOURNAL_SCHEMA_VERSION",
  "OPERATION_RECEIPT_SCHEMA_VERSION",
  "resourceCatalog",
  "createResourceRecord",
  "InvalidResourceMetadataError",
  "loadResourceRecord",
  "parseResourceRecord",
  "RESOURCE_MODEL_SCHEMA_VERSION",
  "resolveCurrentResourceArtifact",
  "resourceMetadataPath",
  "resourceRevisionContentPath",
  "resourceSourceCanCheckForUpdates",
  "resourceSourceDescriptorSchema",
  "resourceValidationCheckSchema",
  "resourceValidationEvidenceSchema",
  "settingsSummary",
  "AGENT_ID_PATTERN",
  "CONFIG_FILENAME",
  "InvalidConfigError",
  "initialConfigText",
  "loadAdapterSpecs",
  "loadConfig",
  "NORMALIZED_STORE_RELATIVE_SOURCE_PATTERN",
  "PACKAGED_CONFIG_PATH",
  "packagedConfigText",
  "parseAdapterBodyConfig",
  "parseAdapterOverrideConfig",
  "parseAdapterPatchConfig",
  "parseConfig",
  "parsePackagedConfigForSettings",
] as const;
const baselineTouchedRootTypes = [
  "ActivityAction",
  "ActivityActor",
  "ActivityEvent",
  "ActivityFilter",
  "ControlPlaneAgentDetailDto",
  "ControlPlaneAgentDetailOptions",
  "ControlPlaneAgentDto",
  "ControlPlaneAgentListDto",
  "ControlPlaneAgentOptions",
  "ControlPlaneAgentTarget",
  "ControlPlaneCollectionDetailDto",
  "ControlPlaneCollectionDetailOptions",
  "ControlPlaneCollectionDto",
  "ControlPlaneCollectionListDto",
  "ControlPlaneConfigDto",
  "ControlPlaneConfigValidationDto",
  "ControlPlaneDiffDto",
  "ControlPlaneOperationDetailDto",
  "ControlPlaneOperationDetailOptions",
  "ControlPlaneOperationListDto",
  "ControlPlaneOperationListOptions",
  "ControlPlaneOperationSummaryDto",
  "ControlPlaneResourceDetailDto",
  "ControlPlaneResourceDetailOptions",
  "ControlPlaneResourceDto",
  "ControlPlaneResourceListDto",
  "ControlPlaneResourceQuery",
  "ControlPlaneResourceValidation",
  "ControlPlaneStatusDto",
  "ControlPlaneStoreOptions",
  "ControlPlaneSummaryDto",
  "ControlPlaneValidationIssue",
  "ControlPlaneVerifyDto",
  "AgentReadinessState",
  "DashboardAgentCounts",
  "DashboardAgentReadiness",
  "DashboardArtifactCounts",
  "DashboardCapabilityReadiness",
  "DashboardCoverageGroup",
  "DashboardDriftCounts",
  "DashboardSecretRefStat",
  "DashboardSummaryOptions",
  "DashboardSummaryResult",
  "ApplyCallResult",
  "ApplyFailure",
  "ApplyMutationContext",
  "ApplyMutationPlanPreflight",
  "ApplyMutationResult",
  "ApplyResult",
  "DistributeOptions",
  "DriftStatus",
  "MutationPlanOptions",
  "PlannedApplyMutation",
  "PlannedRevertMutation",
  "RevertCallResult",
  "RevertFailure",
  "RevertMutationContext",
  "RevertMutationResult",
  "RevertOptions",
  "RevertPlan",
  "RevertPlanTarget",
  "RevertProposedAction",
  "RevertResult",
  "RevertSnapshotAvailability",
  "RevertSnapshotStatus",
  "StatusItem",
  "StatusOptions",
  "AppliedMethod",
  "AppliedReceipt",
  "Artifact",
  "ArtifactKind",
  "Capability",
  "Collection",
  "Deployment",
  "DeploymentConsumer",
  "DeploymentState",
  "DesiredPlacementMethod",
  "DesiredTargetEvidence",
  "DistributePlan",
  "Ledger",
  "LedgerEntry",
  "LinkMethod",
  "ManagedContribution",
  "PlanAction",
  "Scope",
  "SecretGuardFinding",
  "SecretReferenceFinding",
  "TargetAcknowledgement",
  "TargetAcknowledgementKind",
  "TargetClassification",
  "TargetConflict",
  "TargetConflictCode",
  "TargetOwner",
  "TargetOwnershipEvidence",
  "TargetReplacementApproval",
  "CliCommandRequest",
  "CliError",
  "CliErrorCode",
  "CliErrorResultEnvelope",
  "CliEvent",
  "CliEventEnvelope",
  "CliProtocolRecord",
  "CliProtocolVersion",
  "CliResultEnvelope",
  "CliSuccessResultEnvelope",
  "CliWarning",
  "ClientApiVersion",
  "ClientError",
  "ClientErrorCode",
  "ClientErrorResultEnvelope",
  "ClientResultEnvelope",
  "ClientSuccessResultEnvelope",
  "ClientWarning",
  "ActionPrecondition",
  "CanonicalJsonObject",
  "CanonicalJsonPrimitive",
  "CanonicalJsonValue",
  "DurableMutationPlan",
  "DurableMutationPlanAction",
  "ExpiredPlanConflict",
  "InterruptedOperationConflict",
  "InvalidPlanDigestConflict",
  "LockConflict",
  "LockOwnerEvidence",
  "ManualRecoveryRequiredConflict",
  "MutationAuthorizationEnvelope",
  "MutationConflict",
  "MutationOperation",
  "MutationPlan",
  "MutationPlanAction",
  "MutationPlanInput",
  "OperationActionFailure",
  "OperationActionReceipt",
  "OperationJournal",
  "OperationJournalAction",
  "OperationJournalStatus",
  "OperationReceipt",
  "OperationResult",
  "OperationStatePublication",
  "PartialFailureConflict",
  "PlanExpiry",
  "StaleRevisionConflict",
  "StoreRevision",
  "TargetPreconditionConflict",
  "TargetStateReceipt",
  "Destination",
  "ResourceCatalogCounts",
  "ResourceCatalogItem",
  "ResourceCatalogOptions",
  "ResourceCatalogResult",
  "ResourceState",
  "ResourceSyncTarget",
  "CreateResourceRecordInput",
  "ResourceRecord",
  "ResourceRevision",
  "ResourceSourceDescriptor",
  "ResourceValidationCheck",
  "ResourceValidationEvidence",
  "SettingsCollection",
  "SettingsSummary",
  "SettingsSummaryOptions",
  "AdapterBodyConfig",
  "AdapterOverrideConfig",
  "AdapterPatchConfig",
  "CellarerConfig",
] as const;
const baselineMigratedTypeModules = [
  {
    alias: "Activity",
    module: "activity",
    names: ["ActivityAction", "ActivityActor", "ActivityEvent"],
  },
  {
    alias: "ControlPlane",
    module: "control-plane",
    names: [
      "ControlPlaneAgentDto",
      "ControlPlaneAgentListDto",
      "ControlPlaneAgentTarget",
      "ControlPlaneResourceDesiredUsage",
      "ControlPlaneResourceDto",
      "ControlPlaneResourceListDto",
      "ControlPlaneResourceValidation",
      "ControlPlaneValidationIssue",
    ],
  },
  {
    alias: "Dashboard",
    module: "dashboard",
    names: [
      "AgentReadinessState",
      "DashboardAgentCounts",
      "DashboardAgentReadiness",
      "DashboardArtifactCounts",
      "DashboardCapabilityReadiness",
      "DashboardCoverageGroup",
      "DashboardDriftCounts",
      "DashboardSecretRefStat",
      "DashboardSummaryResult",
    ],
  },
  {
    alias: "EngineTypes",
    module: "engine/types",
    names: ["DriftStatus", "StatusItem"],
  },
  {
    alias: "Model",
    module: "model/index",
    names: [
      "AppliedMethod",
      "AppliedReceipt",
      "Capability",
      "Collection",
      "DesiredPlacementMethod",
      "DesiredTargetEvidence",
      "DistributePlan",
      "LinkMethod",
      "PlanAction",
      "Scope",
      "SecretGuardFinding",
      "SecretReferenceFinding",
      "StoreInputEvidence",
      "TargetAcknowledgement",
      "TargetAcknowledgementKind",
      "TargetClassification",
      "TargetConflict",
      "TargetConflictCode",
      "TargetOwnershipEvidence",
      "TargetReplacementApproval",
    ],
  },
  {
    alias: "Cli",
    module: "protocol/cli",
    names: ["CliErrorCode"],
  },
  {
    alias: "ProtocolModels",
    module: "protocol/models",
    names: [
      "ActionPrecondition",
      "CanonicalJsonObject",
      "CanonicalJsonPrimitive",
      "CanonicalJsonValue",
      "ExpiredPlanConflict",
      "InterruptedOperationConflict",
      "InvalidPlanConflict",
      "InvalidPlanDigestConflict",
      "LockConflict",
      "LockOwnerEvidence",
      "ManualRecoveryRequiredConflict",
      "MutationAuthorizationDomain",
      "MutationAuthorizationEnvelope",
      "MutationConflict",
      "MutationOperation",
      "MutationPlan",
      "MutationPlanAction",
      "MutationPlanInput",
      "OperationJournalStatus",
      "PartialFailureConflict",
      "PlanExpiry",
      "StaleRevisionConflict",
      "StoreRevision",
      "TargetPreconditionConflict",
      "TargetStateReceipt",
    ],
  },
  {
    alias: "ResourceCatalog",
    module: "resources/catalog",
    names: [
      "Destination",
      "ResourceCatalogCounts",
      "ResourceCatalogItem",
      "ResourceCatalogResult",
      "ResourceState",
      "ResourceSyncTarget",
    ],
  },
  {
    alias: "ResourceModel",
    module: "resources/model",
    names: [
      "ResourceRevision",
      "ResourceSourceDescriptor",
      "ResourceValidationCheck",
      "ResourceValidationEvidence",
    ],
  },
  {
    alias: "Settings",
    module: "settings",
    names: ["SettingsCollection", "SettingsSummary"],
  },
] as const;

let testRoot: string;
let consumerRoot: string;
let packageInstallRoot: string;
let packageStageRoot: string;
let portableConsumerRoot: string;
let portablePackageInstallRoot: string;

interface PackageManifest {
  readonly name?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

function diagnosticsText(diagnostics: readonly ts.Diagnostic[]): string {
  return tsRuntime.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => repositoryRoot,
    getNewLine: () => "\n",
  });
}

async function buildCoreInto(sourceRoot: string, destinationRoot: string): Promise<void> {
  const configPath = join(sourceRoot, "tsconfig.json");
  const parsed = tsRuntime.getParsedCommandLineOfConfigFile(
    configPath,
    {
      composite: false,
      incremental: false,
      outDir: join(destinationRoot, "dist"),
      rootDir: join(sourceRoot, "src"),
      tsBuildInfoFile: join(destinationRoot, ".tsbuildinfo"),
    },
    {
      ...tsRuntime.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(diagnosticsText([diagnostic]));
      },
    },
  );
  if (parsed === undefined) throw new Error("failed to parse Core tsconfig");
  if (parsed.errors.length > 0) throw new Error(diagnosticsText(parsed.errors));
  const program = tsRuntime.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const emit = program.emit();
  const diagnostics = [...tsRuntime.getPreEmitDiagnostics(program), ...emit.diagnostics];
  if (diagnostics.length > 0) throw new Error(diagnosticsText(diagnostics));
}

async function packageRootFor(packageName: string, requireFrom: NodeRequire): Promise<string> {
  let resolvedEntry: string | undefined;
  try {
    resolvedEntry = requireFrom.resolve(packageName);
  } catch {
    // Some ESM-only packages do not export their package root. Fall through to Node's physical
    // package search paths so the fixture can copy the already-installed workspace dependency.
  }
  if (resolvedEntry !== undefined) {
    let candidate = dirname(resolvedEntry);
    while (candidate !== dirname(candidate)) {
      try {
        const manifest = JSON.parse(
          await readFile(join(candidate, "package.json"), "utf8"),
        ) as PackageManifest;
        if (manifest.name === packageName) return candidate;
      } catch {
        // Keep walking toward the package store root.
      }
      candidate = dirname(candidate);
    }
  }
  for (const searchRoot of requireFrom.resolve.paths(packageName) ?? []) {
    const candidate = join(searchRoot, ...packageName.split("/"));
    try {
      await access(join(candidate, "package.json"));
      return await realpath(candidate);
    } catch {
      // Try the next standard Node package search root.
    }
  }
  throw new Error(`workspace dependency is unavailable: ${packageName}`);
}

async function installWorkspaceDependencyTree(
  packageNames: readonly string[],
  destinationNodeModules: string,
): Promise<void> {
  const installed = new Set<string>();
  const pending = packageNames.map((name) => ({ name, requireFrom: packageRequire }));
  while (pending.length > 0) {
    const dependency = pending.pop();
    if (dependency === undefined || installed.has(dependency.name)) continue;
    const sourceRoot = await packageRootFor(dependency.name, dependency.requireFrom);
    const manifest = JSON.parse(
      await readFile(join(sourceRoot, "package.json"), "utf8"),
    ) as PackageManifest;
    const destination = join(destinationNodeModules, ...dependency.name.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await cp(sourceRoot, destination, {
      recursive: true,
      dereference: true,
      filter: (source) => source !== join(sourceRoot, "node_modules"),
    });
    installed.add(dependency.name);
    const transitive = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    };
    const childRequire = createRequire(join(sourceRoot, "package.json"));
    pending.push(...Object.keys(transitive).map((name) => ({ name, requireFrom: childRequire })));
  }
}

function tarString(archive: Buffer, offset: number, length: number): string {
  const end = archive.indexOf(0, offset);
  return archive
    .subarray(offset, end === -1 || end > offset + length ? offset + length : end)
    .toString("utf8");
}

async function extractTarArchive(
  archive: Buffer,
  destination: string,
  relativeEntryPath: (packedPath: string) => string,
): Promise<void> {
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const packedPath = prefix.length > 0 ? `${prefix}/${name}` : name;
    const sizeText = tarString(header, 124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid tar entry size");
    const type = String.fromCharCode(header[156] ?? 0);
    offset += 512;
    const content = archive.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (type === "x" || type === "g") continue;
    const relativePath = normalize(relativeEntryPath(packedPath));
    if (
      relativePath.length === 0 ||
      isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`)
    ) {
      throw new Error(`unsafe packed entry path: ${packedPath}`);
    }
    const target = join(destination, relativePath);
    if (type === "5") {
      await mkdir(target, { recursive: true });
    } else if (type === "0" || type === "\0") {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    } else {
      throw new Error(`unsupported packed entry type ${JSON.stringify(type)}: ${packedPath}`);
    }
  }
  throw new Error("packed artifact did not contain a tar terminator");
}

async function extractPackedArtifact(archivePath: string, destination: string): Promise<void> {
  await extractTarArchive(
    await gunzipAsync(await readFile(archivePath)),
    destination,
    (packedPath) => {
      if (!packedPath.startsWith("package/")) {
        throw new Error(`packed entry is outside package root: ${packedPath}`);
      }
      return packedPath.slice("package/".length);
    },
  );
}

async function rootDeclarationInventory(onlyTouchedModules = false): Promise<{
  readonly types: readonly string[];
  readonly values: readonly string[];
}> {
  const sourcePath = join(packageStageRoot, "dist", "index.d.ts");
  const sourceFile = tsRuntime.createSourceFile(
    sourcePath,
    await readFile(sourcePath, "utf8"),
    tsRuntime.ScriptTarget.Latest,
    true,
    tsRuntime.ScriptKind.TS,
  );
  const types: string[] = [];
  const values: string[] = [];
  for (const statement of sourceFile.statements) {
    if (
      !tsRuntime.isExportDeclaration(statement) ||
      statement.moduleSpecifier === undefined ||
      !tsRuntime.isStringLiteral(statement.moduleSpecifier) ||
      (onlyTouchedModules && !baselineTouchedRootModules.has(statement.moduleSpecifier.text)) ||
      statement.exportClause === undefined ||
      !tsRuntime.isNamedExports(statement.exportClause)
    ) {
      continue;
    }
    for (const element of statement.exportClause.elements) {
      (statement.isTypeOnly || element.isTypeOnly ? types : values).push(element.name.text);
    }
  }
  return onlyTouchedModules
    ? { types, values }
    : { types: [...new Set(types)].sort(), values: [...new Set(values)].sort() };
}

function migratedTypeAvailabilitySource(): string {
  const migratedImports = baselineMigratedTypeModules
    .map(
      ({ alias, module }) =>
        `import type * as Current${alias} from "./node_modules/@cellarer/core/dist/${module}.js";`,
    )
    .join("\n");
  const migratedTypes = baselineMigratedTypeModules
    .flatMap(({ alias, names }) => names.map((name) => `  Current${alias}.${name},`))
    .join("\n");
  return `${migratedImports}

type BaselineMigratedModuleTypes = [
${migratedTypes}
];
void (undefined as unknown as BaselineMigratedModuleTypes);
`;
}

function normalizedPublicSignature(signature: string): string {
  return signature.replace(/import\("[^"]+"\)\./gu, "");
}

function installedTouchedPublicSignatures(): Readonly<Record<string, string>> {
  const declarationPath = join(packageInstallRoot, "dist", "index.d.ts");
  const options: ts.CompilerOptions = {
    module: tsRuntime.ModuleKind.NodeNext,
    moduleResolution: tsRuntime.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: false,
    strict: true,
    target: tsRuntime.ScriptTarget.ES2023,
    types: [],
  };
  const program = tsRuntime.createProgram({ rootNames: [declarationPath], options });
  const diagnostics = tsRuntime.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) throw new Error(diagnosticsText(diagnostics));
  const sourceFile = program.getSourceFile(declarationPath);
  const moduleSymbol =
    sourceFile === undefined ? undefined : program.getTypeChecker().getSymbolAtLocation(sourceFile);
  if (sourceFile === undefined || moduleSymbol === undefined) {
    throw new Error("packed Core root declaration is not an external module");
  }
  const checker = program.getTypeChecker();
  const exportsByName = new Map(
    checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.name, symbol]),
  );
  return Object.fromEntries(
    baselineTouchedRootValues.map((name) => {
      const symbol = exportsByName.get(name);
      if (symbol === undefined) throw new Error(`packed Core root is missing ${name}`);
      return [
        name,
        normalizedPublicSignature(
          checker.typeToString(
            checker.getTypeOfSymbolAtLocation(symbol, sourceFile),
            sourceFile,
            tsRuntime.TypeFormatFlags.NoTruncation |
              tsRuntime.TypeFormatFlags.WriteArrowStyleSignature,
          ),
        ),
      ];
    }),
  );
}

function installedTouchedModulePublicSignatures(): Readonly<Record<string, string>> {
  const declarationPath = join(packageInstallRoot, "dist", "activity.d.ts");
  const options: ts.CompilerOptions = {
    module: tsRuntime.ModuleKind.NodeNext,
    moduleResolution: tsRuntime.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: false,
    strict: true,
    target: tsRuntime.ScriptTarget.ES2023,
    types: [],
  };
  const program = tsRuntime.createProgram({ rootNames: [declarationPath], options });
  const diagnostics = tsRuntime.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) throw new Error(diagnosticsText(diagnostics));
  const sourceFile = program.getSourceFile(declarationPath);
  const moduleSymbol =
    sourceFile === undefined ? undefined : program.getTypeChecker().getSymbolAtLocation(sourceFile);
  if (sourceFile === undefined || moduleSymbol === undefined) {
    throw new Error("packed Core activity declaration is not an external module");
  }
  const checker = program.getTypeChecker();
  const appendActivity = checker
    .getExportsOfModule(moduleSymbol)
    .find((symbol) => symbol.name === "appendActivity");
  if (appendActivity === undefined) {
    throw new Error("packed Core activity declaration is missing appendActivity");
  }
  return {
    "activity#appendActivity": normalizedPublicSignature(
      checker.typeToString(
        checker.getTypeOfSymbolAtLocation(appendActivity, sourceFile),
        sourceFile,
        tsRuntime.TypeFormatFlags.NoTruncation | tsRuntime.TypeFormatFlags.WriteArrowStyleSignature,
      ),
    ),
  };
}

function assertBaselineTouchedPublicSignatures(): void {
  if (
    JSON.stringify(installedTouchedPublicSignatures()) !==
      JSON.stringify(baselineTouchedPublicSignatures) ||
    JSON.stringify(installedTouchedModulePublicSignatures()) !==
      JSON.stringify(baselineTouchedModulePublicSignatures)
  ) {
    throw new Error("packed Core touched public signatures differ from the frozen baseline");
  }
}

async function installedRootRuntimeKeys(): Promise<readonly string[]> {
  const fixturePath = join(consumerRoot, `root-runtime-keys-${Date.now()}.mjs`);
  await writeFile(
    fixturePath,
    'console.log(JSON.stringify(Object.keys(await import("@cellarer/core")).sort()));\n',
    "utf8",
  );
  const { stdout } = await execFileAsync(process.execPath, [fixturePath], { cwd: consumerRoot });
  return JSON.parse(stdout) as string[];
}

async function assertBaselineRootRuntimeExports(): Promise<void> {
  const current = await installedRootRuntimeKeys();
  if (JSON.stringify(current) !== JSON.stringify(baselineRootRuntimeKeys)) {
    throw new Error("packed Core root runtime exports differ from the frozen baseline");
  }
}

function compileConsumer(fixturePath: string, skipLibCheck: boolean): ts.Program {
  const options: ts.CompilerOptions = {
    module: tsRuntime.ModuleKind.NodeNext,
    moduleResolution: tsRuntime.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck,
    strict: true,
    target: tsRuntime.ScriptTarget.ES2023,
    types: [],
  };
  const program = tsRuntime.createProgram({ rootNames: [fixturePath], options });
  const diagnostics = tsRuntime.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) throw new Error(diagnosticsText(diagnostics));
  return program;
}

function coreDiagnosticsWithSourceMutation(
  relativePath: string,
  mutate: (source: string) => string,
): readonly ts.Diagnostic[] {
  const configPath = join(packageRoot, "tsconfig.json");
  const parsed = tsRuntime.getParsedCommandLineOfConfigFile(
    configPath,
    { composite: false, incremental: false, noEmit: true },
    {
      ...tsRuntime.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(diagnosticsText([diagnostic]));
      },
    },
  );
  if (parsed === undefined) throw new Error("failed to parse Core tsconfig");
  if (parsed.errors.length > 0) throw new Error(diagnosticsText(parsed.errors));

  const mutationPath = resolve(packageRoot, relativePath);
  const host = tsRuntime.createCompilerHost(parsed.options);
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) => {
    const source = readFile(fileName);
    if (source === undefined || resolve(fileName) !== mutationPath) return source;
    const mutated = mutate(source);
    if (mutated === source) throw new Error(`mutation did not change ${relativePath}`);
    return mutated;
  };
  const program = tsRuntime.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    host,
  });
  return tsRuntime.getPreEmitDiagnostics(program);
}

describe("@cellarer/core package exports", () => {
  beforeAll(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "cellarer-package-exports-test-"));
    packageStageRoot = join(testRoot, "packages", "core");
    const artifactRoot = join(testRoot, "artifacts");
    consumerRoot = join(testRoot, "consumer");
    packageInstallRoot = join(consumerRoot, "node_modules", "@cellarer", "core");
    portableConsumerRoot = join(testRoot, "portable-consumer");
    portablePackageInstallRoot = join(portableConsumerRoot, "node_modules", "@cellarer", "core");
    await mkdir(packageStageRoot, { recursive: true });
    await mkdir(artifactRoot, { recursive: true });
    await mkdir(packageInstallRoot, { recursive: true });
    await mkdir(portablePackageInstallRoot, { recursive: true });
    await buildCoreInto(packageRoot, packageStageRoot);
    await copyFile(
      join(repositoryRoot, "pnpm-workspace.yaml"),
      join(testRoot, "pnpm-workspace.yaml"),
    );
    await Promise.all(
      ["package.json", "config.json", "README.md", "LICENSE"].map((file) =>
        copyFile(join(packageRoot, file), join(packageStageRoot, file)),
      ),
    );
    const packInvocation = packageManagerInvocation(process.platform, process.env.ComSpec, [
      "pack",
      "--json",
      "--pack-destination",
      artifactRoot,
    ]);
    const { stdout } = await execFileAsync(packInvocation.file, [...packInvocation.args], {
      cwd: packageStageRoot,
    });
    const report = JSON.parse(stdout) as { filename?: string } | Array<{ filename?: string }>;
    const filename = Array.isArray(report) ? report[0]?.filename : report.filename;
    if (filename === undefined) throw new Error("pnpm pack did not report the Core tarball");
    const archivePath = resolve(packageStageRoot, filename);
    await extractPackedArtifact(archivePath, packageInstallRoot);
    await extractPackedArtifact(archivePath, portablePackageInstallRoot);
    const packedManifest = JSON.parse(
      await readFile(join(packageInstallRoot, "package.json"), "utf8"),
    ) as PackageManifest;
    await installWorkspaceDependencyTree(
      [...Object.keys(packedManifest.dependencies ?? {}), "@types/node"],
      join(consumerRoot, "node_modules"),
    );
    packageInstallRoot = await realpath(packageInstallRoot);
    portablePackageInstallRoot = await realpath(portablePackageInstallRoot);
  }, 30_000);

  afterAll(async () => {
    if (testRoot !== undefined) await rm(testRoot, { recursive: true, force: true });
  });

  it("resolves the portable subpath and existing root through Node ESM exports", async () => {
    const fixturePath = join(consumerRoot, "runtime.mjs");
    await writeFile(
      fixturePath,
      `import { CLIENT_API_VERSION, clientSuccess } from "@cellarer/core/client-api";

const result = clientSuccess("req-package-export", { ready: true });
console.log(JSON.stringify({
  portableKeys: Object.keys(await import("@cellarer/core/client-api")).sort(),
  portableVersion: CLIENT_API_VERSION,
  rootEntry: import.meta.resolve("@cellarer/core"),
  rootImported: Object.keys(await import("@cellarer/core")).length > 0,
  result,
}));
`,
      "utf8",
    );

    const { stdout } = await execFileAsync(process.execPath, [fixturePath], {
      cwd: consumerRoot,
    });

    expect(JSON.parse(stdout)).toEqual({
      portableKeys: [
        "CLIENT_API_CONTRACT_ID",
        "CLIENT_API_MAX_INVENTORY_IMPORT_BODY_BYTES",
        "CLIENT_API_MAX_REQUEST_BODY_BYTES",
        "CLIENT_API_VERSION",
        "clientErrorFromMutationConflict",
        "clientFailure",
        "clientSuccess",
        "resolveClientRequestId",
      ],
      portableVersion: "1.0",
      rootEntry: pathToFileURL(join(packageInstallRoot, "dist", "index.js")).href,
      rootImported: true,
      result: {
        apiVersion: "1.0",
        requestId: "req-package-export",
        status: "success",
        warnings: [],
        data: { ready: true },
      },
    });
  });

  it("keeps the complete packed Core root runtime export snapshot", async () => {
    await expect(assertBaselineRootRuntimeExports()).resolves.toBeUndefined();
  });

  it("keeps the complete packed Core root declaration export snapshot", async () => {
    await expect(rootDeclarationInventory()).resolves.toEqual({
      types: baselineRootTypeNames,
      values: baselineRootRuntimeKeys,
    });
  });

  it("omits discovery and scan runtime, declaration, and packed module surfaces", async () => {
    await expect(installedRootRuntimeKeys()).resolves.not.toEqual(
      expect.arrayContaining([
        "applyScan",
        "applyScanMutationPlan",
        "planScanMutation",
        "scanPlan",
        "discoverySummary",
        "discoverySummaryControlPlane",
      ]),
    );
    for (const relativePath of [
      "dist/engine/scan.js",
      "dist/engine/scan.d.ts",
      "dist/resources/discovery.js",
      "dist/resources/discovery.d.ts",
    ]) {
      await expect(access(join(packageInstallRoot, relativePath))).rejects.toThrow();
    }

    const rootFixture = join(consumerRoot, "removed-root-types.mts");
    await writeFile(
      rootFixture,
      `// @ts-expect-error removed discovery and scan exports are not public.
import { discoverySummary, scanPlan, type ScanPlan } from "@cellarer/core";
void [discoverySummary, scanPlan, undefined as unknown as ScanPlan];
`,
      "utf8",
    );
    expect(() => compileConsumer(rootFixture, false)).not.toThrow();

    const portableFixture = join(portableConsumerRoot, "removed-portable-types.mts");
    await writeFile(
      portableFixture,
      `// @ts-expect-error removed discovery and scan DTOs are not browser contracts.
import type { DiscoverySummaryResult, ScanItem, ScanPlan } from "@cellarer/core/client-api";
void (undefined as unknown as DiscoverySummaryResult | ScanItem | ScanPlan);
`,
      "utf8",
    );
    expect(() => compileConsumer(portableFixture, false)).not.toThrow();
  });

  it("keeps legacy adapter type imports and assignments source-compatible", async () => {
    const fixturePath = join(consumerRoot, "legacy-adapter-types.mts");
    await writeFile(
      fixturePath,
      `import {
  renderRules,
  type AgentAdapter,
  type RulesCodec,
  type SkillsCodec,
} from "@cellarer/core";

const rules: RulesCodec = { render: (fragments) => renderRules(fragments) };
const skills: SkillsCodec = { format: "dir" };
const adapter: AgentAdapter = {
  id: "legacy-consumer",
  displayName: "Legacy consumer",
  capabilities: { rules: ["global"], mcp: [], skills: ["global"] },
  rules,
  skills,
  paths: () => ({}),
  detect: async () => ({ installed: false, root: "" }),
};
void adapter;
`,
      "utf8",
    );

    expect(() => compileConsumer(fixturePath, false)).not.toThrow();
  });

  it("enumerates every frozen root value and type export from the touched Core modules", async () => {
    await expect(rootDeclarationInventory(true)).resolves.toEqual({
      types: baselineTouchedRootTypes,
      values: baselineTouchedRootValues,
    });
  });

  it("rejects deletion of an unrelated packed Core root runtime export", async () => {
    const indexPath = join(packageInstallRoot, "dist", "index.js");
    const original = await readFile(indexPath, "utf8");
    const mutated = original.replace(
      "GENERATED_HEADER, isGenerated, renderRules, sourceMarker",
      "GENERATED_HEADER, isGenerated, renderRules",
    );
    if (mutated === original) throw new Error("root runtime deletion mutation did not apply");
    try {
      await writeFile(indexPath, mutated, "utf8");
      await expect(assertBaselineRootRuntimeExports()).rejects.toThrow(
        /root runtime exports differ/u,
      );
    } finally {
      await writeFile(indexPath, original, "utf8");
    }
  });

  it("loads only the explicit portable declaration closure from the packed artifact", async () => {
    const fixturePath = join(portableConsumerRoot, "portable-types.mts");
    await writeFile(
      fixturePath,
      `import {
  CLIENT_API_VERSION,
  clientSuccess,
  type ActivityEvent,
  type Capability,
  type ClientResultEnvelope,
  type ControlPlaneAgentDto,
  type ControlPlaneAgentListDto,
  type ControlPlaneResourceDto,
  type ControlPlaneResourceListDto,
  type DashboardAgentReadiness,
  type DashboardCoverageGroup,
  type DashboardSummaryResult,
  type Destination,
  type DistributePlan,
  type DriftStatus,
  type MutationPlan,
  type ResourceCatalogItem,
  type ResourceCatalogResult,
  type ResourceState,
  type Scope,
  type SettingsSummary,
  type StatusItem,
} from "@cellarer/core/client-api";
// @ts-expect-error Env is a Node runtime contract, not part of the portable API.
import type { Env } from "@cellarer/core/client-api";
// @ts-expect-error FsLike is a Node runtime contract, not part of the portable API.
import type { FsLike } from "@cellarer/core/client-api";
// @ts-expect-error Providers are not part of the portable API.
import type { StoredSecretProvider } from "@cellarer/core/client-api";
// @ts-expect-error Mutation engines are not part of the portable API.
import { apply } from "@cellarer/core/client-api";
// @ts-expect-error Node composition is not part of the portable API.
import { createRealEnv } from "@cellarer/core/client-api";

const portableVersion: "1.0" = CLIENT_API_VERSION;
const result: ClientResultEnvelope<{ ready: true }> = clientSuccess(
  "req-package-types",
  { ready: true },
);
type BrowserClientTypes =
  | ActivityEvent
  | Capability
  | Scope
  | DashboardAgentReadiness
  | DashboardCoverageGroup
  | DashboardSummaryResult
  | Destination
  | ResourceCatalogItem
  | ResourceCatalogResult
  | ControlPlaneAgentDto
  | ControlPlaneAgentListDto
  | ControlPlaneResourceDto
  | ControlPlaneResourceListDto
  | DistributePlan
  | DriftStatus
  | MutationPlan
  | SettingsSummary
  | StatusItem;
type BrowserResourceState = ResourceState;
void [
  portableVersion,
  result,
  undefined as unknown as Env,
  undefined as unknown as FsLike,
  undefined as unknown as StoredSecretProvider,
  apply,
  createRealEnv,
  undefined as unknown as BrowserClientTypes,
  undefined as unknown as BrowserResourceState,
];
`,
      "utf8",
    );

    const program = compileConsumer(fixturePath, false);
    await expect(
      access(join(portableConsumerRoot, "node_modules", "@types", "node", "package.json")),
    ).rejects.toThrow();
    const packagePrefix = `${portablePackageInstallRoot}${sep}`;
    const declarationClosure = program
      .getSourceFiles()
      .map(({ fileName }) => fileName)
      .filter((fileName) => fileName.startsWith(packagePrefix))
      .map((fileName) => relative(portablePackageInstallRoot, fileName).replaceAll(sep, "/"))
      .sort();
    const forbidden = declarationClosure.filter((file) =>
      /(?:^|\/)(?:adapters|engine|secrets|store)(?:\/|\.d\.ts$)|(?:^|\/)env\.d\.ts$|(?:^|\/)real-env\.d\.ts$|(?:^|\/)providers?(?:\/|\.d\.ts$)/u.test(
        file,
      ),
    );

    expect(forbidden).toEqual([]);
    expect(declarationClosure).toEqual(portableDeclarationAllowlist);
  });

  it("rejects a broken internal declaration import in the packed portable artifact", async () => {
    const declarationPath = join(
      portablePackageInstallRoot,
      "dist",
      "protocol",
      "client-types.d.ts",
    );
    const originalDeclaration = await readFile(declarationPath, "utf8");
    const fixturePath = join(portableConsumerRoot, "broken-portable-types.mts");
    await writeFile(
      fixturePath,
      'import type { Capability } from "@cellarer/core/client-api";\nvoid (undefined as unknown as Capability);\n',
      "utf8",
    );
    try {
      await writeFile(
        declarationPath,
        `${originalDeclaration}\nexport type BrokenPortableType = import("./missing-portable-type.js").Missing;\n`,
        "utf8",
      );
      expect(() => compileConsumer(fixturePath, false)).toThrow(/missing-portable-type/u);
    } finally {
      await writeFile(declarationPath, originalDeclaration, "utf8");
    }
  });

  it("keeps the existing Core root declaration compatible with NodeNext", async () => {
    const fixturePath = join(consumerRoot, "root-types.mts");
    await writeFile(
      fixturePath,
      `import { CLIENT_API_VERSION, type Env, type MutationPlan } from "@cellarer/core";
const version: "1.0" = CLIENT_API_VERSION;
void [version, undefined as unknown as Env, undefined as unknown as MutationPlan];
`,
      "utf8",
    );

    expect(() => compileConsumer(fixturePath, false)).not.toThrow();
  });

  it("emits the baseline named return contracts for existing Core root functions", async () => {
    const expected = {
      "activity.d.ts": { appendActivity: "Promise<ActivityEvent>" },
      "control-plane.d.ts": {
        listControlPlaneAgents: "Promise<ControlPlaneAgentListDto>",
        listControlPlaneResources: "Promise<ControlPlaneResourceListDto>",
      },
      "dashboard.d.ts": { dashboardSummary: "Promise<DashboardSummaryResult>" },
      "engine/plan.d.ts": { plan: "Promise<DistributePlan>" },
      "engine/status.d.ts": { status: "Promise<StatusItem[]>" },
      "protocol/canonical.d.ts": { createMutationPlan: "MutationPlan" },
      "resources/catalog.d.ts": { resourceCatalog: "Promise<ResourceCatalogResult>" },
      "settings.d.ts": { settingsSummary: "Promise<SettingsSummary>" },
    } as const;

    for (const [relativePath, signatures] of Object.entries(expected)) {
      const declarationPath = join(packageStageRoot, "dist", relativePath);
      const declaration = tsRuntime.createSourceFile(
        declarationPath,
        await readFile(declarationPath, "utf8"),
        tsRuntime.ScriptTarget.Latest,
        true,
        tsRuntime.ScriptKind.TS,
      );
      const actual = Object.fromEntries(
        declaration.statements.flatMap((statement) =>
          tsRuntime.isFunctionDeclaration(statement) &&
          statement.name !== undefined &&
          statement.type !== undefined &&
          Object.hasOwn(signatures, statement.name.text)
            ? [[statement.name.text, statement.type.getText(declaration)]]
            : [],
        ),
      );
      expect(actual, relativePath).toEqual(signatures);
    }
  });

  it("emits the complete baseline appendActivity parameter and return signature", async () => {
    const declarationPath = join(packageStageRoot, "dist", "activity.d.ts");
    const declaration = tsRuntime.createSourceFile(
      declarationPath,
      await readFile(declarationPath, "utf8"),
      tsRuntime.ScriptTarget.Latest,
      true,
      tsRuntime.ScriptKind.TS,
    );
    const appendActivity = declaration.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        tsRuntime.isFunctionDeclaration(statement) && statement.name?.text === "appendActivity",
    );
    if (appendActivity?.type === undefined) {
      throw new Error("packed activity declaration is missing appendActivity");
    }
    const signature = `(${appendActivity.parameters
      .map((parameter) => parameter.getText(declaration))
      .join(", ")}): ${appendActivity.type.getText(declaration)}`;
    expect(signature).toBe(
      "(env: Env, storeRoot: string, input: ActivityInput): Promise<ActivityEvent>",
    );
  });

  it("matches every frozen public signature from the touched Core modules", () => {
    expect(() => assertBaselineTouchedPublicSignatures()).not.toThrow();
  });

  it("rejects an incompatible required parameter added to a packed root function", async () => {
    const declarationPath = join(packageInstallRoot, "dist", "dashboard.d.ts");
    const original = await readFile(declarationPath, "utf8");
    const mutated = original.replace(
      "opts: DashboardSummaryOptions): Promise<DashboardSummaryResult>",
      "opts: DashboardSummaryOptions, required: string): Promise<DashboardSummaryResult>",
    );
    if (mutated === original) throw new Error("root function parameter mutation did not apply");
    try {
      await writeFile(declarationPath, mutated, "utf8");
      expect(() => assertBaselineTouchedPublicSignatures()).toThrow(
        /touched public signatures differ/u,
      );
    } finally {
      await writeFile(declarationPath, original, "utf8");
    }
  });

  it("rejects parameter drift in the touched appendActivity declaration", async () => {
    const declarationPath = join(packageInstallRoot, "dist", "activity.d.ts");
    const original = await readFile(declarationPath, "utf8");
    const mutated = original.replace(
      "input: ActivityInput): Promise<ActivityEvent>",
      "input: ActivityInput & { required: string }): Promise<ActivityEvent>",
    );
    if (mutated === original) throw new Error("appendActivity parameter mutation did not apply");
    try {
      await writeFile(declarationPath, mutated, "utf8");
      expect(() => assertBaselineTouchedPublicSignatures()).toThrow(
        /touched public signatures differ/u,
      );
    } finally {
      await writeFile(declarationPath, original, "utf8");
    }
  });

  it("rejects deletion of a migrated type-only export from its touched Core module", async () => {
    const declarationPath = join(packageInstallRoot, "dist", "model", "index.d.ts");
    const original = await readFile(declarationPath, "utf8");
    const mutated = original.replace("StoreInputEvidence, ", "");
    if (mutated === original) throw new Error("StoreInputEvidence deletion mutation did not apply");
    const fixturePath = join(consumerRoot, "mutated-type-export-compatibility.mts");
    await writeFile(fixturePath, migratedTypeAvailabilitySource(), "utf8");
    try {
      await writeFile(declarationPath, mutated, "utf8");
      expect(() => compileConsumer(fixturePath, false)).toThrow();
    } finally {
      await writeFile(declarationPath, original, "utf8");
    }
  });
});

describe("portable DTO runtime exactness mutations", () => {
  it.each([
    [
      "an optional field is added to the canonical resource catalog result",
      "src/protocol/client-types.ts",
      (source: string) =>
        source.replace(
          "export interface ResourceCatalogResult {\n  generatedAt: string;",
          "export interface ResourceCatalogResult {\n  traceId?: string;\n  generatedAt: string;",
        ),
      /ExactContract<Awaited<ReturnType<typeof resourceCatalogImplementation>>, ResourceCatalogResult>/u,
    ],
    [
      "an optional field is added to the canonical resource catalog item",
      "src/protocol/client-types.ts",
      (source: string) =>
        source.replace(
          "export interface ResourceCatalogItem {\n  id: string;",
          "export interface ResourceCatalogItem {\n  traceId?: string;\n  id: string;",
        ),
      /ExactContract<ReturnType<typeof catalogItem>, ResourceCatalogItem>/u,
    ],
    [
      "an optional field is added to the canonical dashboard summary",
      "src/protocol/client-types.ts",
      (source: string) =>
        source.replace(
          "export interface DashboardSummaryResult {\n  generatedAt: string;",
          "export interface DashboardSummaryResult {\n  traceId?: string;\n  generatedAt: string;",
        ),
      /ExactContract<Awaited<ReturnType<typeof dashboardSummaryImplementation>>, DashboardSummaryResult>/u,
    ],
    [
      "an optional field is added to the canonical resource control-plane list",
      "src/protocol/client-types.ts",
      (source: string) =>
        source.replace(
          "export interface ControlPlaneResourceListDto {\n  readonly generatedAt: string;",
          "export interface ControlPlaneResourceListDto {\n  readonly traceId?: string;\n  readonly generatedAt: string;",
        ),
      /Awaited<ReturnType<typeof listControlPlaneResourcesImplementation>>/u,
    ],
    [
      "an optional field is added to the canonical resource control-plane DTO",
      "src/protocol/client-types.ts",
      (source: string) =>
        source.replace(
          "export interface ControlPlaneResourceDto {\n  readonly id: string;",
          "export interface ControlPlaneResourceDto {\n  readonly traceId?: string;\n  readonly id: string;",
        ),
      /ExactContract<ReturnType<typeof resourceDto>, ControlPlaneResourceDto>/u,
    ],
    [
      "an optional field is added to the canonical agent control-plane list",
      "src/protocol/client-types.ts",
      (source: string) =>
        source.replace(
          "export interface ControlPlaneAgentListDto {\n  readonly storeRoot: string;",
          "export interface ControlPlaneAgentListDto {\n  readonly traceId?: string;\n  readonly storeRoot: string;",
        ),
      /Awaited<ReturnType<typeof listControlPlaneAgentsImplementation>>/u,
    ],
    [
      "an optional field is added to the canonical agent control-plane DTO",
      "src/protocol/client-types.ts",
      (source: string) =>
        source.replace(
          "export interface ControlPlaneAgentDto {\n  readonly id: string;",
          "export interface ControlPlaneAgentDto {\n  readonly traceId?: string;\n  readonly id: string;",
        ),
      /ExactContract<ReturnType<typeof agentDto>, ControlPlaneAgentDto>/u,
    ],
    [
      "readonly is removed from a canonical control-plane field",
      "src/protocol/client-types.ts",
      (source: string) =>
        source.replace(
          "export interface ControlPlaneResourceListDto {\n  readonly generatedAt: string;",
          "export interface ControlPlaneResourceListDto {\n  generatedAt: string;",
        ),
      /Awaited<ReturnType<typeof listControlPlaneResourcesImplementation>>/u,
    ],
    [
      "readonly is removed from a nested canonical control-plane DTO field",
      "src/protocol/client-types.ts",
      (source: string) =>
        source.replace(
          "export interface ControlPlaneResourceDto {\n  readonly id: string;",
          "export interface ControlPlaneResourceDto {\n  id: string;",
        ),
      /ExactContract<ReturnType<typeof resourceDto>, ControlPlaneResourceDto>/u,
    ],
    [
      "an optional field is added to the canonical distribute plan",
      "src/protocol/client-types.ts",
      (source: string) =>
        source.replace(
          "export interface DistributePlan {\n  actions: PlanAction[];",
          "export interface DistributePlan {\n  traceId?: string;\n  actions: PlanAction[];",
        ),
      /ExactContract<Awaited<ReturnType<typeof planImplementation>>, DistributePlan>/u,
    ],
    [
      "an optional field is added to the canonical mutation plan",
      "src/protocol/client-types.ts",
      (source: string) =>
        source.replace(
          "export interface MutationPlan extends MutationPlanInput {\n  readonly digest: string;",
          "export interface MutationPlan extends MutationPlanInput {\n  readonly traceId?: string;\n  readonly digest: string;",
        ),
      /ExactContract<ReturnType<typeof createMutationPlanImplementation>, MutationPlan>/u,
    ],
    [
      "an optional field is added to the canonical settings summary",
      "src/protocol/client-types.ts",
      (source: string) =>
        source.replace(
          "export interface SettingsSummary {\n  storeRoot: string;",
          "export interface SettingsSummary {\n  traceId?: string;\n  storeRoot: string;",
        ),
      /ExactContract<Awaited<ReturnType<typeof settingsSummaryImplementation>>, SettingsSummary>/u,
    ],
    [
      "an optional field is added to the canonical resource source DTO",
      "src/protocol/client-types.ts",
      (source: string) =>
        source.replace(
          '| { type: "local-snapshot"; capturedFrom?: string }',
          '| { type: "local-snapshot"; capturedFrom?: string; label?: string }',
        ),
      /ExactSchema<typeof resourceSourceDescriptorSchema, ResourceSourceDescriptor>/u,
    ],
    [
      "a field is deleted from the resource source runtime schema",
      "src/resources/model.ts",
      (source: string) =>
        source.replace(
          `    capturedFrom: z
      .string()
      .min(1)
      .refine(
        (value) => scanTextForSecrets(value).length === 0,
        "snapshot source contains secret-like content",
      )
      .optional(),
`,
          "",
        ),
      /ExactSchema<typeof resourceSourceDescriptorSchema, ResourceSourceDescriptor>/u,
    ],
    [
      "the canonical activity action discriminant is widened",
      "src/protocol/client-types.ts",
      (source: string) =>
        source.replace(
          'export type ActivityAction = "apply" | "inventory-import" | "scan-import" | "revert";',
          'export type ActivityAction = "apply" | "inventory-import" | "scan-import" | "revert" | "sync";',
        ),
      /ExactContract<z\.output<typeof activityEventSchema>, ActivityEvent>/u,
    ],
    [
      "the canonical activity action discriminant is narrowed",
      "src/protocol/client-types.ts",
      (source: string) =>
        source.replace(
          'export type ActivityAction = "apply" | "inventory-import" | "scan-import" | "revert";',
          'export type ActivityAction = "apply" | "scan-import";',
        ),
      /ExactContract<z\.output<typeof activityEventSchema>, ActivityEvent>/u,
    ],
    [
      "a required canonical settings default becomes optional",
      "src/protocol/client-types.ts",
      (source: string) =>
        source.replace(
          /(export interface SettingsSummary \{[\s\S]*?defaults: \{\n\s*)method: LinkMethod;/u,
          "$1method?: LinkMethod;",
        ),
      /ExactContract<z\.output<typeof defaultsSchema>, SettingsDefaults>/u,
    ],
    [
      "an optional field is added to the canonical status item",
      "src/protocol/client-types.ts",
      (source: string) =>
        source.replace(
          "export interface StatusItem {\n  artifact: string;",
          "export interface StatusItem {\n  traceId?: string;\n  artifact: string;",
        ),
      /ExactContract<ReturnType<typeof statusItem>, StatusItem>/u,
    ],
    [
      "a canonical status item producer field becomes readonly",
      "src/protocol/client-types.ts",
      (source: string) =>
        source.replace(
          "export interface StatusItem {\n  artifact: string;",
          "export interface StatusItem {\n  readonly artifact: string;",
        ),
      /ExactContract<ReturnType<typeof statusItem>, StatusItem>/u,
    ],
    [
      "the canonical status discriminant is widened",
      "src/protocol/client-types.ts",
      (source: string) =>
        source.replace(
          'export type DriftStatus = "ok" | "drifted" | "missing" | "broken-link";',
          'export type DriftStatus = "ok" | "drifted" | "missing" | "broken-link" | "unknown";',
        ),
      /ExactContract<ReturnType<typeof statusItem>, StatusItem>/u,
    ],
  ])("fails compilation when %s", (_name, relativePath, mutate, expectedContract) => {
    const diagnostics = coreDiagnosticsWithSourceMutation(relativePath, mutate);
    expect(diagnosticsText(diagnostics)).toMatch(expectedContract);
  });
});
