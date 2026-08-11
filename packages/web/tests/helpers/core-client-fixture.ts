import { readFileSync } from "node:fs";
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as ts from "typescript";

const tsRuntime = createRequire(import.meta.url)("typescript") as typeof ts;
const coreSourceRoot = fileURLToPath(new URL("../../../core", import.meta.url));
const webPackageRoot = fileURLToPath(new URL("../..", import.meta.url));
const webClientRoot = join(webPackageRoot, "client");
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const webPackageRequire = createRequire(join(webPackageRoot, "package.json"));

interface PackageManifest {
  readonly name?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

export interface CoreClientFixture {
  readonly browserRoot: string;
  readonly clientTsconfigPath: string;
  readonly consumerRoot: string;
  readonly coreRoot: string;
  readonly htmlEntry: string;
  readonly packageJsonPath: string;
  readonly portableDeclarationPaths: readonly string[];
  readonly portableModulePath: string;
  readonly portableModulePaths: readonly string[];
  readonly portableSourcePaths: readonly string[];
  cleanup(): Promise<void>;
}

const approvedClientApiConditions = {
  types: "./dist/protocol/client.d.ts",
  import: "./dist/protocol/client.js",
  default: "./dist/protocol/client.js",
} as const;

export function assertClientApiExportContract(
  fixture: Pick<CoreClientFixture, "packageJsonPath">,
): void {
  const manifest = JSON.parse(readFileSync(fixture.packageJsonPath, "utf8")) as {
    readonly exports?: Readonly<Record<string, unknown>>;
  };
  const clientApi = manifest.exports?.["./client-api"];
  if (clientApi === null || typeof clientApi !== "object" || Array.isArray(clientApi)) {
    throw new Error("candidate Core package is missing the ./client-api conditional export");
  }
  const conditions = clientApi as Record<string, unknown>;
  for (const [condition, target] of Object.entries(approvedClientApiConditions)) {
    if (!Object.hasOwn(conditions, condition)) {
      throw new Error(`candidate ./client-api export is missing its own ${condition} condition`);
    }
    if (conditions[condition] !== target) {
      throw new Error(
        `candidate ./client-api ${condition} target must equal ${JSON.stringify(target)}`,
      );
    }
  }
}

async function packageRootFor(packageName: string, requireFrom: NodeRequire): Promise<string> {
  let resolvedEntry: string | undefined;
  try {
    resolvedEntry = requireFrom.resolve(packageName);
  } catch {
    // Type-only packages and packages without a root export are found through Node search paths.
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
        // Keep walking to the physical package root.
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

async function copyConsumerDependencyTree(
  packageNames: readonly string[],
  destinationNodeModules: string,
): Promise<void> {
  const installed = new Set<string>();
  const pending = packageNames.map((name) => ({ name, requireFrom: webPackageRequire }));
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
    const childRequire = createRequire(join(sourceRoot, "package.json"));
    pending.push(
      ...Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
      }).map((name) => ({ name, requireFrom: childRequire })),
    );
  }
}

function diagnosticsText(diagnostics: readonly ts.Diagnostic[]): string {
  return tsRuntime.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => repositoryRoot,
    getNewLine: () => "\n",
  });
}

export async function createCoreClientFixture(
  prefix: string,
  portableSourceMutation = "",
  allowDiagnostics = false,
): Promise<CoreClientFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const consumerRoot = join(root, "consumer");
  const browserRoot = join(consumerRoot, "client");
  const nodeModulesRoot = join(consumerRoot, "node_modules");
  const coreRoot = join(nodeModulesRoot, "@cellarer", "core");
  const portableSourceRoot = join(root, "portable-source", "protocol");
  const packageJsonPath = join(coreRoot, "package.json");
  try {
    await mkdir(portableSourceRoot, { recursive: true });
    await mkdir(coreRoot, { recursive: true });
    await copyFile(join(coreSourceRoot, "package.json"), packageJsonPath);
    await cp(webClientRoot, browserRoot, {
      recursive: true,
      dereference: true,
      filter: (source) =>
        source !== join(webClientRoot, "dist") && source !== join(webClientRoot, "vite.config.ts"),
    });
    await writeFile(join(browserRoot, "package.json"), '{"private":true,"type":"module"}\n');
    await copyConsumerDependencyTree(
      ["react", "react-dom", "@types/react", "@types/react-dom"],
      nodeModulesRoot,
    );
    const portableSourcePaths = [
      join(portableSourceRoot, "client-types.ts"),
      join(portableSourceRoot, "client.ts"),
    ];
    await copyFile(
      join(coreSourceRoot, "src", "protocol", "client-types.ts"),
      portableSourcePaths[0] as string,
    );
    const portableSource = await readFile(
      join(coreSourceRoot, "src", "protocol", "client.ts"),
      "utf8",
    );
    await writeFile(
      portableSourcePaths[1] as string,
      `${portableSource}\n${portableSourceMutation}\n`,
      "utf8",
    );
    const parsed = tsRuntime.getParsedCommandLineOfConfigFile(
      join(coreSourceRoot, "tsconfig.json"),
      {
        composite: false,
        declarationMap: false,
        incremental: false,
        outDir: join(coreRoot, "dist"),
        rootDir: join(coreSourceRoot, "src"),
        sourceMap: false,
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
    const compilerHost = tsRuntime.createCompilerHost(parsed.options);
    const readCompilerFile = compilerHost.readFile.bind(compilerHost);
    const portableClientSourcePath = join(coreSourceRoot, "src", "protocol", "client.ts");
    compilerHost.readFile = (fileName) =>
      fileName === portableClientSourcePath
        ? `${portableSource}\n${portableSourceMutation}\n`
        : readCompilerFile(fileName);
    const program = tsRuntime.createProgram({
      rootNames: parsed.fileNames,
      options: parsed.options,
      host: compilerHost,
    });
    const emit = program.emit();
    const diagnostics = [...tsRuntime.getPreEmitDiagnostics(program), ...emit.diagnostics];
    if (diagnostics.length > 0 && !allowDiagnostics) throw new Error(diagnosticsText(diagnostics));
    const portableModulePath = await realpath(join(coreRoot, "dist", "protocol", "client.js"));
    return {
      browserRoot: await realpath(browserRoot),
      clientTsconfigPath: await realpath(join(browserRoot, "tsconfig.json")),
      consumerRoot: await realpath(consumerRoot),
      coreRoot: await realpath(coreRoot),
      htmlEntry: await realpath(join(browserRoot, "index.html")),
      packageJsonPath,
      portableDeclarationPaths: await Promise.all(
        ["client-types.d.ts", "client.d.ts"].map((file) =>
          realpath(join(coreRoot, "dist", "protocol", file)),
        ),
      ),
      portableModulePath,
      portableModulePaths: await Promise.all(
        ["client-types.js", "client.js"].map((file) =>
          realpath(join(coreRoot, "dist", "protocol", file)),
        ),
      ),
      portableSourcePaths: await Promise.all(portableSourcePaths.map((file) => realpath(file))),
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
