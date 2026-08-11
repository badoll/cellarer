import { realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type * as ts from "typescript";
import { build, type Plugin } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertClientApiExportContract,
  type CoreClientFixture,
  createCoreClientFixture,
} from "./helpers/core-client-fixture.js";
import { isPathInside } from "./helpers/path-containment.js";
import {
  portableCoreModuleViolations,
  runtimeGlobalReferenceViolations,
  type SourceModuleEdgeKind,
  sourceModuleEdges,
} from "./helpers/portable-module-guard.js";
import {
  aggregatedRuntimeGlobalMutations,
  lexicalRuntimeGlobalShadows,
} from "./helpers/runtime-global-fixtures.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const productionClientRoot = fileURLToPath(new URL("../client", import.meta.url));
const productionViteConfig = fileURLToPath(new URL("../client/vite.config.ts", import.meta.url));
const corePackageRoot = await realpath(fileURLToPath(new URL("../../core", import.meta.url)));
const tsRuntime = createRequire(import.meta.url)("typescript") as typeof ts;
const approvedCoreSpecifier = "@cellarer/core/client-api";

function diagnosticsText(diagnostics: readonly ts.Diagnostic[]): string {
  return tsRuntime.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => repositoryRoot,
    getNewLine: () => "\n",
  });
}

describe("path containment", () => {
  it.each([
    ["same path", "C:\\repo\\core", "C:\\repo\\core", true],
    ["descendant", "C:\\repo\\core", "C:\\repo\\core\\dist\\client.js", true],
    ["parent", "C:\\repo\\core", "C:\\repo", false],
    ["sibling prefix", "C:\\repo\\core", "C:\\repo\\core-other\\client.js", false],
    ["different drive", "C:\\repo\\core", "D:\\repo\\core\\client.js", false],
  ])("classifies a Windows %s without treating ..\\ as contained", (_name, root, path, inside) => {
    expect(isPathInside(path, root, win32)).toBe(inside);
  });

  it("builds the portable module from current Core source outside shared dist", async () => {
    const fixture = await createCoreClientFixture("cellarer-core-client-red-");
    try {
      expect(isPathInside(fixture.portableModulePath, fixture.coreRoot)).toBe(true);
      expect(isPathInside(fixture.portableModulePath, corePackageRoot)).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });
});

interface BrowserImportViolation {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

interface BrowserImportSpecifier {
  readonly kind: SourceModuleEdgeKind;
  readonly line: number;
  readonly text: string;
}

interface ResolvedBrowserImport extends BrowserImportSpecifier {
  readonly resolvedId?: string;
}

function unapprovedCoreSpecifierReason(specifier: string): string | undefined {
  if (specifier === "@cellarer/core") return "Node-only Core root import";
  return specifier.startsWith("@cellarer/core/") && specifier !== approvedCoreSpecifier
    ? "Unapproved Core package import"
    : undefined;
}

function sourceLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function normalizedViteModulePath(id: string): string {
  const normalizedId = id
    .replace(/^\/@id\/__x00__/u, "")
    .replace(/^\0/u, "")
    .replaceAll("\\", "/");
  const cleanId = normalizedId.split(/[?#]/u, 1)[0] ?? normalizedId;
  return cleanId.startsWith("/@fs/") ? cleanId.slice(4) : cleanId;
}

const browserExecutableExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const browserNonExecutableExtensions = new Set([
  ".avif",
  ".css",
  ".gif",
  ".html",
  ".ico",
  ".jpeg",
  ".jpg",
  ".json",
  ".less",
  ".png",
  ".sass",
  ".scss",
  ".styl",
  ".stylus",
  ".svg",
  ".wasm",
  ".webp",
]);

function scriptKind(id: string): ts.ScriptKind {
  if (/[?&]html-proxy\b/u.test(id)) return tsRuntime.ScriptKind.JS;
  switch (extname(normalizedViteModulePath(id))) {
    case ".cjs":
    case ".js":
    case ".mjs":
      return tsRuntime.ScriptKind.JS;
    case ".jsx":
      return tsRuntime.ScriptKind.JSX;
    case ".cts":
    case ".mts":
    case ".ts":
      return tsRuntime.ScriptKind.TS;
    case ".tsx":
      return tsRuntime.ScriptKind.TSX;
    default:
      throw new Error(`unsupported browser module extension: ${id}`);
  }
}

function inspectModuleSource(
  file: string,
  source: string,
  sourceLineOffset = 0,
): {
  readonly specifiers: readonly BrowserImportSpecifier[];
  readonly violations: readonly BrowserImportViolation[];
} {
  const specifiers: BrowserImportSpecifier[] = [];
  const violations: BrowserImportViolation[] = [];
  const sourceFile = tsRuntime.createSourceFile(
    file,
    source,
    tsRuntime.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );
  for (const edge of sourceModuleEdges(source, sourceFile, sourceLineOffset)) {
    specifiers.push(edge);
    const reason = unapprovedCoreSpecifierReason(edge.text);
    if (reason !== undefined) violations.push({ file, line: edge.line, reason });
  }
  const requireReasons = new Map<number, string>();
  const visit = (node: ts.Node): void => {
    if (tsRuntime.isImportEqualsDeclaration(node)) {
      const specifierNode = tsRuntime.isExternalModuleReference(node.moduleReference)
        ? node.moduleReference.expression
        : undefined;
      const coreReason =
        specifierNode !== undefined && tsRuntime.isStringLiteral(specifierNode)
          ? unapprovedCoreSpecifierReason(specifierNode.text)
          : undefined;
      violations.push({
        file,
        line: sourceLine(sourceFile, node) + sourceLineOffset,
        reason: coreReason ?? "TypeScript import-equals in browser source",
      });
    } else if (tsRuntime.isExportAssignment(node) && node.isExportEquals) {
      violations.push({
        file,
        line: sourceLine(sourceFile, node) + sourceLineOffset,
        reason: "TypeScript export-equals in browser source",
      });
    } else if (tsRuntime.isImportTypeNode(node)) {
      const specifierNode = tsRuntime.isLiteralTypeNode(node.argument)
        ? node.argument.literal
        : undefined;
      if (
        specifierNode === undefined ||
        (!tsRuntime.isStringLiteral(specifierNode) &&
          !tsRuntime.isNoSubstitutionTemplateLiteral(specifierNode))
      ) {
        violations.push({
          file,
          line: sourceLine(sourceFile, node) + sourceLineOffset,
          reason: "non-literal TypeScript import type in browser source",
        });
      }
    } else if (
      tsRuntime.isCallExpression(node) &&
      node.expression.kind === tsRuntime.SyntaxKind.ImportKeyword
    ) {
      const specifierNode = node.arguments[0];
      if (
        specifierNode === undefined ||
        (!tsRuntime.isStringLiteral(specifierNode) &&
          !tsRuntime.isNoSubstitutionTemplateLiteral(specifierNode))
      ) {
        violations.push({
          file,
          line: sourceLine(sourceFile, node) + sourceLineOffset,
          reason: "non-literal dynamic import in browser source",
        });
      }
    } else if (
      tsRuntime.isCallExpression(node) &&
      tsRuntime.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      const specifierNode = node.arguments[0];
      const coreReason =
        specifierNode !== undefined &&
        (tsRuntime.isStringLiteral(specifierNode) ||
          tsRuntime.isNoSubstitutionTemplateLiteral(specifierNode))
          ? unapprovedCoreSpecifierReason(specifierNode.text)
          : undefined;
      const reason =
        coreReason ??
        (specifierNode !== undefined &&
        (tsRuntime.isStringLiteral(specifierNode) ||
          tsRuntime.isNoSubstitutionTemplateLiteral(specifierNode))
          ? "CommonJS require in browser source"
          : "non-literal require in browser source");
      requireReasons.set(sourceLine(sourceFile, node) + sourceLineOffset, reason);
    }
    tsRuntime.forEachChild(node, visit);
  };
  visit(sourceFile);
  violations.push(
    ...runtimeGlobalReferenceViolations(file, sourceFile, sourceLineOffset).map((violation) => ({
      ...violation,
      reason:
        violation.reason === "CommonJS require"
          ? (requireReasons.get(violation.line) ?? violation.reason)
          : violation.reason,
    })),
  );
  return { specifiers, violations };
}

async function realModulePath(id: string): Promise<string | undefined> {
  const filesystemPath = normalizedViteModulePath(id);
  if (!isAbsolute(filesystemPath)) return undefined;
  try {
    return await realpath(filesystemPath);
  } catch {
    return undefined;
  }
}

function firstPartyModulePath(id: string, browserRoot: string): string | undefined {
  const cleanId = normalizedViteModulePath(id);
  if (!isAbsolute(cleanId) || !isPathInside(cleanId, browserRoot)) return undefined;
  const relativePath = relative(browserRoot, cleanId);
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("node_modules")) {
    return undefined;
  }
  return cleanId;
}

function browserModuleId(id: string, browserRoot: string, htmlEntry: string): string | undefined {
  const normalizedId = id.replaceAll("\\", "/");
  const cleanId = firstPartyModulePath(id, browserRoot);
  if (cleanId === undefined) return undefined;
  const normalizedHtmlEntry = htmlEntry.replaceAll("\\", "/");
  if (cleanId === normalizedHtmlEntry && /[?&]html-proxy\b/u.test(normalizedId)) {
    return normalizedId;
  }
  return browserExecutableExtensions.has(extname(cleanId)) ? cleanId : undefined;
}

interface SourceResolutionContext {
  readonly configDirectory: string;
  readonly moduleResolutionCache: ts.ModuleResolutionCache;
  readonly options: ts.CompilerOptions;
  readonly typeReferenceDirectiveResolutionCache: ts.TypeReferenceDirectiveResolutionCache;
}

function createSourceResolutionContext(configPath: string): SourceResolutionContext {
  const readResult = tsRuntime.readConfigFile(configPath, tsRuntime.sys.readFile);
  if (readResult.error !== undefined) throw new Error(diagnosticsText([readResult.error]));
  const configDirectory = dirname(configPath);
  const parsed = tsRuntime.parseJsonConfigFileContent(
    readResult.config,
    tsRuntime.sys,
    configDirectory,
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) throw new Error(diagnosticsText(parsed.errors));
  const canonicalFileName = tsRuntime.sys.useCaseSensitiveFileNames
    ? (fileName: string) => fileName
    : (fileName: string) => fileName.toLowerCase();
  return {
    configDirectory,
    moduleResolutionCache: tsRuntime.createModuleResolutionCache(
      configDirectory,
      canonicalFileName,
      parsed.options,
    ),
    options: parsed.options,
    typeReferenceDirectiveResolutionCache: tsRuntime.createTypeReferenceDirectiveResolutionCache(
      configDirectory,
      canonicalFileName,
      parsed.options,
    ),
  };
}

function typescriptModuleResolution(
  specifier: string,
  importer: string,
  context: SourceResolutionContext,
  options = context.options,
): string | undefined {
  const cleanSpecifier = specifier.split(/[?#]/u, 1)[0] ?? specifier;
  return tsRuntime.resolveModuleName(
    cleanSpecifier,
    normalizedViteModulePath(importer),
    options,
    tsRuntime.sys,
    options === context.options ? context.moduleResolutionCache : undefined,
  ).resolvedModule?.resolvedFileName;
}

function isRelativeOrAbsoluteSpecifier(specifier: string): boolean {
  const cleanSpecifier = specifier.split(/[?#]/u, 1)[0] ?? specifier;
  return cleanSpecifier.startsWith(".") || isAbsolute(cleanSpecifier);
}

function isDependencyPath(path: string): boolean {
  return path.split(/[\\/]/u).includes("node_modules");
}

function wildcardMatch(pattern: string, specifier: string): string | undefined {
  const wildcard = pattern.indexOf("*");
  if (wildcard === -1) return pattern === specifier ? "" : undefined;
  const prefix = pattern.slice(0, wildcard);
  const suffix = pattern.slice(wildcard + 1);
  return specifier.startsWith(prefix) && specifier.endsWith(suffix)
    ? specifier.slice(prefix.length, specifier.length - suffix.length)
    : undefined;
}

function isConfiguredAlias(specifier: string, context: SourceResolutionContext): boolean {
  const cleanSpecifier = specifier.split(/[?#]/u, 1)[0] ?? specifier;
  if (cleanSpecifier.startsWith(".") || isAbsolute(cleanSpecifier)) return false;
  return (
    Object.keys(context.options.paths ?? {}).some(
      (pattern) => wildcardMatch(pattern, cleanSpecifier) !== undefined,
    ) || context.options.baseUrl !== undefined
  );
}

function isFirstPartySourcePath(path: string): boolean {
  return !isDependencyPath(path);
}

async function independentExternalPackageResolution(
  specifier: string,
  importer: string,
  context: SourceResolutionContext,
): Promise<string | undefined> {
  if (isRelativeOrAbsoluteSpecifier(specifier)) return undefined;
  const resolvedId = typescriptModuleResolution(specifier, importer, context, {
    ...context.options,
    baseUrl: undefined,
    paths: undefined,
  });
  if (resolvedId === undefined) return undefined;
  const resolvedPath = await realModulePath(resolvedId);
  return resolvedPath !== undefined && isDependencyPath(resolvedPath) ? resolvedId : undefined;
}

function deduplicateBrowserViolations(
  violations: readonly BrowserImportViolation[],
): readonly BrowserImportViolation[] {
  const keys = new Set<string>();
  return violations.filter((violation) => {
    const key = `${violation.file}\0${violation.line}\0${violation.reason}`;
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

async function inspectBrowserGraph(
  htmlEntry: string,
  coreFixture: CoreClientFixture,
  configFile: string | false = false,
  additionalPlugins: readonly Plugin[] = [],
): Promise<{
  readonly files: readonly string[];
  readonly resolvedClientApiRuntimePaths: readonly string[];
  readonly violations: readonly BrowserImportViolation[];
}> {
  const resolvedHtmlEntry = await realpath(htmlEntry);
  const browserRoot = dirname(resolvedHtmlEntry);
  const sourceResolution = createSourceResolutionContext(coreFixture.clientTsconfigPath);
  const importsByModule = new Map<string, readonly string[]>();
  const resolvedClientApiRuntimePaths = new Set<string>();
  const inspectionByModule = new Map<
    string,
    {
      readonly resolved: readonly ResolvedBrowserImport[];
      readonly violations: readonly BrowserImportViolation[];
    }
  >();
  const inspectionFailures = new Map<string, string>();
  const sourceClosureViolations: BrowserImportViolation[] = [];
  const captureBrowserGraph: Plugin = {
    name: "capture-browser-source-graph",
    enforce: "pre",
    async transform(source, id) {
      let inspection: ReturnType<typeof inspectModuleSource>;
      try {
        inspection = inspectModuleSource(id, source);
      } catch (error) {
        inspectionFailures.set(id, error instanceof Error ? error.message : String(error));
        return null;
      }
      const resolved = await Promise.all(
        inspection.specifiers.map(async (specifier) => {
          let resolvedId: string | undefined;
          if (unapprovedCoreSpecifierReason(specifier.text) !== undefined) {
            resolvedId = undefined;
          } else if (specifier.kind === "triple-slash-path") {
            resolvedId = tsRuntime.resolveTripleslashReference(
              specifier.text,
              normalizedViteModulePath(id),
            );
          } else if (specifier.kind === "triple-slash-types") {
            resolvedId = tsRuntime.resolveTypeReferenceDirective(
              specifier.text,
              normalizedViteModulePath(id),
              sourceResolution.options,
              tsRuntime.sys,
              undefined,
              sourceResolution.typeReferenceDirectiveResolutionCache,
            ).resolvedTypeReferenceDirective?.resolvedFileName;
          } else if (specifier.kind === "module") {
            resolvedId = (await this.resolve(specifier.text, id))?.id;
          }
          return { ...specifier, resolvedId };
        }),
      );
      inspectionByModule.set(id, { resolved, violations: inspection.violations });
    },
    async generateBundle() {
      for (const id of this.getModuleIds()) {
        const info = this.getModuleInfo(id);
        importsByModule.set(id, [
          ...(info?.importedIds ?? []),
          ...(info?.dynamicallyImportedIds ?? []),
        ]);
      }

      const normalizedHtmlEntry = resolvedHtmlEntry.replaceAll("\\", "/");
      const htmlModuleId = [...importsByModule.keys()].find(
        (id) => (id.split(/[?#]/u, 1)[0] ?? id).replaceAll("\\", "/") === normalizedHtmlEntry,
      );
      if (htmlModuleId === undefined) return;
      const runtimeClosure = new Set<string>();
      const pendingRuntimeModules = [htmlModuleId];
      while (pendingRuntimeModules.length > 0) {
        const id = pendingRuntimeModules.pop();
        if (id === undefined || runtimeClosure.has(id)) continue;
        runtimeClosure.add(id);
        pendingRuntimeModules.push(...(importsByModule.get(id) ?? []));
      }

      interface PendingSourceModule {
        readonly file: string;
        readonly inspection?: ReturnType<typeof inspectModuleSource>;
        readonly key: string;
        readonly reportOwnViolations: boolean;
      }
      const pendingSourceModules: PendingSourceModule[] = [];
      for (const id of runtimeClosure) {
        const modulePath = await realModulePath(id);
        const inspection = inspectionByModule.get(id);
        if (
          modulePath === undefined ||
          isDependencyPath(modulePath) ||
          (inspection === undefined && browserNonExecutableExtensions.has(extname(modulePath))) ||
          [coreFixture.coreRoot, corePackageRoot].some((root) => isPathInside(modulePath, root))
        ) {
          continue;
        }
        pendingSourceModules.push({
          file: id,
          ...(inspection === undefined
            ? {}
            : {
                inspection: {
                  specifiers: inspection.resolved,
                  violations: inspection.violations,
                },
              }),
          key: `runtime:${id}`,
          reportOwnViolations: firstPartyModulePath(id, browserRoot) === undefined,
        });
      }

      const inspectedSourceModules = new Set<string>();
      while (pendingSourceModules.length > 0) {
        const pendingModule = pendingSourceModules.pop();
        if (pendingModule === undefined || inspectedSourceModules.has(pendingModule.key)) continue;
        inspectedSourceModules.add(pendingModule.key);
        const modulePath = await realModulePath(pendingModule.file);
        if (modulePath === undefined) continue;

        let inspection = pendingModule.inspection;
        if (inspection === undefined) {
          try {
            inspection = inspectModuleSource(modulePath, await readFile(modulePath, "utf8"));
          } catch (error) {
            if (pendingModule.reportOwnViolations) {
              sourceClosureViolations.push({
                file: modulePath,
                line: 1,
                reason: `uninspectable first-party source/type module: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              });
            }
            continue;
          }
        }
        if (pendingModule.reportOwnViolations) {
          sourceClosureViolations.push(
            ...inspection.violations.map((violation) => ({ ...violation, file: modulePath })),
          );
        }

        for (const edge of inspection.specifiers) {
          if (edge.kind === "triple-slash-lib") continue;
          if (unapprovedCoreSpecifierReason(edge.text) !== undefined) continue;

          let resolvedId: string | undefined;
          if (edge.kind === "triple-slash-path") {
            resolvedId = tsRuntime.resolveTripleslashReference(edge.text, modulePath);
          } else if (edge.kind === "triple-slash-types") {
            resolvedId = tsRuntime.resolveTypeReferenceDirective(
              edge.text,
              modulePath,
              sourceResolution.options,
              tsRuntime.sys,
              undefined,
              sourceResolution.typeReferenceDirectiveResolutionCache,
            ).resolvedTypeReferenceDirective?.resolvedFileName;
          } else {
            const configuredAlias = isConfiguredAlias(edge.text, sourceResolution);
            const typescriptResolvedId = typescriptModuleResolution(
              edge.text,
              modulePath,
              sourceResolution,
            );
            const typescriptResolvedPath =
              typescriptResolvedId === undefined
                ? undefined
                : await realModulePath(typescriptResolvedId);
            if (
              typescriptResolvedPath !== undefined &&
              isFirstPartySourcePath(typescriptResolvedPath)
            ) {
              resolvedId = typescriptResolvedId;
            } else if (configuredAlias) {
              resolvedId = await independentExternalPackageResolution(
                edge.text,
                modulePath,
                sourceResolution,
              );
            } else {
              resolvedId =
                (await this.resolve(edge.text, pendingModule.file))?.id ?? typescriptResolvedId;
            }
          }

          const importedPath =
            resolvedId === undefined ? undefined : await realModulePath(resolvedId);
          if (importedPath === undefined) {
            if (
              edge.kind !== "module" ||
              isRelativeOrAbsoluteSpecifier(edge.text) ||
              isConfiguredAlias(edge.text, sourceResolution)
            ) {
              sourceClosureViolations.push({
                file: modulePath,
                line: edge.line,
                reason: "unresolvable first-party source/type edge",
              });
            }
            continue;
          }

          if (
            [coreFixture.coreRoot, corePackageRoot].some((root) => isPathInside(importedPath, root))
          ) {
            if (
              edge.text !== approvedCoreSpecifier ||
              (importedPath !== coreFixture.portableModulePath &&
                !coreFixture.portableDeclarationPaths.includes(importedPath))
            ) {
              sourceClosureViolations.push({
                file: modulePath,
                line: edge.line,
                reason: "Unapproved Core package import",
              });
            }
            continue;
          }

          if (
            !isDependencyPath(importedPath) &&
            browserExecutableExtensions.has(extname(importedPath))
          ) {
            pendingSourceModules.push({
              file: importedPath,
              key: importedPath,
              reportOwnViolations: true,
            });
          }
        }
      }
    },
  };

  let buildFailure: unknown;
  try {
    await build({
      configFile,
      root: browserRoot,
      logLevel: "silent",
      build: { write: false },
      plugins: [...additionalPlugins, captureBrowserGraph],
    });
  } catch (error) {
    buildFailure = error;
  }

  const normalizedHtmlEntry = resolvedHtmlEntry.replaceAll("\\", "/");
  const htmlModuleId = [...importsByModule.keys()].find(
    (id) => (id.split(/[?#]/u, 1)[0] ?? id).replaceAll("\\", "/") === normalizedHtmlEntry,
  );
  if (htmlModuleId === undefined) {
    if (buildFailure !== undefined) throw buildFailure;
    throw new Error("browser architecture gate could not identify the real Vite HTML entry");
  }
  const graphClosure = new Set<string>();
  const pending = [htmlModuleId];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || graphClosure.has(id)) continue;
    graphClosure.add(id);
    pending.push(...(importsByModule.get(id) ?? []));
  }

  const files: string[] = [];
  const violations: BrowserImportViolation[] = [];
  for (const id of graphClosure) {
    const firstPartyPath = firstPartyModulePath(id, browserRoot);
    const file = browserModuleId(id, browserRoot, resolvedHtmlEntry);
    const inspection = inspectionByModule.get(id);
    if (firstPartyPath !== undefined && !/[?&]html-proxy\b/u.test(id)) {
      try {
        await realpath(firstPartyPath);
      } catch {
        violations.push({
          file: firstPartyPath,
          line: 1,
          reason: "unresolvable first-party executable module",
        });
        continue;
      }
    }
    if (file === undefined || inspection === undefined) {
      if (
        firstPartyPath !== undefined &&
        !browserNonExecutableExtensions.has(extname(firstPartyPath))
      ) {
        const failure = inspectionFailures.get(id);
        violations.push({
          file: firstPartyPath,
          line: 1,
          reason:
            failure === undefined
              ? "uninspected first-party executable module"
              : `uninspectable first-party executable module: ${failure}`,
        });
      }
      continue;
    }
    files.push(file);
    violations.push(...inspection.violations.map((violation) => ({ ...violation, file })));
    for (const imported of inspection.resolved) {
      if (unapprovedCoreSpecifierReason(imported.text) !== undefined) continue;
      const importedPath =
        imported.resolvedId === undefined ? undefined : await realModulePath(imported.resolvedId);
      if (
        imported.kind.startsWith("triple-slash-") &&
        (imported.kind === "triple-slash-lib" || importedPath === undefined)
      ) {
        violations.push({
          file,
          line: imported.line,
          reason: `unresolvable ${imported.kind.replaceAll("-", " ")} reference`,
        });
        continue;
      }
      if (importedPath === undefined) continue;
      if (
        imported.kind === "module" &&
        imported.text === approvedCoreSpecifier &&
        importedPath === coreFixture.portableModulePath
      ) {
        resolvedClientApiRuntimePaths.add(importedPath);
      }
      if (
        ![coreFixture.coreRoot, corePackageRoot].some((root) => isPathInside(importedPath, root))
      ) {
        continue;
      }
      if (
        imported.text === approvedCoreSpecifier &&
        (importedPath === coreFixture.portableModulePath ||
          coreFixture.portableDeclarationPaths.includes(importedPath))
      ) {
        continue;
      }
      violations.push({
        file,
        line: imported.line,
        reason: "Unapproved Core package import",
      });
    }
  }
  violations.push(...(await portableCoreModuleViolations(coreFixture)));
  violations.push(...sourceClosureViolations);
  if (buildFailure !== undefined && violations.length === 0) throw buildFailure;

  return {
    files: [...new Set(files)].sort(),
    resolvedClientApiRuntimePaths: [...resolvedClientApiRuntimePaths].sort(),
    violations: deduplicateBrowserViolations(violations),
  };
}

async function virtualExtensionMutationGraph(
  extension: ".cellarer" | ".cjs" | ".cts" | ".mjs" | ".mts",
  source: string,
  coreFixture: CoreClientFixture,
  writeBackingFile = true,
): Promise<readonly BrowserImportViolation[]> {
  const root = await mkdtemp(join(coreFixture.consumerRoot, "web-virtual-extension-mutation-"));
  const virtualSpecifier = "virtual:cellarer-executable-mutation";
  const virtualPath = join(root, `mutation${extension}`);
  const virtualId = `\0${virtualPath}?cellarer-virtual`;
  try {
    await writeFile(
      join(root, "index.html"),
      '<script type="module" src="/main.ts"></script>\n',
      "utf8",
    );
    await writeFile(join(root, "main.ts"), `import ${JSON.stringify(virtualSpecifier)};\n`, "utf8");
    if (writeBackingFile) await writeFile(virtualPath, source, "utf8");
    const virtualModule: Plugin = {
      name: "virtual-cellarer-executable-mutation",
      resolveId(id) {
        return id === virtualSpecifier ? virtualId : null;
      },
      load(id) {
        return id === virtualId ? source : null;
      },
    };
    return (
      await inspectBrowserGraph(join(root, "index.html"), coreFixture, false, [virtualModule])
    ).violations;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function mutationGraph(
  source: string,
  coreFixture: CoreClientFixture,
): Promise<readonly BrowserImportViolation[]> {
  const root = await mkdtemp(join(coreFixture.consumerRoot, "web-import-mutation-"));
  try {
    await writeFile(
      join(root, "index.html"),
      '<script type="module" src="/main.ts"></script>\n',
      "utf8",
    );
    await writeFile(join(root, "main.ts"), 'import "./mutation.js";\n', "utf8");
    await writeFile(join(root, "mutation.ts"), source, "utf8");
    return (await inspectBrowserGraph(join(root, "index.html"), coreFixture)).violations;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function recursiveSourceMutationGraph(
  files: Readonly<Record<string, string>>,
  coreFixture: CoreClientFixture,
): Promise<readonly BrowserImportViolation[]> {
  const root = await mkdtemp(join(coreFixture.consumerRoot, "web-recursive-source-mutation-"));
  try {
    await writeFile(
      join(root, "index.html"),
      '<script type="module" src="/main.ts"></script>\n',
      "utf8",
    );
    await writeFile(join(root, "main.ts"), 'import "./runtime.js";\n', "utf8");
    for (const [file, source] of Object.entries(files)) {
      const filePath = join(root, file);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, source, "utf8");
    }
    return (await inspectBrowserGraph(join(root, "index.html"), coreFixture)).violations;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function tsconfigAliasedTypeMutationGraph(
  files: Readonly<Record<string, string>>,
  coreFixture: CoreClientFixture,
  resolution: "baseUrl" | "paths" = "paths",
  misresolveViteAlias = false,
): Promise<readonly BrowserImportViolation[]> {
  const root = await mkdtemp(join(coreFixture.browserRoot, ".cellarer-tsconfig-alias-mutation-"));
  const originalTsconfig = await readFile(coreFixture.clientTsconfigPath, "utf8");
  try {
    await writeFile(
      join(root, "index.html"),
      '<script type="module" src="/runtime.ts"></script>\n',
      "utf8",
    );
    for (const [file, source] of Object.entries(files)) {
      const filePath = join(root, file);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, source, "utf8");
    }
    const tsconfig = JSON.parse(originalTsconfig) as {
      compilerOptions?: Record<string, unknown>;
    };
    tsconfig.compilerOptions =
      resolution === "paths"
        ? {
            ...tsconfig.compilerOptions,
            baseUrl: ".",
            paths: { "@client/*": [`./${basename(root)}/*`] },
          }
        : {
            ...tsconfig.compilerOptions,
            baseUrl: `./${basename(root)}`,
          };
    await writeFile(
      coreFixture.clientTsconfigPath,
      `${JSON.stringify(tsconfig, null, 2)}\n`,
      "utf8",
    );
    const safeAliasPath = join(root, "vite-safe.ts");
    await writeFile(safeAliasPath, "export type Hidden = string;\n", "utf8");
    const viteAliasFallback: Plugin = {
      name: "misresolved-type-only-tsconfig-alias",
      resolveId(id) {
        return misresolveViteAlias &&
          (id.startsWith("@client/") ||
            ["missing.js", "root.cjs", "root.js", "root.mjs"].includes(id))
          ? safeAliasPath
          : null;
      },
    };
    return (
      await inspectBrowserGraph(join(root, "index.html"), coreFixture, false, [viteAliasFallback])
    ).violations;
  } finally {
    await writeFile(coreFixture.clientTsconfigPath, originalTsconfig, "utf8");
    await rm(root, { recursive: true, force: true });
  }
}

interface OutOfRootAliasFixtureOptions {
  readonly baseUrl?: "shared-parent";
  readonly paths?: Readonly<Record<string, readonly string[]>>;
  readonly safeViteFallbackSpecifiers?: readonly string[];
}

async function outOfRootAliasedTypeMutationGraph(
  files: Readonly<Record<string, string>>,
  coreFixture: CoreClientFixture,
  options: OutOfRootAliasFixtureOptions,
): Promise<readonly BrowserImportViolation[]> {
  const root = await mkdtemp(join(coreFixture.consumerRoot, "web-out-of-root-alias-mutation-"));
  const browserRoot = join(root, "browser");
  const sharedRoot = join(root, "shared");
  const originalTsconfig = await readFile(coreFixture.clientTsconfigPath, "utf8");
  try {
    await mkdir(browserRoot, { recursive: true });
    await writeFile(
      join(browserRoot, "index.html"),
      '<script type="module" src="/runtime.ts"></script>\n',
      "utf8",
    );
    for (const [file, source] of Object.entries(files)) {
      const filePath = join(file === "runtime.ts" ? browserRoot : sharedRoot, file);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, source, "utf8");
    }
    const tsconfig = JSON.parse(originalTsconfig) as {
      compilerOptions?: Record<string, unknown>;
    };
    const configuredPaths = Object.fromEntries(
      Object.entries(options.paths ?? {}).map(([pattern, targets]) => [
        pattern,
        targets.map((target) => join(sharedRoot, target)),
      ]),
    );
    tsconfig.compilerOptions = {
      ...tsconfig.compilerOptions,
      ...(options.baseUrl === "shared-parent" ? { baseUrl: root } : {}),
      ...(Object.keys(configuredPaths).length > 0 ? { paths: configuredPaths } : {}),
    };
    await writeFile(
      coreFixture.clientTsconfigPath,
      `${JSON.stringify(tsconfig, null, 2)}\n`,
      "utf8",
    );
    const safeAliasPath = join(browserRoot, "vite-safe.ts");
    await writeFile(safeAliasPath, "export type Hidden = string;\n", "utf8");
    const viteAliasFallback: Plugin = {
      name: "misresolved-out-of-root-type-only-alias",
      resolveId(id) {
        return options.safeViteFallbackSpecifiers?.includes(id) === true ? safeAliasPath : null;
      },
    };
    return (
      await inspectBrowserGraph(join(browserRoot, "index.html"), coreFixture, false, [
        viteAliasFallback,
      ])
    ).violations;
  } finally {
    await writeFile(coreFixture.clientTsconfigPath, originalTsconfig, "utf8");
    await rm(root, { recursive: true, force: true });
  }
}

async function divergentOutOfRootRuntimeMutationGraph(
  typescriptSource: string,
  viteSource: string,
  coreFixture: CoreClientFixture,
  options: {
    readonly resolution?: "baseUrl" | "paths";
    readonly viteTargetUnderNodeModules?: boolean;
  } = {},
): Promise<readonly BrowserImportViolation[]> {
  const root = await mkdtemp(join(coreFixture.consumerRoot, "web-divergent-runtime-mutation-"));
  const browserRoot = join(root, "browser");
  const sharedRoot = join(root, "shared");
  const typescriptTarget = join(sharedRoot, "typescript-target.ts");
  const viteTarget =
    options.viteTargetUnderNodeModules === true
      ? join(root, "node_modules", "controlled-external", "index.js")
      : join(sharedRoot, "vite-target.js");
  const alias =
    options.resolution === "baseUrl" ? "shared/typescript-target.js" : "@runtime/target.js";
  const originalTsconfig = await readFile(coreFixture.clientTsconfigPath, "utf8");
  try {
    await mkdir(browserRoot, { recursive: true });
    await mkdir(sharedRoot, { recursive: true });
    await mkdir(dirname(viteTarget), { recursive: true });
    await writeFile(
      join(browserRoot, "index.html"),
      '<script type="module" src="/runtime.ts"></script>\n',
      "utf8",
    );
    await writeFile(
      join(browserRoot, "runtime.ts"),
      `import { value } from ${JSON.stringify(alias)}; void value;\n`,
      "utf8",
    );
    await writeFile(typescriptTarget, typescriptSource, "utf8");
    await writeFile(viteTarget, viteSource, "utf8");
    const tsconfig = JSON.parse(originalTsconfig) as {
      compilerOptions?: Record<string, unknown>;
    };
    tsconfig.compilerOptions = {
      ...tsconfig.compilerOptions,
      baseUrl: options.resolution === "baseUrl" ? root : ".",
      ...(options.resolution === "baseUrl" ? {} : { paths: { [alias]: [typescriptTarget] } }),
    };
    await writeFile(
      coreFixture.clientTsconfigPath,
      `${JSON.stringify(tsconfig, null, 2)}\n`,
      "utf8",
    );
    const divergentAlias: Plugin = {
      name: "divergent-out-of-root-runtime-alias",
      resolveId(id) {
        return id === alias ? viteTarget : null;
      },
    };
    return (
      await inspectBrowserGraph(join(browserRoot, "index.html"), coreFixture, false, [
        divergentAlias,
      ])
    ).violations;
  } finally {
    await writeFile(coreFixture.clientTsconfigPath, originalTsconfig, "utf8");
    await rm(root, { recursive: true, force: true });
  }
}

async function resolvableCoreMutationGraph(
  source: string,
  coreFixture: CoreClientFixture,
): Promise<readonly BrowserImportViolation[]> {
  const root = await mkdtemp(join(coreFixture.consumerRoot, "web-resolvable-core-mutation-"));
  const browserRoot = join(root, "packages", "web", "client");
  try {
    await mkdir(browserRoot, { recursive: true });
    const mutationCoreRoot = join(root, "packages", "core");
    await mkdir(join(mutationCoreRoot, "src", "protocol"), { recursive: true });
    await copyFile(
      fileURLToPath(new URL("../../core/src/protocol/cli.ts", import.meta.url)),
      join(mutationCoreRoot, "src", "protocol", "cli.ts"),
    );
    await copyFile(
      fileURLToPath(new URL("../../core/src/protocol/client-types.ts", import.meta.url)),
      join(mutationCoreRoot, "src", "protocol", "client-types.ts"),
    );
    await writeFile(
      join(browserRoot, "index.html"),
      '<script type="module" src="/main.ts"></script>\n',
      "utf8",
    );
    await writeFile(join(browserRoot, "main.ts"), 'import "./mutation.js";\n', "utf8");
    await writeFile(join(browserRoot, "mutation.ts"), source, "utf8");
    return (
      await inspectBrowserGraph(join(browserRoot, "index.html"), {
        ...coreFixture,
        coreRoot: await realpath(mutationCoreRoot),
      })
    ).violations;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function aliasedProductionCoreMutationGraph(
  source: string,
  coreFixture: CoreClientFixture,
): Promise<readonly BrowserImportViolation[]> {
  const root = await mkdtemp(join(coreFixture.consumerRoot, "web-aliased-core-mutation-"));
  try {
    const htmlEntry = join(root, "index.html");
    const configPath = join(root, "vite.config.mjs");
    await writeFile(htmlEntry, '<script type="module" src="/mutation.ts"></script>\n', "utf8");
    await writeFile(join(root, "mutation.ts"), source, "utf8");
    await writeFile(
      configPath,
      `export default { resolve: { alias: [{ find: "core-source-alias", replacement: ${JSON.stringify(
        join(corePackageRoot, "src", "protocol", "cli.ts"),
      )} }] } };\n`,
      "utf8",
    );
    return (await inspectBrowserGraph(htmlEntry, coreFixture, configPath)).violations;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function nodeNextFixtureDiagnostics(
  files: Readonly<Record<string, string>>,
  coreFixture: CoreClientFixture,
): Promise<readonly ts.Diagnostic[]> {
  assertClientApiExportContract(coreFixture);
  const root = await mkdtemp(join(coreFixture.consumerRoot, "web-nodenext-type-fixture-"));
  try {
    await writeFile(join(root, "package.json"), '{"private":true,"type":"module"}\n', "utf8");
    const rootNames: string[] = [];
    for (const [file, source] of Object.entries(files)) {
      const filePath = join(root, file);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, source, "utf8");
      rootNames.push(filePath);
    }
    const options: ts.CompilerOptions = {
      module: tsRuntime.ModuleKind.NodeNext,
      moduleResolution: tsRuntime.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: tsRuntime.ScriptTarget.ES2022,
      types: [],
    };
    const program = tsRuntime.createProgram({ rootNames, options });
    const diagnostics = tsRuntime.getPreEmitDiagnostics(program);
    const resolvedClientApi = tsRuntime.resolveModuleName(
      approvedCoreSpecifier,
      rootNames[0] as string,
      options,
      tsRuntime.sys,
    ).resolvedModule;
    if (resolvedClientApi === undefined) {
      throw new Error(`failed to resolve ${approvedCoreSpecifier} from NodeNext fixture`);
    }
    expect(realpathSync(resolvedClientApi.resolvedFileName)).toBe(
      realpathSync(join(coreFixture.coreRoot, "dist", "protocol", "client.d.ts")),
    );
    return diagnostics;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

interface ClientTypeProbe {
  readonly module: ts.ModuleKind;
  readonly moduleResolution: ts.ModuleResolutionKind;
  readonly resolvedClientApiDeclarationPath: string;
  readonly variableType: string;
}

function clientTypeProbe(
  fileName: string,
  variableName: string,
  coreFixture: CoreClientFixture,
  sharedCoreDistMutation?: "missing" | "stale",
): ClientTypeProbe {
  assertClientApiExportContract(coreFixture);
  const relativeFileName = relative(productionClientRoot, fileName);
  if (isAbsolute(relativeFileName) || relativeFileName.startsWith("..")) {
    throw new Error(`client type probe source is outside the production client: ${fileName}`);
  }
  const fixtureFileName = join(coreFixture.browserRoot, relativeFileName);
  const configPath = coreFixture.clientTsconfigPath;
  const productionCoreDist = join(corePackageRoot, "dist");
  const parsed = tsRuntime.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...tsRuntime.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(diagnosticsText([diagnostic]));
      },
    },
  );
  if (parsed === undefined) throw new Error("failed to parse Web client tsconfig");
  if (parsed.errors.length > 0) throw new Error(diagnosticsText(parsed.errors));
  const options: ts.CompilerOptions = {
    ...parsed.options,
    module: tsRuntime.ModuleKind.NodeNext,
    moduleResolution: tsRuntime.ModuleResolutionKind.NodeNext,
  };
  const compilerHost = tsRuntime.createCompilerHost(options);
  const fileExists = compilerHost.fileExists.bind(compilerHost);
  const readCompilerFile = compilerHost.readFile.bind(compilerHost);
  const isSharedDistPath = (candidate: string): boolean => {
    if (sharedCoreDistMutation === undefined || !fileExists(candidate)) return false;
    try {
      return isPathInside(realpathSync(candidate), productionCoreDist);
    } catch {
      return false;
    }
  };
  compilerHost.fileExists = (candidate) =>
    !(sharedCoreDistMutation === "missing" && isSharedDistPath(candidate)) && fileExists(candidate);
  compilerHost.readFile = (candidate) =>
    sharedCoreDistMutation === "stale" && isSharedDistPath(candidate)
      ? "export type StaleSharedCoreDist = never;\n"
      : readCompilerFile(candidate);
  const program = tsRuntime.createProgram({
    rootNames: parsed.fileNames,
    options,
    host: compilerHost,
  });
  const diagnostics = tsRuntime.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) throw new Error(diagnosticsText(diagnostics));
  const sourceFile = program.getSourceFile(fixtureFileName);
  if (sourceFile === undefined) throw new Error(`missing client source: ${fixtureFileName}`);
  let declaration: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (
      declaration === undefined &&
      tsRuntime.isVariableDeclaration(node) &&
      tsRuntime.isIdentifier(node.name) &&
      node.name.text === variableName
    ) {
      declaration = node;
      return;
    }
    tsRuntime.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (declaration === undefined) throw new Error(`missing client variable: ${variableName}`);
  const resolvedClientApi = tsRuntime.resolveModuleName(
    approvedCoreSpecifier,
    fixtureFileName,
    options,
    compilerHost,
  ).resolvedModule;
  if (resolvedClientApi === undefined) {
    throw new Error(`failed to resolve ${approvedCoreSpecifier} from ${fixtureFileName}`);
  }
  const resolvedClientApiDeclarationPath = realpathSync(resolvedClientApi.resolvedFileName);
  const approvedDeclarationPath = realpathSync(
    join(coreFixture.coreRoot, "dist", "protocol", "client.d.ts"),
  );
  if (resolvedClientApiDeclarationPath !== approvedDeclarationPath) {
    throw new Error(
      `${approvedCoreSpecifier} types resolved outside the candidate's approved declaration`,
    );
  }
  return {
    module: options.module,
    moduleResolution: options.moduleResolution,
    resolvedClientApiDeclarationPath,
    variableType: program
      .getTypeChecker()
      .typeToString(
        program.getTypeChecker().getTypeAtLocation(declaration.name),
        declaration,
        tsRuntime.TypeFormatFlags.NoTruncation,
      ),
  };
}

async function extensionMutationGraph(
  extension: ".cjs" | ".cts" | ".js" | ".jsx" | ".mjs" | ".mts",
  source: string,
  coreFixture: CoreClientFixture,
  query = "",
): Promise<readonly BrowserImportViolation[]> {
  const root = await mkdtemp(join(coreFixture.consumerRoot, "web-extension-import-mutation-"));
  try {
    await writeFile(
      join(root, "index.html"),
      '<script type="module" src="/main.ts"></script>\n',
      "utf8",
    );
    await writeFile(join(root, "main.ts"), `import "./mutation${extension}${query}";\n`, "utf8");
    await writeFile(join(root, `mutation${extension}`), source, "utf8");
    return (await inspectBrowserGraph(join(root, "index.html"), coreFixture)).violations;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function inlineHtmlMutationGraph(
  source: string,
  coreFixture: CoreClientFixture,
): Promise<readonly BrowserImportViolation[]> {
  const root = await mkdtemp(join(coreFixture.consumerRoot, "web-html-import-mutation-"));
  try {
    const htmlEntry = join(root, "index.html");
    await writeFile(htmlEntry, `<script type="module">${source}</script>\n`, "utf8");
    return (await inspectBrowserGraph(htmlEntry, coreFixture)).violations;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("bundled Web client Core imports", () => {
  let coreFixture: CoreClientFixture;

  beforeAll(async () => {
    coreFixture = await createCoreClientFixture("cellarer-web-import-core-");
  });

  afterAll(async () => {
    await coreFixture?.cleanup();
  });

  it("checks the actual HTML-rooted browser source graph and rejects no imports", async () => {
    const result = await inspectBrowserGraph(
      coreFixture.htmlEntry,
      coreFixture,
      productionViteConfig,
    );

    expect(result.files.map((file) => relative(coreFixture.browserRoot, file))).toContain(
      "main.tsx",
    );
    expect(result.files.map((file) => relative(coreFixture.browserRoot, file))).not.toContain(
      "vite.config.ts",
    );
    expect(result.resolvedClientApiRuntimePaths).toEqual([coreFixture.portableModulePath]);
    expect(result.violations).toEqual([]);
  });

  it("rejects a wrapped require in the fresh portable Core source used by the import gate", async () => {
    const mutated = await createCoreClientFixture(
      "cellarer-web-import-portable-mutation-",
      'const load = (specifier: string) => require(specifier); export const mutation = load("node:path");',
    );
    try {
      const result = await inspectBrowserGraph(mutated.htmlEntry, mutated, productionViteConfig);
      expect(result.violations).toEqual([
        expect.objectContaining({ reason: "CommonJS require" }),
        expect.objectContaining({ reason: "CommonJS require" }),
      ]);
    } finally {
      await mutated.cleanup();
    }
  });

  it.each(
    aggregatedRuntimeGlobalMutations,
  )("rejects the %s aggregation from the actual Vite browser graph", async (_name, source) => {
    await expect(mutationGraph(source, coreFixture)).resolves.toEqual([
      expect.objectContaining({ reason: 'forbidden runtime global "globalThis"' }),
    ]);
  });

  it.each(
    lexicalRuntimeGlobalShadows,
  )("allows a genuine %s shadow in the actual Vite browser graph", async (_name, source) => {
    await expect(mutationGraph(source, coreFixture)).resolves.toEqual([]);
  });

  it.each([
    [
      "literal root import with alias",
      'import { CLIENT_API_VERSION as version } from "@cellarer/core"; void version;\n',
      "Node-only Core root import",
    ],
    [
      "formatted root re-export",
      'export{ CLIENT_API_VERSION as version }/* formatting */from\n"@cellarer/core";\n',
      "Node-only Core root import",
    ],
    [
      "literal CommonJS require",
      'const core = require("@cellarer/core"); void core;\n',
      "Node-only Core root import",
    ],
    [
      "literal CommonJS require of the portable subpath",
      'const core = require("@cellarer/core/client-api"); void core;\n',
      "CommonJS require in browser source",
    ],
    [
      "computed CommonJS require",
      'const specifier = "@cellarer/core"; void require(specifier);\n',
      "non-literal require in browser source",
    ],
    [
      "TypeScript import-equals",
      'import core = require("@cellarer/core"); void core;\n',
      "Node-only Core root import",
    ],
    [
      "internal TypeScript import-equals",
      "namespace Runtime { export const value = 1; } import Alias = Runtime; void Alias.value;\n",
      "TypeScript import-equals in browser source",
    ],
    [
      "TypeScript export-equals",
      "const commonJsMutation = {}; export = commonJsMutation;\n",
      "TypeScript export-equals in browser source",
    ],
    ["literal dynamic import", 'void import("@cellarer/core");\n', "Node-only Core root import"],
    [
      "computed dynamic import",
      'const specifier = "@cellarer/core"; void import(specifier);\n',
      "non-literal dynamic import in browser source",
    ],
  ])("rejects the %s mutation", async (_name, source, reason) => {
    await expect(mutationGraph(source, coreFixture)).resolves.toEqual([
      expect.objectContaining({ reason }),
    ]);
  });

  it("rejects a root import from an actual JavaScript module in the browser graph", async () => {
    await expect(
      extensionMutationGraph(".js", 'import "@cellarer/core";\n', coreFixture),
    ).resolves.toEqual([expect.objectContaining({ reason: "Node-only Core root import" })]);
  });

  it("parses a JSX module with JSX syntax and rejects its Core root import", async () => {
    await expect(
      extensionMutationGraph(
        ".jsx",
        'export const view = <div />;\nimport "@cellarer/core";\n',
        coreFixture,
      ),
    ).resolves.toEqual([expect.objectContaining({ reason: "Node-only Core root import" })]);
  });

  it.each([
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
  ] as const)("rejects globalThis.process from a %s module with a Vite query", async (extension) => {
    await expect(
      extensionMutationGraph(
        extension,
        "void globalThis.process.platform;\n",
        coreFixture,
        "?cellarer-guard",
      ),
    ).resolves.toEqual([
      expect.objectContaining({ reason: 'forbidden runtime global "globalThis"' }),
    ]);
  });

  it("normalizes a virtual MTS id before inspecting the actual Vite graph", async () => {
    await expect(
      virtualExtensionMutationGraph(".mts", "void globalThis.process.platform;\n", coreFixture),
    ).resolves.toEqual([
      expect.objectContaining({ reason: 'forbidden runtime global "globalThis"' }),
    ]);
  });

  it("fails closed when a first-party executable module has an unknown extension", async () => {
    await expect(
      virtualExtensionMutationGraph(".cellarer", "export const mutation = 1;\n", coreFixture),
    ).resolves.toEqual([
      expect.objectContaining({ reason: expect.stringMatching(/uninspectable first-party/u) }),
    ]);
  });

  it("fails closed when a virtual first-party executable id cannot resolve to a file", async () => {
    await expect(
      virtualExtensionMutationGraph(".mts", "export const mutation = 1;\n", coreFixture, false),
    ).resolves.toEqual([
      expect.objectContaining({ reason: "unresolvable first-party executable module" }),
    ]);
  });

  it.each([
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
  ] as const)("rejects CommonJS require from a %s module with a Vite query", async (extension) => {
    await expect(
      extensionMutationGraph(
        extension,
        'void require("node:path");\n',
        coreFixture,
        "?cellarer-guard",
      ),
    ).resolves.toEqual([expect.objectContaining({ reason: "CommonJS require in browser source" })]);
  });

  it.each([
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
  ] as const)("allows local globalThis and require shadows in a %s module with a Vite query", async (extension) => {
    const source =
      'const globalThis = { process: { platform: "browser" } }; const require = (specifier) => specifier; void globalThis.process.platform; void require("portable");\n';
    await expect(
      extensionMutationGraph(extension, source, coreFixture, "?cellarer-guard"),
    ).resolves.toEqual([]);
  });

  it("rejects a computed dynamic import in an inline HTML module", async () => {
    await expect(
      inlineHtmlMutationGraph(
        'const prefix = "@cellarer/"; void import(prefix + "core");',
        coreFixture,
      ),
    ).resolves.toEqual([
      expect.objectContaining({ reason: "non-literal dynamic import in browser source" }),
    ]);
  });

  it.each([
    ["Core root", 'type Leaked = import("@cellarer/core").Env;\n'],
    [
      "unapproved Core package subpath",
      'type Leaked = import("@cellarer/core/protocol/client.js").ClientApiErrorCode;\n',
    ],
  ])("rejects a TypeScript import type from the %s", async (_name, source) => {
    await expect(mutationGraph(source, coreFixture)).resolves.toEqual([
      expect.objectContaining({ reason: expect.stringMatching(/Core .*import/iu) }),
    ]);
  });

  it("rejects a TypeScript import type that resolves to a relative Core deep path", async () => {
    await expect(
      resolvableCoreMutationGraph(
        'type Leaked = import("../../core/src/protocol/cli.ts").CliErrorCode;\n',
        coreFixture,
      ),
    ).resolves.toEqual([expect.objectContaining({ reason: "Unapproved Core package import" })]);
  });

  it("rejects a JSDoc import type from the Core root", async () => {
    await expect(
      extensionMutationGraph(
        ".js",
        '/** @typedef {import("@cellarer/core").Env} Leaked */\nexport const mutation = 1;\n',
        coreFixture,
      ),
    ).resolves.toEqual([expect.objectContaining({ reason: "Node-only Core root import" })]);
  });

  it("rejects a triple-slash Core package type reference", async () => {
    await expect(
      mutationGraph(
        '/// <reference types="@cellarer/core" />\nexport const mutation = 1;\n',
        coreFixture,
      ),
    ).resolves.toEqual([expect.objectContaining({ reason: "Node-only Core root import" })]);
  });

  it("rejects a triple-slash path reference that resolves into the real Core tree", async () => {
    await expect(
      mutationGraph(
        `/// <reference path=${JSON.stringify(
          join(corePackageRoot, "src", "protocol", "cli.ts"),
        )} />\nexport const mutation = 1;\n`,
        coreFixture,
      ),
    ).resolves.toEqual([expect.objectContaining({ reason: "Unapproved Core package import" })]);
  });

  it("allows a TypeScript import type from the approved client-api subpath", async () => {
    await expect(
      mutationGraph(
        'type Allowed = import("@cellarer/core/client-api").ClientErrorCode;\n',
        coreFixture,
      ),
    ).resolves.toEqual([]);
  });

  it.each([
    [
      "local import type through two erased source hops to the Core root",
      {
        "runtime.ts": 'import type { Hidden } from "./types.js"; export const value = 1;\n',
        "types.ts": 'export type { Hidden } from "./nested.js";\n',
        "nested.ts":
          'import type { Env as Hidden } from "@cellarer/core"; export type { Hidden };\n',
      },
      "Node-only Core root import",
    ],
    [
      "JSDoc import through two erased source hops to an unapproved Core subpath",
      {
        "runtime.js":
          '/** @typedef {import("./types.js").Hidden} Hidden */\nexport const value = 1;\n',
        "types.js":
          '/** @typedef {import("./nested.js").Hidden} Hidden */\nexport const marker = 1;\n',
        "nested.js":
          '/** @typedef {import("@cellarer/core/protocol/client.js").ClientApiErrorCode} Hidden */\nexport const marker = 1;\n',
      },
      "Unapproved Core package import",
    ],
    [
      "triple-slash path through a declaration hop to a Core deep path",
      {
        "runtime.ts": '/// <reference path="./types.d.ts" />\nexport const value = 1;\n',
        "types.d.ts": `/// <reference path=${JSON.stringify(
          join(corePackageRoot, "src", "protocol", "cli.ts"),
        )} />\n`,
      },
      "Unapproved Core package import",
    ],
    [
      "triple-slash types through a local declaration hop to the Core root",
      {
        "runtime.ts": '/// <reference types="./types" />\nexport const value = 1;\n',
        "types.d.ts": 'import type { Env } from "@cellarer/core"; export type Hidden = Env;\n',
      },
      "Node-only Core root import",
    ],
  ])("rejects a %s", async (_name, files, reason) => {
    await expect(recursiveSourceMutationGraph(files, coreFixture)).resolves.toEqual([
      expect.objectContaining({ reason }),
    ]);
  });

  it("allows the approved client-api through an erased local source hop", async () => {
    const files = {
      "runtime.ts": 'import type { Allowed } from "./types.js"; export const value = 1;\n',
      "types.ts":
        'import type { ClientErrorCode as Allowed } from "@cellarer/core/client-api"; export type { Allowed };\n',
    };
    await expect(recursiveSourceMutationGraph(files, coreFixture)).resolves.toEqual([]);
    await expect(nodeNextFixtureDiagnostics(files, coreFixture)).resolves.toEqual([]);
  });

  it("fails closed when an erased first-party relative type edge cannot resolve", async () => {
    await expect(
      recursiveSourceMutationGraph(
        {
          "runtime.ts": 'import type { Missing } from "./missing.js"; export const value = 1;\n',
        },
        coreFixture,
      ),
    ).resolves.toEqual([
      expect.objectContaining({ reason: "unresolvable first-party source/type edge" }),
    ]);
  });

  it.each([
    [
      "Core root behind one erased tsconfig-path hop",
      {
        "runtime.ts":
          'import type { Hidden } from "@client/root.js"; export const value = undefined as unknown as Hidden;\n',
        "root.ts": 'import type { Env as Hidden } from "@cellarer/core"; export type { Hidden };\n',
      },
      "Node-only Core root import",
    ],
    [
      "Core subpath behind two erased tsconfig-path hops",
      {
        "runtime.ts":
          'import type { Hidden } from "@client/first.js"; export const value = undefined as unknown as Hidden;\n',
        "first.ts": 'export type { Hidden } from "./second.js";\n',
        "second.ts":
          'import type { ClientApiErrorCode as Hidden } from "@cellarer/core/protocol/client.js"; export type { Hidden };\n',
      },
      "Unapproved Core package import",
    ],
    [
      "Core source deep path behind two erased tsconfig-path hops",
      {
        "runtime.ts":
          'import type { Hidden } from "@client/first.js"; export const value = undefined as unknown as Hidden;\n',
        "first.ts": 'export type { Hidden } from "./second.js";\n',
        "second.ts": `import type { CliErrorCode as Hidden } from ${JSON.stringify(
          join(corePackageRoot, "src", "protocol", "cli.ts"),
        )}; export type { Hidden };\n`,
      },
      "Unapproved Core package import",
    ],
  ])("rejects %s", async (_name, files, reason) => {
    await expect(tsconfigAliasedTypeMutationGraph(files, coreFixture)).resolves.toEqual([
      expect.objectContaining({ reason }),
    ]);
  });

  it("allows client-api behind an erased tsconfig-path hop", async () => {
    await expect(
      tsconfigAliasedTypeMutationGraph(
        {
          "runtime.ts":
            'import type { Allowed } from "@client/approved.js"; export const value = undefined as unknown as Allowed;\n',
          "approved.ts":
            'import type { ClientErrorCode as Allowed } from "@cellarer/core/client-api"; export type { Allowed };\n',
        },
        coreFixture,
      ),
    ).resolves.toEqual([]);
  });

  it("uses the client tsconfig for an erased path alias instead of a Vite fallback", async () => {
    await expect(
      tsconfigAliasedTypeMutationGraph(
        {
          "runtime.ts":
            'import type { Hidden } from "@client/root.js"; export const value = undefined as unknown as Hidden;\n',
          "root.ts":
            'import type { Env as Hidden } from "@cellarer/core"; export type { Hidden };\n',
        },
        coreFixture,
        "paths",
        true,
      ),
    ).resolves.toEqual([expect.objectContaining({ reason: "Node-only Core root import" })]);
  });

  it("unions an out-of-root Vite runtime target with the TypeScript source closure", async () => {
    await expect(
      divergentOutOfRootRuntimeMutationGraph(
        "export const value = 1;\n",
        "void globalThis.process.platform; export const value = 1;\n",
        coreFixture,
      ),
    ).resolves.toEqual([
      expect.objectContaining({ reason: 'forbidden runtime global "globalThis"' }),
    ]);
  });

  it("unions an out-of-root TypeScript target with a safe Vite runtime target", async () => {
    await expect(
      divergentOutOfRootRuntimeMutationGraph(
        'import type { Env } from "@cellarer/core"; export const value = undefined as unknown as Env;\n',
        "export const value = 1;\n",
        coreFixture,
      ),
    ).resolves.toEqual([expect.objectContaining({ reason: "Node-only Core root import" })]);
  });

  it("rejects a Core root import in an out-of-root Vite runtime target", async () => {
    await expect(
      divergentOutOfRootRuntimeMutationGraph(
        "export const value = 1;\n",
        'import { createRealEnv } from "@cellarer/core"; export const value = createRealEnv;\n',
        coreFixture,
        { resolution: "baseUrl" },
      ),
    ).resolves.toEqual([expect.objectContaining({ reason: "Node-only Core root import" })]);
  });

  it("excludes an out-of-root node_modules runtime target from first-party scanning", async () => {
    await expect(
      divergentOutOfRootRuntimeMutationGraph(
        "export const value = 1;\n",
        "void globalThis.process.platform; export const value = 1;\n",
        coreFixture,
        { viteTargetUnderNodeModules: true },
      ),
    ).resolves.toEqual([]);
  });

  it("prefers a configured TypeScript path alias into sibling shared source over a safe Vite fallback", async () => {
    await expect(
      outOfRootAliasedTypeMutationGraph(
        {
          "runtime.ts":
            'import type { Hidden } from "@shared/root.js"; export const value = undefined as unknown as Hidden;\n',
          "root.ts":
            'import type { Env as Hidden } from "@cellarer/core"; export type { Hidden };\n',
        },
        coreFixture,
        {
          paths: { "@shared/*": ["*"] },
          safeViteFallbackSpecifiers: ["@shared/root.js"],
        },
      ),
    ).resolves.toEqual([expect.objectContaining({ reason: "Node-only Core root import" })]);
  });

  it.each([
    ["root.js", "root.ts", false],
    ["root.js", "root.ts", true],
    ["view.js", "view.tsx", false],
    ["view.js", "view.tsx", true],
    ["root.mjs", "root.mts", false],
    ["root.mjs", "root.mts", true],
    ["root.cjs", "root.cts", false],
    ["root.cjs", "root.cts", true],
  ])("recursively follows out-of-root @shared/%s -> %s with safe Vite fallback %s", async (specifier, file, safeViteFallback) => {
    await expect(
      outOfRootAliasedTypeMutationGraph(
        {
          "runtime.ts": `import type { Hidden } from ${JSON.stringify(`@shared/${specifier}`)}; export const value = undefined as unknown as Hidden;\n`,
          [file]: 'import type { Env as Hidden } from "@cellarer/core"; export type { Hidden };\n',
        },
        coreFixture,
        {
          paths: { "@shared/*": ["*"] },
          safeViteFallbackSpecifiers: safeViteFallback ? [`@shared/${specifier}`] : [],
        },
      ),
    ).resolves.toEqual([expect.objectContaining({ reason: "Node-only Core root import" })]);
  });

  it.each([
    false,
    true,
  ])("fails closed for a missing configured out-of-root alias with safe Vite fallback %s", async (safeViteFallback) => {
    await expect(
      outOfRootAliasedTypeMutationGraph(
        {
          "runtime.ts":
            'import type { Missing } from "@shared/missing.js"; export const value = undefined as unknown as Missing;\n',
        },
        coreFixture,
        {
          paths: { "@shared/*": ["*"] },
          safeViteFallbackSpecifiers: safeViteFallback ? ["@shared/missing.js"] : [],
        },
      ),
    ).resolves.toEqual([
      expect.objectContaining({ reason: "unresolvable first-party source/type edge" }),
    ]);
  });

  it("uses TypeScript overlapping-path precedence outside fixed roots", async () => {
    await expect(
      outOfRootAliasedTypeMutationGraph(
        {
          "runtime.ts":
            'import type { Hidden } from "@shared/core/root.js"; export const value = undefined as unknown as Hidden;\n',
          "safe/core/root.ts":
            'import type { ClientErrorCode as Hidden } from "@cellarer/core/client-api"; export type { Hidden };\n',
          "danger/root.ts":
            'import type { Env as Hidden } from "@cellarer/core"; export type { Hidden };\n',
        },
        coreFixture,
        {
          paths: {
            "@shared/*": ["safe/*"],
            "@shared/core/*": ["danger/*"],
          },
          safeViteFallbackSpecifiers: ["@shared/core/root.js"],
        },
      ),
    ).resolves.toEqual([expect.objectContaining({ reason: "Node-only Core root import" })]);
  });

  it("terminates an out-of-root configured-alias cycle and scans the remaining Core edge", async () => {
    await expect(
      outOfRootAliasedTypeMutationGraph(
        {
          "runtime.ts":
            'import type { Hidden } from "@shared/first.js"; export const value = undefined as unknown as Hidden;\n',
          "first.ts": 'export type { Hidden } from "./second.js";\n',
          "second.ts":
            'export type { Hidden } from "./first.js"; import type { Env } from "@cellarer/core"; export type { Env };\n',
        },
        coreFixture,
        { paths: { "@shared/*": ["*"] } },
      ),
    ).resolves.toEqual([expect.objectContaining({ reason: "Node-only Core root import" })]);
  });

  it.each([
    [
      "Core package subpath",
      'import type { ClientApiErrorCode as Hidden } from "@cellarer/core/protocol/client.js"; export type { Hidden };\n',
    ],
    [
      "Core source deep path",
      `import type { CliErrorCode as Hidden } from ${JSON.stringify(
        join(corePackageRoot, "src", "protocol", "cli.ts"),
      )}; export type { Hidden };\n`,
    ],
  ])("rejects %s hidden in an out-of-root configured alias", async (_name, hiddenSource) => {
    await expect(
      outOfRootAliasedTypeMutationGraph(
        {
          "runtime.ts":
            'import type { Hidden } from "@shared/hidden.js"; export const value = undefined as unknown as Hidden;\n',
          "hidden.ts": hiddenSource,
        },
        coreFixture,
        { paths: { "@shared/*": ["*"] } },
      ),
    ).resolves.toEqual([expect.objectContaining({ reason: "Unapproved Core package import" })]);
  });

  it("allows the approved client-api through an out-of-root configured alias", async () => {
    await expect(
      outOfRootAliasedTypeMutationGraph(
        {
          "runtime.ts":
            'import type { Allowed } from "@shared/approved.js"; export const value = undefined as unknown as Allowed;\n',
          "approved.ts":
            'import type { ClientErrorCode as Allowed } from "@cellarer/core/client-api"; export type { Allowed };\n',
        },
        coreFixture,
        { paths: { "@shared/*": ["*"] } },
      ),
    ).resolves.toEqual([]);
  });

  it.each([
    false,
    true,
  ])("uses baseUrl to scan sibling shared source before safe Vite fallback %s", async (safeViteFallback) => {
    await expect(
      outOfRootAliasedTypeMutationGraph(
        {
          "runtime.ts":
            'import type { Hidden } from "shared/root.js"; export const value = undefined as unknown as Hidden;\n',
          "root.ts":
            'import type { Env as Hidden } from "@cellarer/core"; export type { Hidden };\n',
        },
        coreFixture,
        {
          baseUrl: "shared-parent",
          safeViteFallbackSpecifiers: safeViteFallback ? ["shared/root.js"] : [],
        },
      ),
    ).resolves.toEqual([expect.objectContaining({ reason: "Node-only Core root import" })]);
  });

  it.each([
    false,
    true,
  ])("fails closed for a missing sibling baseUrl alias before safe Vite fallback %s", async (safeViteFallback) => {
    await expect(
      outOfRootAliasedTypeMutationGraph(
        {
          "runtime.ts":
            'import type { Missing } from "shared/missing.js"; export const value = undefined as unknown as Missing;\n',
        },
        coreFixture,
        {
          baseUrl: "shared-parent",
          safeViteFallbackSpecifiers: safeViteFallback ? ["shared/missing.js"] : [],
        },
      ),
    ).resolves.toEqual([
      expect.objectContaining({ reason: "unresolvable first-party source/type edge" }),
    ]);
  });

  it("keeps React external while baseUrl scanning reaches sibling shared source", async () => {
    await expect(
      outOfRootAliasedTypeMutationGraph(
        {
          "runtime.ts":
            'import type { Hidden } from "shared/react-user.js"; export const value = undefined as unknown as Hidden;\n',
          "react-user.ts":
            'import type { ComponentType as Hidden } from "react"; export type { Hidden };\n',
        },
        coreFixture,
        { baseUrl: "shared-parent" },
      ),
    ).resolves.toEqual([]);
  });

  it("terminates a tsconfig-path cycle and still finds the Core root edge", async () => {
    await expect(
      tsconfigAliasedTypeMutationGraph(
        {
          "runtime.ts":
            'import type { Hidden } from "@client/first.js"; export const value = undefined as unknown as Hidden;\n',
          "first.ts": 'export type { Hidden } from "./second.js";\n',
          "second.ts":
            'export type { Hidden } from "./first.js"; import type { Env } from "@cellarer/core"; export type { Env };\n',
        },
        coreFixture,
      ),
    ).resolves.toEqual([expect.objectContaining({ reason: "Node-only Core root import" })]);
  });

  it("fails closed when an erased tsconfig-path alias edge cannot resolve", async () => {
    await expect(
      tsconfigAliasedTypeMutationGraph(
        {
          "runtime.ts":
            'import type { Missing } from "@client/missing.js"; export const value = undefined as unknown as Missing;\n',
        },
        coreFixture,
      ),
    ).resolves.toEqual([
      expect.objectContaining({ reason: "unresolvable first-party source/type edge" }),
    ]);
  });

  it("follows an erased first-party bare alias through the client baseUrl", async () => {
    await expect(
      tsconfigAliasedTypeMutationGraph(
        {
          "runtime.ts":
            'import type { Hidden } from "root.js"; export const value = undefined as unknown as Hidden;\n',
          "root.ts":
            'import type { Env as Hidden } from "@cellarer/core"; export type { Hidden };\n',
        },
        coreFixture,
        "baseUrl",
      ),
    ).resolves.toEqual([expect.objectContaining({ reason: "Node-only Core root import" })]);
  });

  it.each([
    ["root.js", "root.ts"],
    ["root.js", "root.tsx"],
    ["root.mjs", "root.mts"],
    ["root.cjs", "root.cts"],
  ])("uses the TypeScript baseUrl result for %s -> %s before a Vite fallback", async (specifier, file) => {
    await expect(
      tsconfigAliasedTypeMutationGraph(
        {
          "runtime.ts": `import type { Hidden } from ${JSON.stringify(specifier)}; export const value = undefined as unknown as Hidden;\n`,
          [file]: 'import type { Env as Hidden } from "@cellarer/core"; export type { Hidden };\n',
        },
        coreFixture,
        "baseUrl",
        true,
      ),
    ).resolves.toEqual([expect.objectContaining({ reason: "Node-only Core root import" })]);
  });

  it("fails closed for an unresolved bare alias inside the client baseUrl", async () => {
    await expect(
      tsconfigAliasedTypeMutationGraph(
        {
          "runtime.ts":
            'import type { Missing } from "local/missing.js"; export const value = undefined as unknown as Missing;\n',
          "local/present.ts": "export type Present = string;\n",
        },
        coreFixture,
        "baseUrl",
        true,
      ),
    ).resolves.toEqual([
      expect.objectContaining({ reason: "unresolvable first-party source/type edge" }),
    ]);
  });

  it("excludes an ordinary external package from the client baseUrl source closure", async () => {
    await expect(
      tsconfigAliasedTypeMutationGraph(
        {
          "runtime.ts":
            'import type { ComponentType } from "react"; export const value = undefined as unknown as ComponentType;\n',
        },
        coreFixture,
        "baseUrl",
      ),
    ).resolves.toEqual([]);
  });

  it.each([
    [
      "exported package metadata subpath",
      'import packageJson from "@cellarer/core/package.json"; void packageJson;\n',
    ],
    [
      "relative Core source deep import",
      'import { CLI_PROTOCOL_VERSION } from "../../core/src/protocol/cli.ts"; void CLI_PROTOCOL_VERSION;\n',
    ],
    [
      "normalized relative Core source import with a Vite query",
      'import cliSource from "../../core/src/protocol/../protocol/cli.ts?raw"; void cliSource;\n',
    ],
  ])("rejects the resolvable %s mutation", async (_name, source) => {
    await expect(resolvableCoreMutationGraph(source, coreFixture)).resolves.toEqual([
      expect.objectContaining({ reason: "Unapproved Core package import" }),
    ]);
  });

  it.each([
    [
      "real Core absolute path",
      `import { CLI_PROTOCOL_VERSION } from ${JSON.stringify(
        join(corePackageRoot, "src", "protocol", "cli.ts"),
      )}; void CLI_PROTOCOL_VERSION;\n`,
    ],
    [
      "real Core absolute path with a Vite query",
      `import source from ${JSON.stringify(
        `${join(corePackageRoot, "src", "protocol", "cli.ts")}?raw`,
      )}; void source;\n`,
    ],
    [
      "type-only real Core deep import",
      `import type { CliErrorCode } from ${JSON.stringify(
        join(corePackageRoot, "src", "protocol", "cli.ts"),
      )}; void (undefined as unknown as CliErrorCode);\n`,
    ],
  ])("rejects a %s mutation", async (_name, source) => {
    await expect(mutationGraph(source, coreFixture)).resolves.toEqual([
      expect.objectContaining({ reason: "Unapproved Core package import" }),
    ]);
  });

  it("rejects a Vite alias that resolves into the real Core source tree", async () => {
    await expect(
      aliasedProductionCoreMutationGraph(
        'import { CLI_PROTOCOL_VERSION } from "core-source-alias"; void CLI_PROTOCOL_VERSION;\n',
        coreFixture,
      ),
    ).resolves.toEqual([expect.objectContaining({ reason: "Unapproved Core package import" })]);
  });

  it("resolves actual browser imports through NodeNext and Vite from the same candidate", async () => {
    const result = clientTypeProbe(
      fileURLToPath(new URL("../client/App.tsx", import.meta.url)),
      "resourcesState",
      coreFixture,
    );
    const graph = await inspectBrowserGraph(
      coreFixture.htmlEntry,
      coreFixture,
      productionViteConfig,
    );

    expect(result.variableType).toBe("ApiState<ControlPlaneResourceListDto>");
    expect(result.module).toBe(tsRuntime.ModuleKind.NodeNext);
    expect(result.moduleResolution).toBe(tsRuntime.ModuleResolutionKind.NodeNext);
    expect(result.resolvedClientApiDeclarationPath).toBe(
      realpathSync(join(coreFixture.coreRoot, "dist", "protocol", "client.d.ts")),
    );
    expect(graph.resolvedClientApiRuntimePaths).toEqual([coreFixture.portableModulePath]);
    expect(graph.violations).toEqual([]);
  });

  it.each([
    [
      "points the types condition at the type-only declaration module",
      (manifest: Record<string, unknown>) => {
        const exports = manifest.exports as Record<string, Record<string, string>>;
        const clientApi = exports["./client-api"];
        if (clientApi === undefined) throw new Error("missing client-api export fixture");
        clientApi.types = "./dist/protocol/client-types.d.ts";
      },
    ],
    [
      "removes the types condition while retaining the correct runtime and adjacent declaration",
      (manifest: Record<string, unknown>) => {
        const exports = manifest.exports as Record<string, Record<string, string>>;
        const clientApi = exports["./client-api"];
        if (clientApi === undefined) throw new Error("missing client-api export fixture");
        delete clientApi.types;
        clientApi.import = "./dist/protocol/client.js";
        clientApi.default = "./dist/protocol/client.js";
      },
    ],
  ])("rejects a candidate package that %s", async (_name, mutateManifest) => {
    const mutated = await createCoreClientFixture("cellarer-web-types-export-mutation-");
    try {
      const manifest = JSON.parse(await readFile(mutated.packageJsonPath, "utf8")) as Record<
        string,
        unknown
      >;
      mutateManifest(manifest);
      await writeFile(mutated.packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      expect(() =>
        clientTypeProbe(
          fileURLToPath(new URL("../client/App.tsx", import.meta.url)),
          "resourcesState",
          mutated,
        ),
      ).toThrow();
    } finally {
      await mutated.cleanup();
    }
  });

  it.each([
    "missing",
    "stale",
  ] as const)("does not depend on the shared Core dist declarations when they are %s", (sharedCoreDistMutation) => {
    expect(() =>
      clientTypeProbe(
        fileURLToPath(new URL("../client/App.tsx", import.meta.url)),
        "resourcesState",
        coreFixture,
        sharedCoreDistMutation,
      ),
    ).not.toThrow();
  });

  it.each([
    ["callable alias", 'const load = require; void load("@cellarer/core");\n', "CommonJS require"],
    [
      "TypeScript wrapper",
      'void (require as (specifier: string) => unknown)("@cellarer/core");\n',
      "CommonJS require",
    ],
    [
      "property access",
      'void globalThis.require("@cellarer/core");\n',
      'forbidden runtime global "globalThis"',
    ],
    [
      "element access",
      'void globalThis["require"]("@cellarer/core");\n',
      'forbidden runtime global "globalThis"',
    ],
  ])("rejects an unbound require hidden behind a %s", async (_name, source, reason) => {
    await expect(mutationGraph(source, coreFixture)).resolves.toEqual([
      expect.objectContaining({ reason }),
    ]);
  });

  it.each([
    [
      "identifier property from globalThis",
      'const { require: load } = globalThis as typeof globalThis & { require(specifier: string): unknown }; void load("@cellarer/core");\n',
      'forbidden runtime global "globalThis"',
    ],
    [
      "string property from window",
      'const { "require": load } = window as typeof window & { require(specifier: string): unknown }; void load("@cellarer/core");\n',
      'forbidden runtime global "window"',
    ],
    [
      "computed-literal property from self",
      'const { ["require"]: rawLoad } = self as typeof self & { require(specifier: string): unknown }; const load = (specifier: string) => rawLoad(specifier); void load("@cellarer/core");\n',
      'forbidden runtime global "self"',
    ],
  ])("rejects destructured require via %s in the browser graph", async (_name, source, reason) => {
    await expect(mutationGraph(source, coreFixture)).resolves.toEqual([
      expect.objectContaining({ reason }),
    ]);
  });

  it("allows require destructured from a safe local browser object", async () => {
    await expect(
      mutationGraph(
        'const browserLoader = (specifier: string) => specifier; const runtime = { require: browserLoader }; const { require: load } = runtime; void load("@cellarer/core");\n',
        coreFixture,
      ),
    ).resolves.toEqual([]);
  });

  it.each([
    [
      "destructuring assignment",
      'let load = (specifier: string): unknown => specifier; ({ require: load } = globalThis as typeof globalThis & { require(specifier: string): unknown }); void load("@cellarer/core");\n',
    ],
    [
      "object-rest alias",
      'const { ...runtime } = globalThis as typeof globalThis & { require(specifier: string): unknown }; void runtime.require("@cellarer/core");\n',
    ],
    [
      "const computed property",
      'const key = "require"; const { [key]: load } = globalThis as typeof globalThis & { require(specifier: string): unknown }; void load("@cellarer/core");\n',
    ],
  ])("rejects require provenance through %s in the browser Vite graph", async (_name, source) => {
    await expect(mutationGraph(source, coreFixture)).resolves.toEqual([
      expect.objectContaining({ reason: 'forbidden runtime global "globalThis"' }),
    ]);
  });

  it("fails closed for an unknown computed property of a known browser runtime owner", async () => {
    await expect(
      mutationGraph(
        "const key = String(Date.now()); const runtime = globalThis; void runtime[key];\n",
        coreFixture,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        reason: 'forbidden runtime global "globalThis"',
      }),
    ]);
  });

  it("allows a named class expression to shadow require in the browser Vite graph", async () => {
    await expect(
      mutationGraph(
        "const RuntimeClass = class require { method() { return require; } }; void RuntimeClass;\n",
        coreFixture,
      ),
    ).resolves.toEqual([]);
  });

  it("allows a local require binding in browser source", async () => {
    await expect(
      mutationGraph(
        'const require = (specifier: string) => specifier; void require("@cellarer/core");\n',
        coreFixture,
      ),
    ).resolves.toEqual([]);
  });

  it.each([
    [
      "JavaScript alias",
      ".js" as const,
      'const load = require; void load("@cellarer/core");\n',
      "CommonJS require",
    ],
    [
      "JSX element access",
      ".jsx" as const,
      'export const view = <div />; void globalThis["require"]("@cellarer/core");\n',
      'forbidden runtime global "globalThis"',
    ],
  ])("rejects the %s from the actual Vite graph", async (_name, extension, source, reason) => {
    await expect(extensionMutationGraph(extension, source, coreFixture)).resolves.toEqual([
      expect.objectContaining({ reason }),
    ]);
  });

  it("rejects destructured require from an actual JavaScript module in the Vite graph", async () => {
    await expect(
      extensionMutationGraph(
        ".js",
        'const { ["require"]: load } = globalThis; void load("@cellarer/core");\n',
        coreFixture,
      ),
    ).resolves.toEqual([
      expect.objectContaining({ reason: 'forbidden runtime global "globalThis"' }),
    ]);
  });
});
