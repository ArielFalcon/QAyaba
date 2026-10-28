/* Which tests of a delivered spec cover a state DEV cannot be brought to by fulfilling the responses they need, decided from the spec's text alone. The detector reads the syntax tree (a comment or a string that mentions `page.route` is not an interception) and answers three things: which tests are stubbed, which interceptions break the guards, and which spec files have no live test beside their stubbed ones.
   A test is stubbed when its body, a hook above it, a function of the same file it calls, or a helper it takes from another module intercepts requests (`route` with a handler, `routeFromHAR`, `routeWebSocket`, a script that replaces `fetch` or XMLHttpRequest, a bare `fulfill`). What the detector cannot read is stubbed, never live: a helper from another module is read as an interception because its body is not here.
   The guards (docs/stubbed-state.md): only a read is fulfilled, a write is never faked as succeeded and never let through changed, and a stubbed test sits beside the live test of its page. A fulfil is accepted only behind an explicit GET check of the request's method, because a route pattern cannot say which method it answers; a `continue` or `fallback` that sets the method or the body, a HAR replay (it answers every method) and a handler that is not in the file are violations too. A violation is a record for the reader, decided here and never a verdict. */

import ts from "typescript";

export interface SpecText {
  file: string;
  text: string;
}

/* A test that is stubbed. `response` is the response it states in its title (`[stubbed: <what the response says>]`), `routes` the url patterns it intercepts that could be read; both empty means a helper the detector cannot read intercepts for it. `fulfils` is the names of the fields, at every depth, of the bodies it fulfils when the spec states them (a literal, a stringified literal, a constant of the file): names only, never a value; absent when the body is not in the spec. */
export interface StubbedTest {
  file: string;
  name: string;
  response?: string;
  routes: string[];
  fulfils?: string[];
}

export type StubbedViolationKind =
  /* A fulfil no explicit GET check of the request's method guards: it would answer a write too. */
  | "fulfil-without-get-guard"
  /* A route handler that is not a function of this file: it cannot be shown to fulfil only reads. */
  | "unverifiable-handler"
  /* A `continue` or `fallback` that sets the request's method or body, or whose override the detector cannot read and no GET check guards. */
  | "override-changes-request"
  /* A HAR replay answers every method it recorded. */
  | "har-replay"
  /* Every test of the spec file is stubbed: nothing live sits beside them. */
  | "no-live-test";

export interface StubbedViolation {
  file: string;
  kind: StubbedViolationKind;
  /* The test the violation sits in; absent for one outside any test (a hook, a helper) and for the file-level kind. */
  test?: string;
  line: number;
}

export interface StubbedStateReport {
  /* Spec files that hold at least one stubbed test. */
  specFiles: number;
  tests: StubbedTest[];
  violations: StubbedViolation[];
}

/* The most url patterns kept for one test and the longest one, so a spec cannot grow its record. */
const MAX_ROUTES_PER_TEST = 5;
const MAX_ROUTE_CHARS = 160;
/* The most field names kept for the bodies one test fulfils, how deep a stated body is read, and the longest name. */
const MAX_FULFILLED_NAMES = 100;
const MAX_BODY_DEPTH = 8;
const MAX_NAME_CHARS = 64;

const FIXTURES_SPECIFIER = /^(?:\.{1,2}\/)+fixtures(?:\.js|\.ts)?$/;
const STUB_MARKER = /^\s*\[stubbed:\s*([^\]]+?)\s*\]/i;
const HOOKS = new Set(["beforeEach", "beforeAll", "afterEach", "afterAll"]);
const TEST_MODIFIERS = new Set(["only", "skip", "fixme", "fail", "slow"]);
const DESCRIBE_MODIFIERS = new Set(["only", "skip", "fixme", "serial", "parallel"]);
const REQUEST_REPLACING_SCRIPT = /\b(?:fetch|XMLHttpRequest|WebSocket)\b/;

type Fn = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

interface Interception {
  /* `route`: a handler answers; `har`: a recorded replay; `socket`: a fake WebSocket server; `script`: a script replaces the request API; `fulfil`: a fulfil with no registration in sight; `helper`: a function from another module. */
  kind: "route" | "har" | "socket" | "script" | "fulfil" | "helper";
  pattern?: string;
  /* `fulfil`: the field names of the body the call states. */
  names?: string[];
}

const isFn = (node: ts.Node | undefined): node is Fn => node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node));

const unwrap = (node: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) ? unwrap(node.expression) : node);

const literalText = (node: ts.Node | undefined): string | undefined => (node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined);

/* The method a call is named by: `x.name(...)` gives `name`. */
function memberName(call: ts.CallExpression): string | undefined {
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : undefined;
}

/* `test`, `test.only`, `test.describe.serial`: the identifier a chain starts at and the names after it. */
function chainOf(expression: ts.Expression): { root: string; names: string[] } | undefined {
  const names: string[] = [];
  let current = expression;
  while (ts.isPropertyAccessExpression(current)) {
    names.unshift(current.name.text);
    current = current.expression;
  }
  return ts.isIdentifier(current) ? { root: current.text, names } : undefined;
}

function callbackOf(call: ts.CallExpression): Fn | undefined {
  const last = call.arguments[call.arguments.length - 1];
  return isFn(last) ? last : undefined;
}

type Structural = { kind: "test"; name: string; body: Fn } | { kind: "describe"; name: string; body: Fn } | { kind: "hook"; body: Fn };

/* What a call is in a spec's structure: a test, a describe block or a hook, or none of them. */
function structuralCall(call: ts.CallExpression): Structural | undefined {
  const chain = chainOf(call.expression);
  const body = callbackOf(call);
  if (chain === undefined || body === undefined) return undefined;
  const name = literalText(call.arguments[0]) ?? (call.arguments[0] !== undefined && ts.isTemplateExpression(call.arguments[0]) ? call.arguments[0].getText() : "");
  if ((chain.root === "test" || chain.root === "it") && chain.names.every((n) => TEST_MODIFIERS.has(n)) && call.arguments.length >= 2) return { kind: "test", name: name || "(unnamed)", body };
  if (chain.root === "test" && chain.names[0] === "describe" && chain.names.slice(1).every((n) => DESCRIBE_MODIFIERS.has(n))) return { kind: "describe", name, body };
  if (chain.root === "test" && chain.names.length === 1 && HOOKS.has(chain.names[0]!)) return { kind: "hook", body };
  return undefined;
}

/* A string or regular expression a route is registered with, or "(computed)". */
function patternOf(node: ts.Expression | undefined): string {
  const text = literalText(node) ?? (node !== undefined && ts.isRegularExpressionLiteral(node) ? node.text : "(computed)");
  return text.length <= MAX_ROUTE_CHARS ? text : `${text.slice(0, MAX_ROUTE_CHARS)}…`;
}

/* Whether the expression reads a request's method: it names `method`. */
const mentionsMethod = (node: ts.Expression): boolean => /method/i.test(node.getText());

const isGetLiteral = (node: ts.Expression): boolean => literalText(unwrap(node))?.toUpperCase() === "GET";

/* `method === "GET"`, alone or as one side of `&&`. */
function positiveGet(condition: ts.Expression): boolean {
  const node = unwrap(condition);
  if (!ts.isBinaryExpression(node)) return false;
  const op = node.operatorToken.kind;
  if (op === ts.SyntaxKind.AmpersandAmpersandToken) return positiveGet(node.left) || positiveGet(node.right);
  if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.EqualsEqualsToken) return false;
  return (isGetLiteral(node.right) && mentionsMethod(node.left)) || (isGetLiteral(node.left) && mentionsMethod(node.right));
}

/* `method !== "GET"`, `!(method === "GET")`, alone or as one side of `||`. */
function negativeGet(condition: ts.Expression): boolean {
  const node = unwrap(condition);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return positiveGet(node.operand);
  if (!ts.isBinaryExpression(node)) return false;
  const op = node.operatorToken.kind;
  if (op === ts.SyntaxKind.BarBarToken) return negativeGet(node.left) || negativeGet(node.right);
  if (op !== ts.SyntaxKind.ExclamationEqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsToken) return false;
  return (isGetLiteral(node.right) && mentionsMethod(node.left)) || (isGetLiteral(node.left) && mentionsMethod(node.right));
}

/* A statement that leaves the handler: `return`, `throw`, or a block ending in one. */
function exits(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  return ts.isBlock(statement) && statement.statements.length > 0 && exits(statement.statements[statement.statements.length - 1]!);
}

/* Whether an explicit GET check dominates the node: an enclosing `if` or `?:` on the GET branch, a `&&` after the check, or an earlier statement of an enclosing block that leaves the handler unless the method is GET. */
function guardedToGet(node: ts.Node): boolean {
  let child: ts.Node = node;
  for (let parent: ts.Node | undefined = node.parent; parent !== undefined; child = parent, parent = parent.parent) {
    if (ts.isIfStatement(parent)) {
      if (child === parent.thenStatement && positiveGet(parent.expression)) return true;
      if (child === parent.elseStatement && negativeGet(parent.expression)) return true;
    } else if (ts.isConditionalExpression(parent)) {
      if (child === parent.whenTrue && positiveGet(parent.condition)) return true;
      if (child === parent.whenFalse && negativeGet(parent.condition)) return true;
    } else if (ts.isBinaryExpression(parent) && child === parent.right) {
      if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && positiveGet(parent.left)) return true;
      if (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken && negativeGet(parent.left)) return true;
    } else if (ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
      for (const earlier of parent.statements) {
        if (earlier === child) break;
        if (ts.isIfStatement(earlier) && earlier.elseStatement === undefined && negativeGet(earlier.expression) && exits(earlier.thenStatement)) return true;
      }
    }
  }
  return false;
}

/* Whether a `continue` or `fallback` argument sets the request's method or body. */
function overridesRequest(argument: ts.Expression): boolean {
  const node = unwrap(argument);
  if (!ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ["method", "postData"].includes((p.name as ts.Identifier | ts.StringLiteral).text));
}

class FileAnalysis {
  readonly sf: ts.SourceFile;
  /* Functions of this file by name: a declaration, or a constant holding an arrow or function expression. */
  private readonly functions = new Map<string, Fn>();
  /* Names bound by an import of a module that is not the suite's fixtures. */
  private readonly foreign = new Set<string>();
  /* Constants of this file holding an object or array literal. */
  private readonly literals = new Map<string, ts.Expression>();

  constructor(readonly file: string, text: string) {
    this.sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    this.index(this.sf);
  }

  /* A module with a syntax error would not load: it contributes nothing. */
  get parses(): boolean {
    const diagnostics = (this.sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
    return diagnostics === undefined || diagnostics.length === 0;
  }

  private index(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) this.functions.set(node.name.text, node);
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && isFn(node.initializer as ts.Node)) this.functions.set(node.name.text, node.initializer as Fn);
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0) this.literals.set(node.name.text, node.initializer);
    else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith(".") && !FIXTURES_SPECIFIER.test(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (clause !== undefined && !clause.isTypeOnly) {
        if (clause.name !== undefined) this.foreign.add(clause.name.text);
        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) this.foreign.add(bindings.name.text);
        if (bindings !== undefined && ts.isNamedImports(bindings)) for (const element of bindings.elements) if (!element.isTypeOnly) this.foreign.add(element.name.text);
      }
    }
    ts.forEachChild(node, (child) => this.index(child));
  }

  private rootName(expression: ts.Expression): string | undefined {
    let current = expression;
    while (ts.isPropertyAccessExpression(current)) current = current.expression;
    return ts.isIdentifier(current) ? current.text : undefined;
  }

  /* Every interception under a node, following the functions of this file it calls. */
  interceptions(node: ts.Node, seen: Set<ts.Node> = new Set()): Interception[] {
    const found: Interception[] = [];
    const visit = (current: ts.Node): void => {
      if (ts.isCallExpression(current)) {
        const member = memberName(current);
        if (member === "route" && current.arguments.length >= 2) found.push({ kind: "route", pattern: patternOf(current.arguments[0]) });
        else if (member === "routeFromHAR") found.push({ kind: "har", pattern: patternOf(current.arguments[0]) });
        else if (member === "routeWebSocket") found.push({ kind: "socket", pattern: patternOf(current.arguments[0]) });
        else if (member === "addInitScript" && REQUEST_REPLACING_SCRIPT.test(current.getText())) found.push({ kind: "script" });
        else if (member === "fulfill") found.push({ kind: "fulfil", names: this.fulfilledNames(current) });
        const root = this.rootName(current.expression);
        if (ts.isIdentifier(current.expression)) {
          const local = this.functions.get(current.expression.text);
          if (local !== undefined && !seen.has(local)) {
            seen.add(local);
            found.push(...this.interceptions(local, seen));
          }
        }
        if (root !== undefined && this.foreign.has(root)) found.push({ kind: "helper" });
      }
      ts.forEachChild(current, visit);
    };
    visit(node);
    return found;
  }

  /* The names of the fields, at every depth, of the body a `fulfill` call states (`json`, or a `body` that is a literal or its `JSON.stringify`), or none when the spec does not state it. */
  fulfilledNames(call: ts.CallExpression): string[] {
    const names = new Set<string>();
    const visit = (expression: ts.Expression | undefined, depth: number): void => {
      if (expression === undefined || depth > MAX_BODY_DEPTH || names.size >= MAX_FULFILLED_NAMES) return;
      const node = unwrap(expression);
      if (ts.isIdentifier(node)) return visit(this.literals.get(node.text), depth + 1);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "stringify") return visit(node.arguments[0], depth + 1);
      if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return visit(node.expression, depth);
      if (ts.isArrayLiteralExpression(node)) return void node.elements.forEach((element) => visit(element, depth + 1));
      if (!ts.isObjectLiteralExpression(node)) return;
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
        const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
        if (name !== undefined && name.length <= MAX_NAME_CHARS) names.add(name);
        visit(ts.isPropertyAssignment(property) ? property.initializer : property.name, depth + 1);
      }
    };
    const options = call.arguments[0] === undefined ? undefined : unwrap(call.arguments[0]);
    if (options !== undefined && ts.isObjectLiteralExpression(options)) {
      for (const property of options.properties) {
        if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && (property.name.text === "json" || property.name.text === "body")) visit(property.initializer, 0);
      }
    }
    return [...names].sort();
  }

  resolveHandler(argument: ts.Expression | undefined): Fn | undefined {
    if (argument === undefined) return undefined;
    const node = unwrap(argument);
    if (isFn(node)) return node;
    return ts.isIdentifier(node) ? this.functions.get(node.text) : undefined;
  }

  line(node: ts.Node): number {
    return this.sf.getLineAndCharacterOfPosition(node.getStart(this.sf)).line + 1;
  }
}

interface Scope {
  /* The interceptions the hooks above the current test run. */
  hooked: Interception[];
  /* The response a describe block states for its tests. */
  response: string | undefined;
}

const responseOf = (name: string): string | undefined => STUB_MARKER.exec(name)?.[1];

/* Hooks of a scope: the hook calls under a body that are not inside one of its own tests or describe blocks. */
function hooksOf(body: ts.Node): Fn[] {
  const hooks: Fn[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const structural = structuralCall(node);
      if (structural?.kind === "hook") hooks.push(structural.body);
      if (structural?.kind === "test" || structural?.kind === "describe") return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return hooks;
}

function analyse(spec: SpecText): { tests: StubbedTest[]; violations: StubbedViolation[]; liveTests: number } {
  const analysis = new FileAnalysis(spec.file, spec.text);
  const empty = { tests: [], violations: [], liveTests: 0 };
  if (!analysis.parses) return empty;
  const tests: StubbedTest[] = [];
  let liveTests = 0;

  const walkScope = (body: ts.Node, scope: Scope): void => {
    const hooked = [...scope.hooked, ...hooksOf(body).flatMap((hook) => analysis.interceptions(hook))];
    const inner: Scope = { hooked, response: scope.response };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const structural = structuralCall(node);
        if (structural?.kind === "describe") {
          walkScope(structural.body, { hooked, response: responseOf(structural.name) ?? inner.response });
          return;
        }
        if (structural?.kind === "hook") return;
        if (structural?.kind === "test") {
          const own = analysis.interceptions(structural.body);
          const all = [...hooked, ...own];
          if (all.length === 0) {
            liveTests += 1;
          } else {
            const response = responseOf(structural.name) ?? inner.response;
            const routes = [...new Set(all.filter((i) => i.pattern !== undefined).map((i) => i.pattern!))].slice(0, MAX_ROUTES_PER_TEST);
            const fulfils = [...new Set(all.flatMap((i) => i.names ?? []))].sort().slice(0, MAX_FULFILLED_NAMES);
            tests.push({ file: spec.file, name: structural.name, ...(response !== undefined ? { response } : {}), routes, ...(fulfils.length > 0 ? { fulfils } : {}) });
          }
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(body, visit);
  };
  walkScope(analysis.sf, { hooked: [], response: undefined });

  /* The test a node sits in, by name. */
  const testOf = (node: ts.Node): string | undefined => {
    for (let parent: ts.Node | undefined = node.parent; parent !== undefined; parent = parent.parent) {
      if (ts.isCallExpression(parent)) {
        const structural = structuralCall(parent);
        if (structural?.kind === "test") return structural.name;
      }
    }
    return undefined;
  };
  const violations: StubbedViolation[] = [];
  const seen = new Set<string>();
  const violate = (kind: StubbedViolationKind, node: ts.Node): void => {
    const line = analysis.line(node);
    if (seen.has(`${kind}:${line}`)) return;
    seen.add(`${kind}:${line}`);
    const test = testOf(node);
    violations.push({ file: spec.file, kind, ...(test !== undefined ? { test } : {}), line });
  };
  const scan = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const member = memberName(node);
      if (member === "fulfill" && !guardedToGet(node)) violate("fulfil-without-get-guard", node);
      if (member === "routeFromHAR") violate("har-replay", node);
      if (member === "route" && node.arguments.length >= 2 && analysis.resolveHandler(node.arguments[1]) === undefined) violate("unverifiable-handler", node);
      if ((member === "continue" || member === "fallback") && node.arguments.length > 0) {
        const argument = node.arguments[0]!;
        if (overridesRequest(argument) || (!ts.isObjectLiteralExpression(unwrap(argument)) && !guardedToGet(node))) violate("override-changes-request", node);
      }
    }
    ts.forEachChild(node, scan);
  };
  scan(analysis.sf);
  if (tests.length > 0 && liveTests === 0) violations.push({ file: spec.file, kind: "no-live-test", line: 1 });
  return { tests, violations, liveTests };
}

/* The stubbed tests of the delivered specs, and what breaks the guards. Pure: the caller reads the specs through the confined reader. */
export function detectStubbedState(specs: readonly SpecText[]): StubbedStateReport {
  const tests: StubbedTest[] = [];
  const violations: StubbedViolation[] = [];
  for (const spec of specs) {
    const found = analyse(spec);
    tests.push(...found.tests);
    violations.push(...found.violations);
  }
  return { specFiles: new Set(tests.map((t) => t.file)).size, tests, violations };
}
