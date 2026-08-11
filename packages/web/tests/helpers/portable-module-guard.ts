import { readFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { extname } from "node:path";
import type * as ts from "typescript";
import type { CoreClientFixture } from "./core-client-fixture.js";

const tsRuntime = createRequire(import.meta.url)("typescript") as typeof ts;
const approvedPortableSpecifiers = new Set(["./client-types.js"]);
const nodeRuntimeGlobals = new Set([
  "Buffer",
  "__dirname",
  "__filename",
  "exports",
  "global",
  "module",
  "process",
  "require",
]);
const browserRuntimeGlobals = new Set(["globalThis", "self", "window"]);
const forbiddenRuntimeGlobals = new Set([...nodeRuntimeGlobals, ...browserRuntimeGlobals]);

export interface PortableModuleViolation {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

export type SourceModuleEdgeKind =
  | "module"
  | "triple-slash-lib"
  | "triple-slash-path"
  | "triple-slash-types";

export interface SourceModuleEdge {
  readonly kind: SourceModuleEdgeKind;
  readonly line: number;
  readonly text: string;
}

function scriptKind(file: string): ts.ScriptKind {
  return extname(file) === ".ts" ? tsRuntime.ScriptKind.TS : tsRuntime.ScriptKind.JS;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function literalSpecifier(node: ts.Expression | undefined): string | undefined {
  return node !== undefined &&
    (tsRuntime.isStringLiteral(node) || tsRuntime.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

export function sourceModuleEdges(
  source: string,
  sourceFile: ts.SourceFile,
  sourceLineOffset = 0,
): readonly SourceModuleEdge[] {
  const edges: SourceModuleEdge[] = [];
  const add = (kind: SourceModuleEdgeKind, line: number, text: string): void => {
    if (edges.some((edge) => edge.kind === kind && edge.line === line && edge.text === text))
      return;
    edges.push({ kind, line, text });
  };
  const addAtPosition = (kind: SourceModuleEdgeKind, position: number, text: string): void => {
    add(kind, sourceFile.getLineAndCharacterOfPosition(position).line + 1 + sourceLineOffset, text);
  };
  const preprocessed = tsRuntime.preProcessFile(source, true, true);
  for (const imported of preprocessed.importedFiles) {
    let node: ts.Node | undefined = tsRuntime.getTokenAtPosition(sourceFile, imported.pos);
    let isModuleEdge = false;
    while (node !== undefined && !tsRuntime.isSourceFile(node)) {
      if (
        tsRuntime.isImportDeclaration(node) ||
        tsRuntime.isExportDeclaration(node) ||
        tsRuntime.isImportTypeNode(node) ||
        (tsRuntime.isCallExpression(node) &&
          node.expression.kind === tsRuntime.SyntaxKind.ImportKeyword)
      ) {
        isModuleEdge = true;
        break;
      }
      node = node.parent;
    }
    if (isModuleEdge) addAtPosition("module", imported.pos, imported.fileName);
  }
  for (const reference of preprocessed.referencedFiles) {
    addAtPosition("triple-slash-path", reference.pos, reference.fileName);
  }
  for (const reference of preprocessed.typeReferenceDirectives) {
    addAtPosition("triple-slash-types", reference.pos, reference.fileName);
  }
  for (const reference of preprocessed.libReferenceDirectives) {
    addAtPosition("triple-slash-lib", reference.pos, reference.fileName);
  }

  const visited = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    if (visited.has(node)) return;
    visited.add(node);
    let specifierNode: ts.Expression | undefined;
    if (tsRuntime.isImportDeclaration(node) || tsRuntime.isExportDeclaration(node)) {
      specifierNode = node.moduleSpecifier;
    } else if (tsRuntime.isImportTypeNode(node) && tsRuntime.isLiteralTypeNode(node.argument)) {
      specifierNode = node.argument.literal;
    } else if (
      tsRuntime.isCallExpression(node) &&
      node.expression.kind === tsRuntime.SyntaxKind.ImportKeyword
    ) {
      specifierNode = node.arguments[0];
    }
    const specifier = literalSpecifier(specifierNode);
    if (specifier !== undefined && specifierNode !== undefined) {
      add("module", lineOf(sourceFile, specifierNode) + sourceLineOffset, specifier);
    }
    tsRuntime.forEachChild(node, visit);
    const jsDoc = (node as ts.Node & { readonly jsDoc?: readonly ts.JSDoc[] }).jsDoc;
    for (const comment of jsDoc ?? []) visit(comment);
  };
  visit(sourceFile);
  return edges;
}

function specifierReason(specifier: string): string | undefined {
  if (isBuiltin(specifier)) return `Node builtin import ${JSON.stringify(specifier)}`;
  return approvedPortableSpecifiers.has(specifier)
    ? undefined
    : `unapproved portable dependency ${JSON.stringify(specifier)}`;
}

interface LexicalScope {
  readonly bindings: Set<string>;
  readonly kind: "block" | "class" | "function" | "function-body" | "source" | "static-block";
  readonly parent?: LexicalScope;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    tsRuntime.isArrowFunction(node) ||
    tsRuntime.isConstructorDeclaration(node) ||
    tsRuntime.isFunctionDeclaration(node) ||
    tsRuntime.isFunctionExpression(node) ||
    tsRuntime.isGetAccessorDeclaration(node) ||
    tsRuntime.isMethodDeclaration(node) ||
    tsRuntime.isSetAccessorDeclaration(node)
  );
}

function scopeKind(node: ts.Node): LexicalScope["kind"] | undefined {
  if (tsRuntime.isSourceFile(node)) return "source";
  if (isFunctionLike(node)) return "function";
  if (tsRuntime.isClassDeclaration(node) || tsRuntime.isClassExpression(node)) return "class";
  if (tsRuntime.isClassStaticBlockDeclaration(node)) return "static-block";
  if (tsRuntime.isBlock(node)) {
    return isFunctionLike(node.parent) && node.parent.body === node ? "function-body" : "block";
  }
  return tsRuntime.isCaseBlock(node) ||
    tsRuntime.isCatchClause(node) ||
    tsRuntime.isForStatement(node) ||
    tsRuntime.isForInStatement(node) ||
    tsRuntime.isForOfStatement(node) ||
    tsRuntime.isModuleBlock(node)
    ? "block"
    : undefined;
}

function addBindingName(scope: LexicalScope, name: ts.BindingName): void {
  if (tsRuntime.isIdentifier(name)) {
    scope.bindings.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!tsRuntime.isOmittedExpression(element)) addBindingName(scope, element.name);
  }
}

function nearestVarScope(scope: LexicalScope): LexicalScope {
  let candidate = scope;
  while (
    candidate.kind !== "function-body" &&
    candidate.kind !== "source" &&
    candidate.kind !== "static-block" &&
    candidate.parent !== undefined
  ) {
    candidate = candidate.parent;
  }
  return candidate;
}

function hasDeclareModifier(node: ts.Node): boolean {
  return (
    tsRuntime.canHaveModifiers(node) &&
    tsRuntime
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === tsRuntime.SyntaxKind.DeclareKeyword) === true
  );
}

function isAmbientDeclaration(node: ts.Node): boolean {
  let candidate: ts.Node | undefined = node;
  while (candidate !== undefined && !tsRuntime.isSourceFile(candidate)) {
    if (hasDeclareModifier(candidate)) return true;
    candidate = candidate.parent;
  }
  return candidate?.isDeclarationFile === true;
}

function isTypeOnlyImport(
  node: ts.ImportClause | ts.ImportSpecifier | ts.NamespaceImport,
): boolean {
  if (tsRuntime.isImportClause(node)) return node.isTypeOnly;
  if (tsRuntime.isImportSpecifier(node) && node.isTypeOnly) return true;
  const importClause = tsRuntime.isNamespaceImport(node) ? node.parent : node.parent.parent;
  return tsRuntime.isImportClause(importClause) && importClause.isTypeOnly;
}

function collectLexicalScopes(sourceFile: ts.SourceFile): Map<ts.Node, LexicalScope> {
  const scopeByNode = new Map<ts.Node, LexicalScope>();
  const collect = (node: ts.Node, parentScope?: LexicalScope): void => {
    if (
      parentScope !== undefined &&
      !isAmbientDeclaration(node) &&
      ((tsRuntime.isFunctionDeclaration(node) && node.name !== undefined) ||
        (tsRuntime.isClassDeclaration(node) && node.name !== undefined) ||
        (tsRuntime.isEnumDeclaration(node) && node.name !== undefined) ||
        (tsRuntime.isModuleDeclaration(node) && tsRuntime.isIdentifier(node.name)))
    ) {
      parentScope.bindings.add(node.name.text);
    }

    const kind = scopeKind(node);
    const scope =
      kind === undefined
        ? parentScope
        : ({
            bindings: new Set<string>(),
            kind,
            parent: parentScope,
          } satisfies LexicalScope);
    if (scope === undefined) throw new Error("portable guard source is missing its source scope");
    scopeByNode.set(node, scope);

    if (isFunctionLike(node)) {
      for (const parameter of node.parameters) addBindingName(scope, parameter.name);
      if (tsRuntime.isFunctionExpression(node) && node.name !== undefined) {
        scope.bindings.add(node.name.text);
      }
    } else if (
      (tsRuntime.isClassDeclaration(node) || tsRuntime.isClassExpression(node)) &&
      node.name !== undefined
    ) {
      scope.bindings.add(node.name.text);
    } else if (tsRuntime.isCatchClause(node) && node.variableDeclaration !== undefined) {
      addBindingName(scope, node.variableDeclaration.name);
    } else if (tsRuntime.isVariableDeclaration(node) && !isAmbientDeclaration(node)) {
      const declarationList = node.parent;
      const target =
        tsRuntime.isVariableDeclarationList(declarationList) &&
        (declarationList.flags & tsRuntime.NodeFlags.BlockScoped) === 0
          ? nearestVarScope(scope)
          : scope;
      addBindingName(target, node.name);
    } else if (tsRuntime.isImportClause(node) && !isTypeOnlyImport(node)) {
      if (node.name !== undefined) scope.bindings.add(node.name.text);
    } else if (
      (tsRuntime.isImportSpecifier(node) || tsRuntime.isNamespaceImport(node)) &&
      !isTypeOnlyImport(node)
    ) {
      scope.bindings.add(node.name.text);
    }

    tsRuntime.forEachChild(node, (child) => collect(child, scope));
  };
  collect(sourceFile);
  return scopeByNode;
}

function isDeclarationOrPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (tsRuntime.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (
    (tsRuntime.isPropertyAssignment(parent) ||
      tsRuntime.isPropertyDeclaration(parent) ||
      tsRuntime.isPropertySignature(parent) ||
      tsRuntime.isEnumMember(parent) ||
      tsRuntime.isMethodDeclaration(parent) ||
      tsRuntime.isMethodSignature(parent) ||
      tsRuntime.isGetAccessorDeclaration(parent) ||
      tsRuntime.isSetAccessorDeclaration(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (
    (tsRuntime.isVariableDeclaration(parent) ||
      tsRuntime.isParameter(parent) ||
      tsRuntime.isFunctionDeclaration(parent) ||
      tsRuntime.isFunctionExpression(parent) ||
      tsRuntime.isClassDeclaration(parent) ||
      tsRuntime.isClassExpression(parent) ||
      tsRuntime.isEnumDeclaration(parent) ||
      tsRuntime.isInterfaceDeclaration(parent) ||
      tsRuntime.isModuleDeclaration(parent) ||
      tsRuntime.isTypeAliasDeclaration(parent) ||
      tsRuntime.isTypeParameterDeclaration(parent) ||
      tsRuntime.isImportClause(parent) ||
      tsRuntime.isImportSpecifier(parent) ||
      tsRuntime.isNamespaceImport(parent) ||
      tsRuntime.isBindingElement(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (tsRuntime.isBindingElement(parent) && parent.propertyName === node) return true;
  if (
    tsRuntime.isImportSpecifier(parent) ||
    (tsRuntime.isLabeledStatement(parent) && parent.label === node) ||
    ((tsRuntime.isBreakStatement(parent) || tsRuntime.isContinueStatement(parent)) &&
      parent.label === node)
  ) {
    return true;
  }
  if (tsRuntime.isExportSpecifier(parent)) {
    const declaration = parent.parent.parent;
    if (!tsRuntime.isExportDeclaration(declaration)) return true;
    if (declaration.moduleSpecifier !== undefined) return true;
    return parent.propertyName !== undefined && parent.name === node;
  }
  return tsRuntime.isQualifiedName(parent) && parent.right === node;
}

function isBound(scope: LexicalScope, name: string): boolean {
  let candidate: LexicalScope | undefined = scope;
  while (candidate !== undefined) {
    if (candidate.bindings.has(name)) return true;
    candidate = candidate.parent;
  }
  return false;
}

export function runtimeGlobalReferenceViolations(
  file: string,
  sourceFile: ts.SourceFile,
  sourceLineOffset = 0,
): readonly PortableModuleViolation[] {
  const scopeByNode = collectLexicalScopes(sourceFile);
  const sourceScope = scopeByNode.get(sourceFile);
  if (sourceScope === undefined) throw new Error("portable guard source scope was not collected");
  const violations: PortableModuleViolation[] = [];
  const add = (node: ts.Node, reason: string): void => {
    const line = lineOf(sourceFile, node) + sourceLineOffset;
    if (violations.some((violation) => violation.line === line && violation.reason === reason)) {
      return;
    }
    violations.push({ file, line, reason });
  };
  const visit = (node: ts.Node): void => {
    const scope = scopeByNode.get(node) ?? sourceScope;
    if (
      tsRuntime.isIdentifier(node) &&
      forbiddenRuntimeGlobals.has(node.text) &&
      !isDeclarationOrPropertyName(node) &&
      !isBound(scope, node.text)
    ) {
      const reason =
        node.text === "require"
          ? "CommonJS require"
          : browserRuntimeGlobals.has(node.text)
            ? `forbidden runtime global ${JSON.stringify(node.text)}`
            : `Node runtime global ${JSON.stringify(node.text)}`;
      add(node, reason);
    }
    tsRuntime.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

async function inspectPortableModule(file: string): Promise<readonly PortableModuleViolation[]> {
  const source = await readFile(file, "utf8");
  const sourceFile = tsRuntime.createSourceFile(
    file,
    source,
    tsRuntime.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );
  const violations: PortableModuleViolation[] = [
    ...runtimeGlobalReferenceViolations(file, sourceFile),
  ];
  const add = (node: ts.Node, reason: string): void => {
    const line = lineOf(sourceFile, node);
    if (!violations.some((violation) => violation.line === line && violation.reason === reason)) {
      violations.push({ file, line, reason });
    }
  };
  const addAtLine = (line: number, reason: string): void => {
    if (!violations.some((violation) => violation.line === line && violation.reason === reason)) {
      violations.push({ file, line, reason });
    }
  };
  for (const edge of sourceModuleEdges(source, sourceFile)) {
    const tripleSlashKind =
      edge.kind === "triple-slash-types"
        ? "type"
        : edge.kind === "triple-slash-path"
          ? "path"
          : "lib";
    const reason =
      edge.kind === "module"
        ? specifierReason(edge.text)
        : `triple-slash ${tripleSlashKind} reference ${JSON.stringify(edge.text)}`;
    if (reason !== undefined) addAtLine(edge.line, reason);
  }
  const visit = (node: ts.Node): void => {
    if (tsRuntime.isImportDeclaration(node) || tsRuntime.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) {
        const specifier = literalSpecifier(node.moduleSpecifier);
        if (specifier === undefined) add(node, "non-literal static module specifier");
      }
    } else if (tsRuntime.isImportEqualsDeclaration(node)) {
      add(node, "TypeScript import-equals");
    } else if (tsRuntime.isExportAssignment(node) && node.isExportEquals) {
      add(node, "TypeScript export-equals");
    } else if (tsRuntime.isImportTypeNode(node)) {
      const specifier = tsRuntime.isLiteralTypeNode(node.argument)
        ? literalSpecifier(node.argument.literal)
        : undefined;
      if (specifier === undefined) add(node, "non-literal TypeScript import type");
    } else if (
      tsRuntime.isCallExpression(node) &&
      node.expression.kind === tsRuntime.SyntaxKind.ImportKeyword
    ) {
      const specifier = literalSpecifier(node.arguments[0]);
      if (specifier === undefined) add(node, "non-literal dynamic import");
    }
    tsRuntime.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

export async function portableCoreModuleViolations(
  fixture: Pick<
    CoreClientFixture,
    "portableDeclarationPaths" | "portableModulePaths" | "portableSourcePaths"
  >,
): Promise<readonly PortableModuleViolation[]> {
  return (
    await Promise.all(
      [
        ...fixture.portableSourcePaths,
        ...fixture.portableModulePaths,
        ...fixture.portableDeclarationPaths,
      ].map(inspectPortableModule),
    )
  ).flat();
}

export async function assertPortableCoreModules(
  fixture: Pick<
    CoreClientFixture,
    "portableDeclarationPaths" | "portableModulePaths" | "portableSourcePaths"
  >,
): Promise<void> {
  const violations = await portableCoreModuleViolations(fixture);
  if (violations.length === 0) return;
  const evidence = violations
    .map(({ file, line, reason }) => `${file}:${line}: ${reason}`)
    .join("\n");
  throw new Error(`portable Core source/emitted module gate rejected:\n${evidence}`);
}
