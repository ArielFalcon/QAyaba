/*
 * The Angular router's route-table extractor: the route arrays of one source file, read with the TypeScript compiler's parser
 * (no type checking, nothing resolved across files: the loader does that). A route array is an array literal of object literals
 * at least one of which has a `path` or a `matcher` and a key of the router's Route configuration; a `children` array is read
 * as its entry's children. Framework knowledge only (the Route keys), never an app's. Pure: no file is read here.
 */
import ts from "typescript";

/* A value the loader resolves: a literal, or a reference to a constant (`RoutePath.Home`, or a plain identifier), with the module it is imported from when it is. */
export type RawValue = { literal: string } | { ref: string; member?: string; module?: string } | { opaque: true };

/* A guard as written: a name (a call's callee for a guard factory) with the module it is imported from, or an inline function. */
export type RawGuard = { name: string; module?: string; local: boolean } | { inline: true; text: string };

/* A table an entry's children come from that is not inline: a lazily loaded module (and the export it takes), or a named array of this file or of an imported module. */
export interface RawChildRef {
  module?: string;
  name?: string;
  unresolved?: true;
}

export interface RawEntry {
  line: number;
  endLine: number;
  path?: RawValue;
  pathMatchFull: boolean;
  matcher: boolean;
  redirect: boolean;
  /* The entry's own properties (children excluded), each as written with its whitespace collapsed, sorted. */
  ownText: string;
  guards: RawGuard[];
  children?: RawEntry[];
  childRef?: RawChildRef;
}

export interface RawRouteFile {
  /* The route arrays not nested as another entry's children, by the variable that holds them (`""` for an anonymous one), in source order. */
  tables: Array<{ name: string; exported: boolean; entries: RawEntry[] }>;
  /* String constants this file declares: `X` for `const X = 'v'`, `X.k` for an object literal's or an enum's string member. */
  constants: Map<string, string>;
  /* Local name → module specifier of each import. */
  imports: Map<string, string>;
  /* The names this file declares at its top level. */
  declared: Set<string>;
}

/* The keys of the router's Route configuration beside `path`: an object with a path and one of these is a route. */
const ROUTE_KEYS: ReadonlySet<string> = new Set([
  "component", "loadComponent", "loadChildren", "children", "redirectTo", "pathMatch", "canMatch", "canActivate",
  "canActivateChild", "canDeactivate", "canLoad", "resolve", "data", "title", "outlet", "providers", "runGuardsAndResolvers",
]);
/* The keys whose guards decide whether a route is entered at all. */
const GUARD_KEYS: readonly string[] = ["canMatch", "canActivate", "canActivateChild", "canLoad"];

function scriptKindOf(file: string): ts.ScriptKind {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "tsx") return ts.ScriptKind.TSX;
  if (ext === "jsx") return ts.ScriptKind.JSX;
  if (ext === "ts" || ext === "mts" || ext === "cts") return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

const propName = (p: ts.ObjectLiteralElementLike, sf: ts.SourceFile): string | undefined =>
  (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name !== undefined ? p.name.getText(sf).replace(/^['"]|['"]$/g, "") : undefined;

/* An expression with its type assertions and parentheses taken off. */
function bare(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
  return e;
}

function isRouteObject(node: ts.Expression, sf: ts.SourceFile): node is ts.ObjectLiteralExpression {
  if (!ts.isObjectLiteralExpression(node)) return false;
  const names = node.properties.map((p) => propName(p, sf));
  return (names.includes("path") || names.includes("matcher")) && names.some((n) => n !== undefined && ROUTE_KEYS.has(n));
}

function isRouteArray(node: ts.Node, sf: ts.SourceFile): node is ts.ArrayLiteralExpression {
  if (!ts.isArrayLiteralExpression(node) || node.elements.length === 0) return false;
  const elements = node.elements.map((e) => bare(e as ts.Expression));
  return elements.every((e) => ts.isObjectLiteralExpression(e) || ts.isSpreadElement(e)) && elements.some((e) => isRouteObject(e, sf));
}

export function parseAngularRouteFile(file: string, source: string): RawRouteFile | undefined {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const diagnostics = (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) return undefined;
  const line = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const imports = new Map<string, string>();
  const declared = new Set<string>();
  const constants = new Map<string, string>();
  const stringOf = (e: ts.Expression): string | undefined => {
    const b = bare(e);
    return ts.isStringLiteral(b) || ts.isNoSubstitutionTemplateLiteral(b) ? b.text : undefined;
  };
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const module = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause?.name) imports.set(clause.name.text, module);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) imports.set(element.name.text, module);
      if (bindings && ts.isNamespaceImport(bindings)) imports.set(bindings.name.text, module);
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        declared.add(decl.name.text);
        if (decl.initializer === undefined) continue;
        const name = decl.name.text;
        const literal = stringOf(decl.initializer);
        if (literal !== undefined) constants.set(name, literal);
        const init = bare(decl.initializer);
        if (ts.isObjectLiteralExpression(init)) {
          for (const p of init.properties) {
            const key = propName(p, sf);
            const value = ts.isPropertyAssignment(p) ? stringOf(p.initializer) : undefined;
            if (key !== undefined && value !== undefined) constants.set(`${name}.${key}`, value);
          }
        }
      }
    } else if (ts.isEnumDeclaration(statement)) {
      declared.add(statement.name.text);
      for (const member of statement.members) {
        const value = member.initializer ? stringOf(member.initializer) : undefined;
        if (value !== undefined) constants.set(`${statement.name.text}.${member.name.getText(sf)}`, value);
      }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      declared.add(statement.name.text);
    }
  }
  const valueOf = (e: ts.Expression): RawValue => {
    const literal = stringOf(e);
    if (literal !== undefined) return { literal };
    const b = bare(e);
    if (ts.isIdentifier(b)) return { ref: b.text, ...(imports.has(b.text) ? { module: imports.get(b.text)! } : {}) };
    if (ts.isPropertyAccessExpression(b) && ts.isIdentifier(b.expression)) {
      const object = b.expression.text;
      return { ref: object, member: b.name.text, ...(imports.has(object) ? { module: imports.get(object)! } : {}) };
    }
    return { opaque: true };
  };
  const guardOf = (e: ts.Expression): RawGuard => {
    const b = bare(e);
    const callee = ts.isCallExpression(b) ? bare(b.expression) : b;
    if (ts.isIdentifier(callee)) return { name: callee.text, local: declared.has(callee.text), ...(imports.has(callee.text) ? { module: imports.get(callee.text)! } : {}) };
    return { inline: true, text: b.getText(sf).replace(/\s+/g, " ") };
  };
  /* The module a `loadChildren` imports and the export its `.then` takes, read from the first dynamic import of its initializer. */
  const lazyOf = (init: ts.Expression): RawChildRef => {
    let module: string | undefined;
    let name: string | undefined;
    const visit = (node: ts.Node): void => {
      if (module === undefined && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg !== undefined && ts.isStringLiteral(arg)) module = arg.text;
      }
      /* `.then((m) => m.ROUTES)`: the export is the property the arrow's body reads. */
      if (name === undefined && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.parent !== undefined && ts.isArrowFunction(node.parent) && node.parent.body === node) name = node.name.text;
      ts.forEachChild(node, visit);
    };
    visit(init);
    return module === undefined ? { unresolved: true } : { module, ...(name !== undefined ? { name } : {}) };
  };
  const nested = new Set<ts.Node>();
  const entriesOf = (array: ts.ArrayLiteralExpression): RawEntry[] => {
    const out: RawEntry[] = [];
    for (const element of array.elements) {
      const obj = bare(element as ts.Expression);
      if (!isRouteObject(obj, sf)) continue;
      const props = new Map<string, ts.ObjectLiteralElementLike>();
      for (const p of obj.properties) {
        const name = propName(p, sf);
        if (name !== undefined) props.set(name, p);
      }
      const init = (key: string): ts.Expression | undefined => {
        const p = props.get(key);
        return p !== undefined && ts.isPropertyAssignment(p) ? p.initializer : undefined;
      };
      const pathInit = init("path");
      const guards: RawGuard[] = [];
      for (const key of GUARD_KEYS) {
        const list = init(key);
        if (list === undefined) continue;
        const b = bare(list);
        if (ts.isArrayLiteralExpression(b)) for (const g of b.elements) guards.push(guardOf(g as ts.Expression));
        else guards.push({ inline: true, text: b.getText(sf).replace(/\s+/g, " ") });
      }
      const ownText = [...props]
        .filter(([key]) => key !== "children")
        .map(([, p]) => p.getText(sf).replace(/\s+/g, " ").replace(/,\s*([\]}])/g, "$1"))
        .sort()
        .join("; ");
      const entry: RawEntry = {
        line: line(obj.getStart(sf)),
        endLine: line(obj.end),
        ...(pathInit !== undefined ? { path: valueOf(pathInit) } : {}),
        pathMatchFull: init("pathMatch") !== undefined && stringOf(init("pathMatch")!) === "full",
        matcher: props.has("matcher"),
        redirect: props.has("redirectTo"),
        ownText,
        guards,
      };
      const children = init("children");
      if (children !== undefined) {
        const b = bare(children);
        if (ts.isArrayLiteralExpression(b)) {
          nested.add(b);
          entry.children = entriesOf(b);
        } else if (ts.isIdentifier(b)) {
          entry.childRef = { name: b.text, ...(imports.has(b.text) ? { module: imports.get(b.text)! } : {}) };
        } else {
          entry.childRef = { unresolved: true };
        }
      }
      const lazy = init("loadChildren");
      if (lazy !== undefined) entry.childRef = lazyOf(lazy);
      out.push(entry);
    }
    return out;
  };
  const tables: RawRouteFile["tables"] = [];
  const visit = (node: ts.Node, holder: { name: string; exported: boolean }): void => {
    if (isRouteArray(node, sf) && !nested.has(node)) {
      tables.push({ ...holder, entries: entriesOf(node) });
      return;
    }
    let next = holder;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const statement = node.parent?.parent;
      const exported = statement !== undefined && ts.isVariableStatement(statement) && (statement.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      next = { name: node.name.text, exported };
    }
    ts.forEachChild(node, (child) => visit(child, next));
  };
  visit(sf, { name: "", exported: false });
  return { tables, constants, imports, declared };
}
