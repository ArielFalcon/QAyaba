/*
 * What a consumer's own TypeScript (and JavaScript with declared types) expects of the answer to a request, read with the
 * compiler over the repository's sources: no framework is known and no HTTP client is named. A call site is any call whose
 * address argument evaluates to a path (a literal, a template or a concatenation, a constant followed across files; what cannot be
 * evaluated stands for one path segment, and an unresolved leading part is the base address and dropped); it serves a request when
 * the path serves the operation (`requestServesOperation`, the matcher the link resolver uses) and its verb, when its callee names
 * one, is the request's. A link the service-topology resolver already made (the file and the function that issue the call, and the
 * operation) ties a request to a call site whose path cannot be evaluated. Of the call sites that serve a request only those with
 * the most literal segments are kept: a path `/things/{p}` serves `/things/x` and `/archive/things/x` alike, and the more specific
 * one is the one that was meant.
 *
 * The answer's type is the call's own type argument, else the type the enclosing function declares. Its fields are every property
 * name reachable from it, at any depth: a type the program resolves contributes its properties, arrays and the library's
 * containers (`Promise`, `Map`, ...) contribute what they hold, a utility type the library declares (`Partial`, `Pick`, ...) is
 * expanded, and a reference the program cannot resolve (a package that is not installed in the mirror) contributes the properties
 * of its type arguments, which the program can. A declared type that yields no property is unresolved, and an operation one of whose
 * call sites is unresolved has no expectation.
 *
 * A field is expected when non-test code reads a property of that name (`.name`, `["name"]`, a destructured `{ name }`) and no
 * non-test code writes one (an assignment, an increment, a `delete`, an object-literal key or a spread override, a class member with
 * an initialiser): a field the client fills in itself is not the provider's to serve. Names are matched, not symbols: the answer is
 * often handed through code the compiler cannot type without the packages, and a name written anywhere is conservatively the
 * client's. Bounded by the files and bytes the caller reads; fail-open: a source that does not parse contributes what it parsed.
 */
import { posix } from "node:path";
import ts from "typescript";
import { LanguageRegistry } from "@kernel/language-id.ts";
import { requestServesOperation } from "@contexts/service-topology/application/index.ts";
import { MAX_READ_SITES_LISTED, joinExpectations, type CallSiteExpectation, type ConsumerExpectationsOf, type ExpectedField, type SourceSite } from "../../domain/consumer-expectation.ts";

/* A link the service-topology resolver made: the function that issues a call and the operation it serves. */
export interface ExpectationLink {
  file: string;
  symbol: string;
  operation: { verb: string; path: string };
}

export interface TypeScriptExpectationInput {
  /* The files of the repository by path below it: sources, and the module configurations (`tsconfig*.json`, `jsconfig*.json`). */
  files: ReadonlyMap<string, string>;
  isTestFile(file: string): boolean;
  links?: readonly ExpectationLink[];
}

/* Bounds on what a repository can make the extractor hold or walk. */
export const MAX_DECLARED_TYPE_CHARS = 160;
const MAX_TYPE_DEPTH = 8;
const MAX_TYPE_NAMES = 2_000;
const MAX_EVALUATION_DEPTH = 6;
const MAX_SITES_KEPT = 200;
const SYNTAX = "typescript-declared-types";
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
/* The words of a callee's name that say it issues a request: a call that only names an address (resolving it, invalidating a cache entry, a resource key) is no call site of the request. */
const REQUEST_WORDS = new Set([...HTTP_VERBS, "fetch", "request", "ajax"]);
const issuesRequest = (callee: string): boolean => callee.split(/(?=[A-Z])|[^A-Za-z0-9]+/).some((word) => REQUEST_WORDS.has(word.toLowerCase()));
const CONFIG_NAME = /^(?:ts|js)config(?:\.[\w.-]+)?\.json$/;
const PARAM = "{p}";

const absolute = (file: string): string => `/${file}`;
const relative = (path: string): string => (path.startsWith("/") ? path.slice(1) : path);

const isParameter = (segment: string): boolean => /^\{.*\}$/.test(segment) || segment.startsWith(":");
const literalSegments = (path: string): number => path.split("/").filter((segment) => segment !== "" && !isParameter(segment)).length;

/* The compiler options the repository's module configuration declares (its `extends` chain read from the files in hand), under the options this analysis needs. */
function compilerOptionsOf(configs: ReadonlyMap<string, string>): ts.CompilerOptions {
  const declared: ts.CompilerOptions = {};
  const name = LanguageRegistry.expectationModuleConfigs(SYNTAX).find((candidate) => configs.has(candidate));
  if (name !== undefined) {
    const json = ts.parseConfigFileTextToJson(absolute(name), configs.get(name)!);
    if (json.error === undefined && json.config !== undefined) {
      const host: ts.ParseConfigHost = { useCaseSensitiveFileNames: true, readDirectory: () => [], fileExists: (path) => configs.has(relative(path)), readFile: (path) => configs.get(relative(path)) };
      Object.assign(declared, ts.parseJsonConfigFileContent({ ...json.config, files: [], include: [] }, host, "/", undefined, absolute(name)).options);
    }
  }
  return {
    ...declared,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts"],
    types: [],
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    noResolve: false,
    experimentalDecorators: true,
    jsx: declared.jsx ?? ts.JsxEmit.Preserve,
    strict: true,
  };
}

interface Analysis {
  program: ts.Program;
  checker: ts.TypeChecker;
  /* Non-test sources, in the order of their names. */
  files: ts.SourceFile[];
  reads: Map<string, { sites: SourceSite[]; count: number }>;
  writes: Set<string>;
}

const nameText = (name: ts.PropertyName | ts.BindingName | undefined): string | undefined =>
  name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) ? name.text : undefined;

const isAssignmentOperator = (kind: ts.SyntaxKind): boolean => kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;

/* Whether the node is the target of a write: the left of an assignment, the operand of an increment or a `delete`. */
function isWriteTarget(node: ts.Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (ts.isBinaryExpression(parent)) return parent.left === node && isAssignmentOperator(parent.operatorToken.kind);
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken;
  return ts.isDeleteExpression(parent);
}

const lineOf = (sf: ts.SourceFile, node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

type FunctionLike = ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.GetAccessorDeclaration | ts.ConstructorDeclaration;
const isFunctionLike = (node: ts.Node): node is FunctionLike =>
  ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isGetAccessorDeclaration(node) || ts.isConstructorDeclaration(node);

/* The name a function is known by: its own, or the one of the variable, property or member it is assigned to. */
function functionName(fn: FunctionLike): string | undefined {
  if (!ts.isArrowFunction(fn) && !ts.isConstructorDeclaration(fn)) {
    const own = nameText(fn.name);
    if (own !== undefined) return own;
  }
  const parent = fn.parent;
  if (parent !== undefined && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))) return nameText(parent.name);
  return undefined;
}

function enclosingFunctions(node: ts.Node): FunctionLike[] {
  const out: FunctionLike[] = [];
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) if (isFunctionLike(current)) out.push(current);
  return out;
}

function analyse(input: TypeScriptExpectationInput): Analysis | undefined {
  const sources = new Map<string, string>();
  const configs = new Map<string, string>();
  for (const [file, text] of input.files) {
    if (CONFIG_NAME.test(posix.basename(file))) configs.set(file, text);
    else if (LanguageRegistry.expectationSyntaxFor(file) === SYNTAX && !input.isTestFile(file)) sources.set(file, text);
  }
  if (sources.size === 0) return undefined;
  const options = compilerOptionsOf(configs);
  const libDir = posix.dirname(ts.getDefaultLibFilePath(options));
  const isLib = (path: string): boolean => path.startsWith(`${libDir}/`);
  const textOf = (path: string): string | undefined => (isLib(path) ? ts.sys.readFile(path) : sources.get(relative(path)) ?? configs.get(relative(path)));
  const host: ts.CompilerHost = {
    getSourceFile: (name, languageVersion) => {
      const text = textOf(name);
      return text === undefined ? undefined : ts.createSourceFile(name, text, languageVersion, true);
    },
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    writeFile: () => undefined,
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (path) => (isLib(path) ? ts.sys.fileExists(path) : sources.has(relative(path)) || configs.has(relative(path))),
    readFile: textOf,
  };
  const program = ts.createProgram({ rootNames: [...sources.keys()].map(absolute), options, host });
  const checker = program.getTypeChecker();
  const files = [...sources.keys()]
    .sort()
    .filter((file) => !file.endsWith(".d.ts"))
    .flatMap((file) => program.getSourceFile(absolute(file)) ?? []);
  const reads = new Map<string, { sites: SourceSite[]; count: number }>();
  const writes = new Set<string>();
  const read = (name: string, sf: ts.SourceFile, node: ts.Node): void => {
    const held = reads.get(name) ?? { sites: [], count: 0 };
    held.count += 1;
    if (held.sites.length < MAX_SITES_KEPT) held.sites.push({ file: relative(sf.fileName), line: lineOf(sf, node) });
    reads.set(name, held);
  };
  for (const sf of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
        if (isWriteTarget(node)) writes.add(node.name.text);
        else read(node.name.text, sf, node);
      } else if (ts.isElementAccessExpression(node) && (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))) {
        if (isWriteTarget(node)) writes.add(node.argumentExpression.text);
        else read(node.argumentExpression.text, sf, node);
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const name = nameText(node.propertyName) ?? (ts.isIdentifier(node.name) ? node.name.text : undefined);
        if (name !== undefined) read(name, sf, node);
      } else if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
        const name = nameText(node.name);
        if (name !== undefined && node.parent !== undefined && ts.isObjectLiteralExpression(node.parent)) writes.add(name);
      } else if (ts.isPropertyDeclaration(node) && node.initializer !== undefined) {
        const name = nameText(node.name);
        if (name !== undefined) writes.add(name);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { program, checker, files, reads, writes };
}

/* The names a declared type holds at every depth, or undefined when it holds none (it could not be resolved). */
function declaredNames(analysis: Analysis, node: ts.TypeNode): Set<string> | undefined {
  const { checker, program } = analysis;
  const names = new Set<string>();
  const seen = new Set<ts.Type>();
  const inLibrary = (type: ts.Type): boolean => {
    const declarations = type.getSymbol()?.declarations ?? [];
    return declarations.length > 0 && declarations.every((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
  };
  /* A container the library declares (an array, a promise, a map): it holds what its type arguments are, not its own members. A utility type it declares (a mapped type) is expanded. */
  const isContainer = (type: ts.Type): boolean => !(type.flags & ts.TypeFlags.Object && ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) !== 0) && inLibrary(type);
  const addType = (type: ts.Type, depth: number): void => {
    if (depth > MAX_TYPE_DEPTH || names.size >= MAX_TYPE_NAMES || seen.has(type)) return;
    seen.add(type);
    if (type.isUnionOrIntersection()) {
      for (const member of type.types) addType(member, depth);
      return;
    }
    /* Only an object type holds fields: the methods of a primitive, a literal, an enum or a type parameter are the language's, not the provider's. */
    if (!(type.flags & ts.TypeFlags.Object)) return;
    if (isContainer(type)) {
      /* A container of the library (an array, a promise, a map) holds what its type arguments are. */
      if (type.flags & ts.TypeFlags.Object && ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0) for (const argument of checker.getTypeArguments(type as ts.TypeReference)) addType(argument, depth + 1);
      return;
    }
    for (const property of checker.getPropertiesOfType(type)) {
      if (property.name.startsWith("__@") || property.name.startsWith("#")) continue;
      names.add(property.name);
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (declaration !== undefined) addType(checker.getTypeOfSymbolAtLocation(property, declaration), depth + 1);
    }
    for (const info of checker.getIndexInfosOfType(type)) addType(info.type, depth + 1);
  };
  const isUnresolved = (type: ts.Type): boolean => (type as unknown as { intrinsicName?: string }).intrinsicName === "error";
  /* The declarations already followed, so an alias that refers to itself ends. */
  const followed = new Set<ts.Node>();
  const declarationsOf = (name: ts.EntityName | ts.Expression): ts.Declaration[] => {
    let symbol = checker.getSymbolAtLocation(name);
    if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.declarations ?? [];
  };
  /* What a reference the program cannot resolve is made of in the repository's own declarations: the type a local alias names, and the bases a local interface or class extends. */
  const followDeclarations = (reference: ts.TypeReferenceNode | ts.ExpressionWithTypeArguments): void => {
    const name = ts.isTypeReferenceNode(reference) ? reference.typeName : reference.expression;
    for (const declaration of declarationsOf(name)) {
      if (followed.has(declaration) || followed.size >= MAX_TYPE_NAMES) continue;
      followed.add(declaration);
      if (ts.isTypeAliasDeclaration(declaration)) collect(declaration.type);
      else if (ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration)) for (const clause of declaration.heritageClauses ?? []) clause.types.forEach(collect);
    }
  };
  const collect = (current: ts.TypeNode): void => {
    if (ts.isParenthesizedTypeNode(current) || ts.isTypeOperatorNode(current)) return collect(current.type);
    if (ts.isArrayTypeNode(current)) return collect(current.elementType);
    if (ts.isUnionTypeNode(current) || ts.isIntersectionTypeNode(current)) return void current.types.forEach(collect);
    if (ts.isTupleTypeNode(current)) return void current.elements.forEach(collect);
    if (ts.isNamedTupleMember(current)) return collect(current.type);
    const type = checker.getTypeFromTypeNode(current);
    if (isUnresolved(type)) {
      /* A reference the program cannot resolve holds what its type arguments are. */
      if (ts.isTypeReferenceNode(current) || ts.isExpressionWithTypeArguments(current)) {
        current.typeArguments?.forEach(collect);
        followDeclarations(current);
      }
      return;
    }
    /* A library container is read through its type arguments as written, so that one of them the program cannot resolve still gives the properties of its own arguments. */
    if (ts.isTypeReferenceNode(current) && current.typeArguments !== undefined && !type.isUnionOrIntersection() && isContainer(type)) return void current.typeArguments.forEach(collect);
    addType(type, 0);
    /* A local interface or class whose base is a reference the program cannot resolve holds what that base's type arguments are. */
    if (ts.isTypeReferenceNode(current)) {
      for (const declaration of declarationsOf(current.typeName)) {
        if (!(ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration)) || followed.has(declaration)) continue;
        followed.add(declaration);
        for (const clause of declaration.heritageClauses ?? []) for (const base of clause.types) if (isUnresolved(checker.getTypeFromTypeNode(base))) collect(base);
      }
    }
  };
  collect(node);
  return names.size === 0 ? undefined : names;
}

/* The type argument of a call, or else the type the nearest enclosing function declares. */
function declaredTypeOf(call: ts.CallExpression): ts.TypeNode | undefined {
  if (call.typeArguments !== undefined && call.typeArguments.length > 0) return call.typeArguments[0];
  return enclosingFunctions(call).find((fn) => fn.type !== undefined)?.type;
}

function expectationOf(analysis: Analysis, node: ts.Node, symbol: string | undefined, declared: ts.TypeNode | undefined): CallSiteExpectation | undefined {
  if (declared === undefined) return undefined;
  const names = declaredNames(analysis, declared);
  if (names === undefined) return undefined;
  const sf = node.getSourceFile();
  const fields: ExpectedField[] = [];
  for (const name of [...names].sort()) {
    const held = analysis.reads.get(name);
    if (held === undefined || analysis.writes.has(name)) continue;
    fields.push({ name, reads: held.sites.slice(0, MAX_READ_SITES_LISTED), readCount: held.count });
  }
  const text = declared.getText();
  return { site: { file: relative(sf.fileName), line: lineOf(sf, node) }, ...(symbol !== undefined ? { symbol } : {}), declaredType: text.length <= MAX_DECLARED_TYPE_CHARS ? text : `${text.slice(0, MAX_DECLARED_TYPE_CHARS)}…`, fields };
}

/* The path a call's address argument evaluates to, with `{p}` for each part it cannot evaluate, or undefined when it is no path. */
function evaluator(checker: ts.TypeChecker): (node: ts.Expression) => string | undefined {
  const evaluate = (node: ts.Node, depth: number): string | undefined => {
    if (depth > MAX_EVALUATION_DEPTH) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return evaluate(node.expression, depth);
    if (ts.isTemplateExpression(node)) return node.templateSpans.reduce((text, span) => `${text}${evaluate(span.expression, depth + 1) ?? PARAM}${span.literal.text}`, node.head.text);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return `${evaluate(node.left, depth + 1) ?? PARAM}${evaluate(node.right, depth + 1) ?? PARAM}`;
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node);
      if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const declaration = symbol?.valueDeclaration;
      if (declaration === undefined) return undefined;
      if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined && (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0) return evaluate(declaration.initializer, depth + 1);
      if ((ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)) && declaration.initializer !== undefined) return evaluate(declaration.initializer, depth + 1);
      const constant = ts.isEnumMember(declaration) ? checker.getConstantValue(declaration) : undefined;
      return typeof constant === "string" ? constant : undefined;
    }
    return undefined;
  };
  return (node) => evaluate(node, 0);
}

/* A relative path of two segments or more (`api/things`): characters a path holds, a slash between segments, no space. */
const RELATIVE_PATH = /^[\w.~%:@!$&'()*+,;=\-{}]+(?:\/[\w.~%:@!$&'()*+,;=\-{}]*)+$/;

/* A call's path as an operation path: the query and the origin taken off, an unresolved leading part (the base address) dropped, a path relative to the base address (no leading slash) made absolute. Undefined when what is left is no path with a literal segment. */
function operationPathOf(text: string): string | undefined {
  let path = text.split(/[?#]/)[0]!.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  while (path.startsWith(PARAM)) path = path.slice(PARAM.length);
  if (!path.startsWith("/") && RELATIVE_PATH.test(path)) path = `/${path}`;
  return path.startsWith("/") && literalSegments(path) > 0 ? path : undefined;
}

interface Candidate {
  /* The function (or, with none, the call) the request is issued from: the identity of the call site. */
  key: string;
  literals: number;
  expectation: () => CallSiteExpectation | undefined;
}

export function createTypeScriptExpectations(input: TypeScriptExpectationInput): ConsumerExpectationsOf {
  let prepared: { analysis: Analysis; calls: Array<{ call: ts.CallExpression; path: string | undefined; verb: string | undefined }> } | undefined | null = null;
  const prepare = (): NonNullable<typeof prepared> | undefined => {
    if (prepared !== null) return prepared;
    const analysis = analyse(input);
    if (analysis === undefined) return (prepared = undefined);
    const evaluate = evaluator(analysis.checker);
    const calls: Array<{ call: ts.CallExpression; path: string | undefined; verb: string | undefined }> = [];
    for (const sf of analysis.files) {
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && node.arguments.length > 0) {
          const address = node.arguments.slice(0, 2).map((argument) => evaluate(argument)).find((text) => text !== undefined && operationPathOf(text) !== undefined);
          const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : undefined;
          if (address !== undefined && callee !== undefined && issuesRequest(callee)) calls.push({ call: node, path: operationPathOf(address), verb: callee !== undefined && HTTP_VERBS.has(callee.toLowerCase()) ? callee.toUpperCase() : undefined });
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    return (prepared = { analysis, calls });
  };

  return (request) => {
    const ready = prepare();
    if (ready === undefined) return undefined;
    const { analysis, calls } = ready;
    const candidates = new Map<string, Candidate>();
    const keep = (candidate: Candidate): void => {
      if (!candidates.has(candidate.key)) candidates.set(candidate.key, candidate);
    };
    for (const { call, path, verb } of calls) {
      if (path === undefined || (verb !== undefined && verb !== request.method.toUpperCase()) || !requestServesOperation(request.path, { path })) continue;
      const fn = enclosingFunctions(call)[0];
      const sf = call.getSourceFile();
      keep({ key: `${sf.fileName}\0${fn !== undefined ? fn.getStart(sf) : call.getStart(sf)}`, literals: literalSegments(path), expectation: () => expectationOf(analysis, call, fn === undefined ? undefined : functionName(fn), declaredTypeOf(call)) });
    }
    for (const link of input.links ?? []) {
      if (link.operation.verb.toUpperCase() !== request.method.toUpperCase() || !requestServesOperation(request.path, link.operation)) continue;
      const sf = analysis.files.find((file) => relative(file.fileName) === link.file);
      if (sf === undefined) continue;
      const visit = (node: ts.Node): void => {
        if (isFunctionLike(node) && functionName(node) === link.symbol) {
          const inner = (() => {
            let found: ts.CallExpression | undefined;
            const search = (child: ts.Node): void => {
              if (found === undefined && ts.isCallExpression(child) && child.typeArguments !== undefined && child.typeArguments.length > 0) found = child;
              if (found === undefined) ts.forEachChild(child, search);
            };
            search(node);
            return found;
          })();
          keep({ key: `${sf.fileName}\0${node.getStart(sf)}`, literals: literalSegments(link.operation.path), expectation: () => expectationOf(analysis, node, link.symbol, node.type ?? (inner === undefined ? undefined : declaredTypeOf(inner))) });
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    const best = Math.max(0, ...[...candidates.values()].map((candidate) => candidate.literals));
    const serving = [...candidates.values()].filter((candidate) => candidate.literals === best);
    return joinExpectations(serving.map((candidate) => candidate.expectation()));
  };
}
