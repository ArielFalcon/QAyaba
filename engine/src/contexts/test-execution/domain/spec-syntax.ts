/* What the detectors that read a delivered spec's syntax tree share: the shape of a test, a describe block and a hook, and the small readers of a call's name and literal arguments. Pure. */

import ts from "typescript";

export interface SpecText {
  file: string;
  text: string;
}

const HOOKS = new Set(["beforeEach", "beforeAll", "afterEach", "afterAll"]);
const TEST_MODIFIERS = new Set(["only", "skip", "fixme", "fail", "slow"]);
const DESCRIBE_MODIFIERS = new Set(["only", "skip", "fixme", "serial", "parallel"]);

export type Fn = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

export const isFn = (node: ts.Node | undefined): node is Fn => node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node));

export const unwrap = (node: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) ? unwrap(node.expression) : node);

export const literalText = (node: ts.Node | undefined): string | undefined => (node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined);

/* The method a call is named by: `x.name(...)` gives `name`. */
export function memberName(call: ts.CallExpression): string | undefined {
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : undefined;
}

/* `test`, `test.only`, `test.describe.serial`: the identifier a chain starts at and the names after it. */
export function chainOf(expression: ts.Expression): { root: string; names: string[] } | undefined {
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

export type Structural = { kind: "test"; name: string; body: Fn } | { kind: "describe"; name: string; body: Fn } | { kind: "hook"; body: Fn };

/* What a call is in a spec's structure: a test, a describe block or a hook, or none of them. */
export function structuralCall(call: ts.CallExpression): Structural | undefined {
  const chain = chainOf(call.expression);
  const body = callbackOf(call);
  if (chain === undefined || body === undefined) return undefined;
  const name = literalText(call.arguments[0]) ?? (call.arguments[0] !== undefined && ts.isTemplateExpression(call.arguments[0]) ? call.arguments[0].getText() : "");
  if ((chain.root === "test" || chain.root === "it") && chain.names.every((n) => TEST_MODIFIERS.has(n)) && call.arguments.length >= 2) return { kind: "test", name: name || "(unnamed)", body };
  if (chain.root === "test" && chain.names[0] === "describe" && chain.names.slice(1).every((n) => DESCRIBE_MODIFIERS.has(n))) return { kind: "describe", name, body };
  if (chain.root === "test" && chain.names.length === 1 && HOOKS.has(chain.names[0]!)) return { kind: "hook", body };
  return undefined;
}
