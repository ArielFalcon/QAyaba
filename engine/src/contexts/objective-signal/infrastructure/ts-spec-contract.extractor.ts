/* Extracts a spec's test-intent contract from its TypeScript AST: one clause per locator chain and per
   assertion, with the literals it names, its matcher strength, its scope and positional steps. No
   identifier resolution: any argument that is not statically a literal makes the clause opaque, which is
   telemetry only — an opaque clause never rejects anything. */

import ts from "typescript";
import type { IntentClause, MatcherStrength, SpecContractExtraction, SpecIntent } from "../domain/test-intent-contract.ts";

/** Matcher strength per assertion method. A method the table does not name is mid-strength ("presence"),
    so an unrecognized matcher can never make a regeneration look weaker than it is. */
const ASSERTION_STRENGTH: Readonly<Record<string, MatcherStrength>> = {
  toHaveText: "exact",
  toContainText: "contains",
  toHaveValue: "exact",
  toHaveCount: "exact",
  toHaveValues: "exact",
  toHaveAttribute: "exact",
  toHaveClass: "exact",
  toHaveId: "exact",
  toHaveTitle: "exact",
  toHaveURL: "exact",
  toHaveJSProperty: "exact",
  toHaveCSS: "exact",
  toHaveAccessibleName: "exact",
  toHaveAccessibleDescription: "exact",
  toBe: "exact",
  toEqual: "exact",
  toStrictEqual: "exact",
  toMatchObject: "exact",
  toMatch: "contains",
  toContain: "contains",
  toBeVisible: "presence",
  toBeHidden: "presence",
  toBeAttached: "presence",
  toBeDetached: "presence",
  toBeEnabled: "presence",
  toBeDisabled: "presence",
  toBeChecked: "presence",
  toBeUnchecked: "presence",
  toBeFocused: "presence",
  toBeEditable: "presence",
  toBeInViewport: "presence",
  toBeEmpty: "presence",
  toBeTruthy: "truthy",
  toBeFalsy: "truthy",
  toBeDefined: "truthy",
  toBeUndefined: "truthy",
  toBeNull: "truthy",
  toBeNaN: "truthy",
};

/* Steps that narrow what is targeted (a container, a filter, a role, an attribute) rather than pick by
   position. Used only to tell "scope" from "positional" in the delta rules. */
const SCOPE_METHODS = new Set([
  "filter",
  "and",
  "or",
  "locator",
  "getByRole",
  "getByText",
  "getByLabel",
  "getByPlaceholder",
  "getByAltText",
  "getByTitle",
  "getByTestId",
]);

const POSITIONAL_METHODS = new Set(["first", "last", "nth"]);

const TEST_CALLS = new Set(["test", "it"]);

const EMPTY: SpecContractExtraction = { specs: [], clauseCount: 0, opaqueCount: 0, opacityRatio: 0 };

/** Parse one spec's contract. A file that does not parse yields no clauses: the run would not load it either. */
export function extractSpecContract(file: string, source: string): SpecContractExtraction {
  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  } catch {
    return EMPTY;
  }
  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
  if (diagnostics !== undefined && diagnostics.length > 0) return EMPTY;

  const specs: SpecIntent[] = [];
  let clauseCount = 0;
  let opaqueCount = 0;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isTestCall(node)) {
      const extracted = extractTest(file, node);
      if (extracted) {
        specs.push(extracted);
        clauseCount += extracted.clauses.length;
        opaqueCount += extracted.clauses.filter((clause) => clause.opaque).length;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { specs, clauseCount, opaqueCount, opacityRatio: clauseCount === 0 ? 0 : opaqueCount / clauseCount };
}


function isTestCall(call: ts.CallExpression): boolean {
  return ts.isIdentifier(call.expression) && TEST_CALLS.has(call.expression.text);
}

function extractTest(file: string, call: ts.CallExpression): SpecIntent | undefined {
  const testName = call.arguments.map(literalText).find((text): text is string => text !== undefined) ?? "<anonymous>";
  const body = call.arguments.map(callbackBody).find((candidate): candidate is ts.ConciseBody => candidate !== undefined);
  if (!body) return { file, testName, clauses: [] };

  const clauses: IntentClause[] = [];
  const counters = { locator: 0, assertion: 0 };

  /* Only the outermost call of a chain becomes a clause; its inner steps are part of it. */
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && !isInnerCall(node)) {
      const clause = clauseOf(node, counters);
      if (clause) clauses.push(clause);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);

  return { file, testName, clauses };
}

function callbackBody(argument: ts.Expression): ts.ConciseBody | undefined {
  if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) return argument.body;
  return undefined;
}

/** An inner call of a chain is the receiver of the step that wraps it. */
function isInnerCall(call: ts.CallExpression): boolean {
  const parent = call.parent;
  return parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.expression === call;
}

interface Step {
  readonly method: string;
  readonly args: readonly ts.Expression[];
}

function chainOf(expression: ts.Expression): Step[] {
  const steps: Step[] = [];
  let current: ts.Expression = expression;
  for (;;) {
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        steps.unshift({ method: callee.name.text, args: current.arguments });
        current = callee.expression;
        continue;
      }
      if (ts.isIdentifier(callee)) {
        steps.unshift({ method: callee.text, args: current.arguments });
        return steps;
      }
      return steps;
    }
    if (ts.isPropertyAccessExpression(current)) {
      steps.unshift({ method: current.name.text, args: [] });
      current = current.expression;
      continue;
    }
    return steps;
  }
}

function clauseOf(call: ts.CallExpression, counters: { locator: number; assertion: number }): IntentClause | undefined {
  const steps = chainOf(call);
  if (steps.length === 0) return undefined;

  const assertionIndex = findLastIndex(steps, (step) => ASSERTION_STRENGTH[step.method] !== undefined);
  const assertion = assertionIndex >= 0 ? steps[assertionIndex] : undefined;
  const hasLocatorStep = steps.some((step) => SCOPE_METHODS.has(step.method) || POSITIONAL_METHODS.has(step.method));
  const kind: IntentClause["kind"] | undefined = assertion ? "assertion" : hasLocatorStep ? "locator" : undefined;
  if (!kind) return undefined;

  const literals: string[] = [];
  let opaque = false;
  for (const step of steps) {
    for (const arg of step.args) {
      const values = readableLiterals(arg);
      if (values === undefined) {
        opaque = true;
        continue;
      }
      literals.push(...values);
    }
  }

  const expected = assertion ? assertion.args.map(literalText).find((text): text is string => text !== undefined) : undefined;
  counters[kind] += 1;
  const id = `${kind}-${counters[kind]}`;

  return {
    id,
    kind,
    literals,
    ...(expected !== undefined ? { expected } : {}),
    ...(assertion ? { strength: ASSERTION_STRENGTH[assertion.method] } : {}),
    ...(steps.some((step) => step.method === "not") ? { negated: true } : {}),
    scope: steps.filter((step) => SCOPE_METHODS.has(step.method)).map((step) => step.method),
    positional: steps.filter((step) => POSITIONAL_METHODS.has(step.method)).map((step) => step.method),
    opaque,
  };
}

/** The literals an argument carries, or undefined when any part of it is not statically a literal. */
function readableLiterals(argument: ts.Expression): string[] | undefined {
  const single = literalText(argument);
  if (single !== undefined) return [single];

  if (ts.isObjectLiteralExpression(argument)) {
    const values: string[] = [];
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property)) return undefined;
      const nested = readableLiterals(property.initializer);
      if (nested === undefined) return undefined;
      values.push(...nested);
    }
    return values;
  }

  if (ts.isArrayLiteralExpression(argument)) {
    const values: string[] = [];
    for (const element of argument.elements) {
      const nested = readableLiterals(element);
      if (nested === undefined) return undefined;
      values.push(...nested);
    }
    return values;
  }

  /* A locator chain passed as an argument (`expect(page.getByText("x"))`) is readable when every step of
     it is; the chain's receiver is a page handle, not a value under test. */
  if (ts.isCallExpression(argument) || ts.isPropertyAccessExpression(argument)) {
    const steps = chainOf(argument);
    if (steps.length === 0) return undefined;
    const values: string[] = [];
    for (const step of steps) {
      for (const arg of step.args) {
        const nested = readableLiterals(arg);
        if (nested === undefined) return undefined;
        values.push(...nested);
      }
    }
    return values;
  }

  return undefined;
}

function literalText(argument: ts.Expression): string | undefined {
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) return argument.text;
  if (ts.isNumericLiteral(argument)) return argument.text;
  return undefined;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}
