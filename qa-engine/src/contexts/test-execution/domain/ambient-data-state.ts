/* Which passing cases checked a page only as DEV served it, on a page DEV served confirmed empty, decided from the spec's syntax tree and the run's own reads. The detector reads each test's statements in the order they run (the `beforeEach` hooks of the scopes above it, outermost first, then its body; a `test.step` body in place) and keeps the windows in which the page is as it loaded: a window opens at `page.goto(<path>)` on the test's own `page` fixture and stays open while every statement only reads the page (an `expect` assertion, a locator, a read or a wait). Any other statement is a step of the test's own and ends the windows for the rest of the test, so an empty state the test produced (a filter it applied, data it removed) is never one DEV served.
   A case is an ambient pin when its test asserted at least once, every assertion ran inside an as-loaded window and at least one ran on a page the run read as a confirmed empty state. What the detector cannot read soundly yields no pin, never a guess: a computed title or address, a navigation through a helper, a fixture other than the read-only ones (it may arrange state), a `beforeAll` or `test.use` in the test's scopes, anything but a locator before the first navigation, a title path two tests share, a file that does not parse. A pin is a fact for the reader, never a verdict. */

import ts from "typescript";
import type { QaCase } from "@kernel/qa-case.ts";
import { isRealPass } from "@kernel/case-proof.ts";
import { sameSpecPath } from "@kernel/spec-path.ts";
import type { AmbientDataPin } from "@kernel/page-data-read.ts";
import { chainOf, isFn, literalText, memberName, structuralCall, unwrap, type Fn, type SpecText } from "./stubbed-state.ts";

/* The fixtures a test may take without arranging any state: the page itself and options it only reads. */
const READ_ONLY_FIXTURES = new Set(["page", "baseURL", "browserName", "isMobile"]);
/* Calls that build a locator: nothing runs on the page until a locator is read or acted on. */
const LOCATOR_BUILDERS = new Set(["locator", "getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByAltText", "getByTitle", "getByTestId", "frameLocator", "contentFrame", "filter", "first", "last", "nth", "and", "or"]);
/* Calls that read the page or a locator and change nothing. */
const PAGE_READS = new Set(["count", "textContent", "innerText", "innerHTML", "getAttribute", "isVisible", "isHidden", "isEnabled", "isDisabled", "isEditable", "isChecked", "inputValue", "allTextContents", "allInnerTexts", "boundingBox", "ariaSnapshot", "title", "url"]);
/* Calls that wait on the page and change nothing. */
const PAGE_WAITS = new Set(["waitFor", "waitForLoadState", "waitForURL", "waitForResponse", "waitForSelector"]);
const TEST_ROOTS = new Set(["test", "it"]);
const TITLE_SEPARATOR = " › ";

/* The identifier a chain of property accesses and calls starts at: `expect(x).not.toBe` and `page.getByRole(...).first` give `expect` and `page`. */
function baseOf(expression: ts.Expression): string | undefined {
  let current: ts.Expression = expression;
  for (;;) {
    if (ts.isPropertyAccessExpression(current) || ts.isCallExpression(current) || ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current)) current = current.expression;
    else return ts.isIdentifier(current) ? current.text : undefined;
  }
}

/* The page binding a test or hook destructures from its fixtures, or undefined when it takes a fixture that may arrange state or none can be read. A function that takes no fixtures has no page. */
function pageBindingOf(fn: Fn): { page: string | undefined } | undefined {
  const first = fn.parameters[0];
  if (first === undefined) return { page: undefined };
  if (!ts.isObjectBindingPattern(first.name)) return undefined;
  let page: string | undefined;
  for (const element of first.name.elements) {
    if (element.dotDotDotToken !== undefined) return undefined;
    const key = element.propertyName ?? element.name;
    if (!ts.isIdentifier(key) || !READ_ONLY_FIXTURES.has(key.text)) return undefined;
    if (key.text === "page") {
      if (!ts.isIdentifier(element.name)) return undefined;
      page = element.name.text;
    }
  }
  return { page };
}

/* The path a `goto` opens when it is one from the root with no query or fragment; undefined for any other address. */
function navigationPath(argument: ts.Expression | undefined): string | undefined {
  const text = argument === undefined ? undefined : literalText(unwrap(argument));
  if (text === undefined || !text.startsWith("/") || text.startsWith("//") || /[?#]/.test(text)) return undefined;
  return text;
}

/* What one statement of a test is to the window: a navigation, a read (an assertion or not), or a step of the test's own. */
type Classified = { kind: "navigate"; path: string } | { kind: "read"; asserts: boolean } | { kind: "step"; asserts: boolean };

/* One function (a hook or the test) read with its own bindings: the page fixture and the locators it declares. */
class FunctionReading {
  private readonly locators = new Set<string>();
  constructor(private readonly page: string | undefined) {}

  /* Whether the call only builds a locator, reads, waits or asserts. */
  private readOnlyCall(call: ts.CallExpression): boolean {
    const base = baseOf(call.expression);
    if (base === "expect") return true;
    const member = memberName(call);
    if (member === undefined || base === undefined) return false;
    const onPage = base === this.page || this.locators.has(base);
    return onPage && (LOCATOR_BUILDERS.has(member) || PAGE_READS.has(member) || PAGE_WAITS.has(member));
  }

  /* Whether every call and construction under the node only reads, and whether one of them asserts. */
  private reads(node: ts.Node): { readOnly: boolean; asserts: boolean } {
    let readOnly = true;
    let asserts = false;
    const visit = (current: ts.Node): void => {
      if (ts.isCallExpression(current)) {
        if (!this.readOnlyCall(current)) readOnly = false;
        if (baseOf(current.expression) === "expect") asserts = true;
      } else if (ts.isNewExpression(current) && !(ts.isIdentifier(current.expression) && current.expression.text === "RegExp")) {
        readOnly = false;
      } else if (ts.isBinaryExpression(current) && current.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && current.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        readOnly = false;
      } else if (ts.isPostfixUnaryExpression(current) || ts.isDeleteExpression(current) || (ts.isPrefixUnaryExpression(current) && (current.operator === ts.SyntaxKind.PlusPlusToken || current.operator === ts.SyntaxKind.MinusMinusToken))) {
        readOnly = false;
      }
      ts.forEachChild(current, visit);
    };
    visit(node);
    return { readOnly, asserts };
  }

  /* `page.goto(<path>)` as the whole statement, awaited or kept in a constant; the path is undefined when the address cannot be read. */
  private navigation(statement: ts.Statement): { path: string | undefined } | undefined {
    let expression: ts.Expression | undefined;
    if (ts.isExpressionStatement(statement)) expression = statement.expression;
    else if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) expression = statement.declarationList.declarations[0]!.initializer;
    if (expression === undefined) return undefined;
    const call = unwrap(expression);
    if (!ts.isCallExpression(call) || memberName(call) !== "goto") return undefined;
    if (baseOf(call.expression) !== this.page || this.page === undefined) return { path: undefined };
    return { path: navigationPath(call.arguments[0]) };
  }

  /* The body of `test.step(title, fn)` when the statement is that call. */
  private stepBody(statement: ts.Statement): ts.NodeArray<ts.Statement> | undefined {
    if (!ts.isExpressionStatement(statement)) return undefined;
    const call = unwrap(statement.expression);
    if (!ts.isCallExpression(call)) return undefined;
    const chain = chainOf(call.expression);
    const body = call.arguments[1];
    if (chain === undefined || !TEST_ROOTS.has(chain.root) || chain.names.join(".") !== "step" || body === undefined || !isFn(body) || body.body === undefined || !ts.isBlock(body.body)) return undefined;
    return body.body.statements;
  }

  classify(statements: readonly ts.Statement[]): Classified[] {
    const out: Classified[] = [];
    for (const statement of statements) {
      const step = this.stepBody(statement);
      if (step !== undefined) {
        out.push(...this.classify(step));
        continue;
      }
      if (ts.isBlock(statement)) {
        out.push(...this.classify(statement.statements));
        continue;
      }
      if (ts.isEmptyStatement(statement) || ts.isFunctionDeclaration(statement)) continue;
      const navigation = this.navigation(statement);
      if (navigation !== undefined) {
        out.push(navigation.path !== undefined ? { kind: "navigate", path: navigation.path } : { kind: "step", asserts: false });
        continue;
      }
      const { readOnly, asserts } = this.reads(statement);
      if (readOnly && (ts.isExpressionStatement(statement) || ts.isVariableStatement(statement))) {
        if (ts.isVariableStatement(statement)) this.declareLocators(statement);
        out.push({ kind: "read", asserts });
      } else {
        out.push({ kind: "step", asserts });
      }
    }
    return out;
  }

  /* A constant whose value is a locator built on the page or on another locator: calls on it read the page. */
  private declareLocators(statement: ts.VariableStatement): void {
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
      const value = unwrap(declaration.initializer);
      if (!ts.isCallExpression(value)) continue;
      const base = baseOf(value.expression);
      const member = memberName(value);
      if (member !== undefined && LOCATOR_BUILDERS.has(member) && base !== undefined && (base === this.page || this.locators.has(base))) this.locators.add(declaration.name.text);
    }
  }
}

/* One test of a spec as the detector reads it: its title path, and the pages its assertions ran on as they loaded, or why it says nothing. */
type ReadTest = { titlePath: string; pages: string[] | undefined };

/* The pages a test asserted on as they loaded, or undefined when any assertion ran outside such a window, none ran, or the test cannot be read soundly. */
function asLoadedPages(hooks: readonly Fn[], body: Fn): string[] | undefined {
  const classified: Classified[] = [];
  for (const fn of [...hooks, body]) {
    const binding = pageBindingOf(fn);
    if (binding === undefined || fn.body === undefined || !ts.isBlock(fn.body)) return undefined;
    classified.push(...new FunctionReading(binding.page).classify(fn.body.statements));
  }
  let window: string | undefined;
  let stepped = false;
  let assertions = 0;
  const pages = new Set<string>();
  for (const item of classified) {
    if (item.kind === "navigate") {
      /* A page opened after a step of the test's own is not one DEV served untouched. */
      window = stepped ? undefined : item.path;
      continue;
    }
    if (item.kind === "step") {
      if (item.asserts || window === undefined) return undefined;
      stepped = true;
      window = undefined;
      continue;
    }
    if (!item.asserts) continue;
    if (window === undefined) return undefined;
    assertions += 1;
    pages.add(window);
  }
  return assertions > 0 ? [...pages] : undefined;
}

/* The call a statement of a scope is, when the statement is that call alone. */
function statementCall(statement: ts.Statement): ts.CallExpression | undefined {
  if (!ts.isExpressionStatement(statement)) return undefined;
  const call = unwrap(statement.expression);
  return ts.isCallExpression(call) ? call : undefined;
}

/* The statements a describe's callback runs, or undefined when its body is not a block. */
const bodyStatements = (fn: Fn): readonly ts.Statement[] | undefined => (fn.body !== undefined && ts.isBlock(fn.body) ? fn.body.statements : undefined);

/*
 * Whether a scope arranges every test under it beyond what its own `beforeEach` statements say: a `test.use` or a `beforeAll` anywhere in
 * it outside its tests and describes, or a hook that is not a statement of the scope itself (one inside a condition or a loop runs or not
 * by what the syntax cannot say).
 */
function arrangesScope(statements: readonly ts.Statement[]): boolean {
  let arranges = false;
  const visit = (node: ts.Node, direct: boolean): void => {
    if (arranges) return;
    if (ts.isCallExpression(node)) {
      const structural = structuralCall(node);
      if (structural?.kind === "test" || structural?.kind === "describe") return;
      const chain = chainOf(node.expression);
      const name = chain !== undefined && TEST_ROOTS.has(chain.root) ? chain.names.join(".") : undefined;
      if (name === "use" || name === "beforeAll" || (structural?.kind === "hook" && !direct)) arranges = true;
    }
    ts.forEachChild(node, (child) => visit(child, false));
  };
  for (const statement of statements) {
    const call = statementCall(statement);
    if (call !== undefined) visit(call, true);
    else visit(statement, false);
  }
  return arranges;
}

/* The `beforeEach` hooks a scope declares as statements of its own. */
function beforeEachHooksOf(statements: readonly ts.Statement[]): Fn[] {
  return statements.flatMap((statement) => {
    const call = statementCall(statement);
    const structural = call === undefined ? undefined : structuralCall(call);
    return structural?.kind === "hook" && chainOf(call!.expression)?.names[0] === "beforeEach" ? [structural.body] : [];
  });
}

/* The title a describe adds to its tests' path: none (null) for an anonymous one, undefined when the title is computed. */
function describeTitle(call: ts.CallExpression): string | undefined | null {
  const first = call.arguments[0];
  if (first !== undefined && isFn(first)) return null;
  return literalText(first);
}

/* The tests under a node that is not a scope's own statement (a loop, a condition, a function): each may run any number of times, so none is read. Their literal titles still count against a test that shares them. */
function nestedTests(node: ts.Node, titles: readonly string[] | undefined): ReadTest[] {
  const found: ReadTest[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isCallExpression(current) && structuralCall(current)?.kind === "test") {
      const title = literalText(current.arguments[0]);
      found.push({ titlePath: titles !== undefined && title !== undefined ? [...titles, title].join(TITLE_SEPARATOR) : "", pages: undefined });
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function readTests(spec: SpecText): ReadTest[] {
  const sf = ts.createSourceFile(spec.file, spec.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
  if (diagnostics !== undefined && diagnostics.length > 0) return [];
  const tests: ReadTest[] = [];
  /* `titles` is the scope's title path; `sound` is false once a scope above arranges every test under it. */
  const walkScope = (statements: readonly ts.Statement[], titles: string[] | undefined, sound: boolean, hooks: readonly Fn[]): void => {
    const scopeSound = sound && !arrangesScope(statements);
    const scopeHooks = [...hooks, ...beforeEachHooksOf(statements)];
    for (const statement of statements) {
      const call = statementCall(statement);
      const structural = call === undefined ? undefined : structuralCall(call);
      if (structural?.kind === "hook") continue;
      if (structural?.kind === "describe") {
        const title = describeTitle(call!);
        const inner = bodyStatements(structural.body);
        const innerTitles = titles === undefined || title === undefined ? undefined : title === null ? titles : [...titles, title];
        if (inner !== undefined) walkScope(inner, innerTitles, scopeSound, scopeHooks);
        else tests.push(...nestedTests(statement, innerTitles));
        continue;
      }
      if (structural?.kind === "test") {
        const title = literalText(call!.arguments[0]);
        const titlePath = titles === undefined || title === undefined ? "" : [...titles, title].join(TITLE_SEPARATOR);
        tests.push({ titlePath, pages: titlePath !== "" && scopeSound ? asLoadedPages(scopeHooks, structural.body) : undefined });
        continue;
      }
      tests.push(...nestedTests(statement, titles));
    }
  };
  walkScope(sf.statements, [], true, []);
  /* Two tests with one title path cannot be told apart by their cases: neither is read. */
  const counts = new Map<string, number>();
  for (const t of tests) counts.set(t.titlePath, (counts.get(t.titlePath) ?? 0) + 1);
  return tests.filter((t) => t.titlePath !== "" && counts.get(t.titlePath) === 1);
}

/* The title path a case's name holds after the file's own title: the report names a case `<file title> › <describe titles> › <test title>`. */
function titlePathOf(c: QaCase): string | undefined {
  const at = c.name.indexOf(TITLE_SEPARATOR);
  return at === -1 ? undefined : c.name.slice(at + TITLE_SEPARATOR.length);
}

/*
 * The ambient pins of a run: each passing case whose test asserted only on pages as they loaded, at least once on a page in `emptyPages`
 * (the pages the run read as a confirmed empty state). Pure: the caller reads the specs through the confined reader. In spec order.
 */
export function detectAmbientDataPins(input: { specs: readonly SpecText[]; cases: readonly QaCase[]; emptyPages: readonly string[] }): AmbientDataPin[] {
  if (input.emptyPages.length === 0) return [];
  const empty = new Set(input.emptyPages);
  const pins: AmbientDataPin[] = [];
  for (const spec of input.specs) {
    const passing = new Set(input.cases.filter((c) => isRealPass(c) && sameSpecPath(c.file, spec.file)).map(titlePathOf).filter((p): p is string => p !== undefined));
    if (passing.size === 0) continue;
    for (const t of readTests(spec)) {
      if (t.pages === undefined || !passing.has(t.titlePath)) continue;
      const pages = t.pages.filter((page) => empty.has(page)).sort();
      if (pages.length > 0) pins.push({ file: spec.file, test: t.titlePath, pages });
    }
  }
  return pins;
}
