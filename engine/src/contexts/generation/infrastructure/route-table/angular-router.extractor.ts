/*
 * The Angular router's route-table extractor: the route arrays of one source file, read with the TypeScript compiler's parser
 * (no type checking, nothing resolved across files: the loader does that). A route array is an array literal of object literals
 * at least one of which has a `path` or a `matcher` and a key of the router's Route configuration; a `children` array is read
 * as its entry's children. Framework knowledge only (the Route keys), never an app's. Pure: no file is read here.
 */
import ts from "typescript";

/* A value the loader resolves: a literal, or a reference to a constant (`RoutePath.Home`, or a plain identifier), with the module it is imported from when it is. */
export type RawValue = { literal: string } | { ref: string; member?: string; module?: string; imported?: string } | { opaque: true };

/* A guard as written: a name (a call's callee for a guard factory) with the module it is imported from, or an inline function. */
export type RawGuard = { name: string; imported?: string; module?: string; local: boolean } | { inline: true; text: string };

/* What a module exports under one name: a name it declares or imports, or another module's export it re-exports. */
export type RawExport = { local: string } | { module: string; imported: string };

/* What an import brings in: the module it names and the export it takes there (`default` for a default import, `*` for a namespace). */
export interface RawImport {
  module: string;
  imported: string;
}

/* A table an entry's children come from that is not inline: a lazily loaded module (and the export it takes), or a named array of this file or of an imported module (then `name` is the export it takes there, not a local alias). */
export interface RawChildRef {
  module?: string;
  name?: string;
  unresolved?: true;
  /* Why the extractor could not name the table, when `unresolved`. */
  why?: string;
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
  /* Local name → the module and the export of each import. */
  imports: Map<string, RawImport>;
  /* The names this file declares at its top level. */
  declared: Set<string>;
  /* What the file exports, by exported name, and the modules it re-exports whole (`export * from`). */
  exports: Map<string, RawExport>;
  stars: string[];
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
  const imports = new Map<string, RawImport>();
  const declared = new Set<string>();
  const exports = new Map<string, RawExport>();
  const stars: string[] = [];
  const hasModifier = (statement: ts.Node, kind: ts.SyntaxKind): boolean => ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((m) => m.kind === kind);
  const exportDeclared = (statement: ts.Node, name: string): void => {
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return;
    exports.set(hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? "default" : name, { local: name });
  };
  const constants = new Map<string, string>();
  /* The initializer of each top-level `const` of this file, by name. */
  const initializers = new Map<string, ts.Expression>();
  const stringOf = (e: ts.Expression): string | undefined => {
    const b = bare(e);
    return ts.isStringLiteral(b) || ts.isNoSubstitutionTemplateLiteral(b) ? b.text : undefined;
  };
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const module = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause?.name) imports.set(clause.name.text, { module, imported: "default" });
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) imports.set(element.name.text, { module, imported: (element.propertyName ?? element.name).text });
      if (bindings && ts.isNamespaceImport(bindings)) imports.set(bindings.name.text, { module, imported: "*" });
    } else if (ts.isExportDeclaration(statement)) {
      const from = statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
      const clause = statement.exportClause;
      if (clause === undefined) {
        if (from !== undefined) stars.push(from);
      } else if (ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const taken = (element.propertyName ?? element.name).text;
          exports.set(element.name.text, from === undefined ? { local: taken } : { module: from, imported: taken });
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      if (!statement.isExportEquals && ts.isIdentifier(statement.expression)) exports.set("default", { local: statement.expression.text });
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        declared.add(decl.name.text);
        exportDeclared(statement, decl.name.text);
        if (decl.initializer === undefined) continue;
        const name = decl.name.text;
        if ((statement.declarationList.flags & ts.NodeFlags.Const) !== 0) initializers.set(name, decl.initializer);
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
      exportDeclared(statement, statement.name.text);
      for (const member of statement.members) {
        const value = member.initializer ? stringOf(member.initializer) : undefined;
        if (value !== undefined) constants.set(`${statement.name.text}.${member.name.getText(sf)}`, value);
      }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      declared.add(statement.name.text);
      exportDeclared(statement, statement.name.text);
    }
  }
  const valueOf = (e: ts.Expression): RawValue => {
    const literal = stringOf(e);
    if (literal !== undefined) return { literal };
    const b = bare(e);
    const from = (name: string): { module?: string; imported?: string } => {
      const bound = imports.get(name);
      return bound === undefined ? {} : { module: bound.module, imported: bound.imported };
    };
    if (ts.isIdentifier(b)) return { ref: b.text, ...from(b.text) };
    if (ts.isPropertyAccessExpression(b) && ts.isIdentifier(b.expression)) return { ref: b.expression.text, member: b.name.text, ...from(b.expression.text) };
    return { opaque: true };
  };
  const guardOf = (e: ts.Expression): RawGuard => {
    const b = bare(e);
    const callee = ts.isCallExpression(b) ? bare(b.expression) : b;
    if (ts.isIdentifier(callee)) {
      const bound = imports.get(callee.text);
      /* A name is the export it takes from its module, not the local alias it is bound to. */
      return { name: bound?.imported ?? callee.text, local: declared.has(callee.text), ...(bound !== undefined ? { module: bound.module } : {}) };
    }
    return { inline: true, text: b.getText(sf).replace(/\s+/g, " ") };
  };
  /*
   * The module a `loadChildren` imports and the export its `.then` takes. A `loadChildren` that is a binding of this file
   * (`x`, or `x.loadChildren`, where `x` is a top-level const) is read at the binding's initializer, whatever call builds it.
   * Either way it must hold exactly one dynamic `import()`, and with a static specifier; anything else is unresolved.
   */
  const lazyOf = (init: ts.Expression): RawChildRef => {
    const b = bare(init);
    const bound = ts.isIdentifier(b) ? b : ts.isPropertyAccessExpression(b) && ts.isIdentifier(b.expression) ? b.expression : undefined;
    const source = bound === undefined ? init : initializers.get(bound.text);
    if (source === undefined) return { unresolved: true, why: `${bound!.text} is not a top-level const of this file` };
    const dynamic: ts.CallExpression[] = [];
    let name: string | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) dynamic.push(node);
      /* `.then((m) => m.ROUTES)`: the export is the property the arrow's body reads. */
      if (name === undefined && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.parent !== undefined && ts.isArrowFunction(node.parent) && node.parent.body === node) name = node.name.text;
      ts.forEachChild(node, visit);
    };
    visit(source);
    const arg = dynamic.length === 1 ? dynamic[0]!.arguments[0] : undefined;
    const module = arg !== undefined && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : undefined;
    const what = bound === undefined ? "its function" : `${bound.text}'s initializer`;
    if (dynamic.length !== 1) return { unresolved: true, why: `${what} holds ${dynamic.length} dynamic import() calls, not exactly one` };
    return module === undefined ? { unresolved: true, why: `${what} imports a specifier that is not a static string` } : { module, ...(name !== undefined ? { name } : {}) };
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
          const bound = imports.get(b.text);
          entry.childRef = bound === undefined ? { name: b.text } : { name: bound.imported, module: bound.module };
        } else {
          entry.childRef = { unresolved: true, why: "children is neither an array literal nor the name of an array" };
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
  return { tables, constants, imports, declared, exports, stars };
}
