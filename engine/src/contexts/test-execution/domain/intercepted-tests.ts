/* Which tests of a delivered spec intercept the requests of the page, decided from the spec's text alone. The detector reads the syntax tree (a comment or a string that mentions `page.route` is not an interception). A test intercepts when its body, a hook above it or a function of the same file it calls registers a route handler (`route` with a handler), replays a HAR (`routeFromHAR`), fakes a WebSocket server (`routeWebSocket`), runs an init script that replaces `fetch`, `XMLHttpRequest` or `WebSocket`, or fulfils a route. A helper from another module is not read: the author of a flow can write no file but its spec, so such a module is the suite's own and not what a run delivers. The engine refuses these tests (shared-kernel/case-proof.ts); the detector decides nothing else. */

import ts from "typescript";
import { TITLE_SEPARATOR } from "@kernel/case-proof.ts";
import { isFn, memberName, structuralCall, type Fn, type SpecText } from "./spec-syntax.ts";

/* A test that intercepts requests, by its file and its title path (the describe titles and the test's own, joined as the report names a case). */
export interface InterceptedTest {
  file: string;
  name: string;
}

const REQUEST_REPLACING_SCRIPT = /\b(?:fetch|XMLHttpRequest|WebSocket)\b/;

class FileAnalysis {
  readonly sf: ts.SourceFile;
  /* Functions of this file by name: a declaration, or a constant holding an arrow or function expression. */
  private readonly functions = new Map<string, Fn>();

  constructor(file: string, text: string) {
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
    ts.forEachChild(node, (child) => this.index(child));
  }

  /* Whether a node registers an interception, following the functions of this file it calls. */
  intercepts(node: ts.Node, seen: Set<ts.Node> = new Set()): boolean {
    let found = false;
    const visit = (current: ts.Node): void => {
      if (found) return;
      if (ts.isCallExpression(current)) {
        const member = memberName(current);
        if ((member === "route" && current.arguments.length >= 2) || member === "routeFromHAR" || member === "routeWebSocket" || member === "fulfill") found = true;
        else if (member === "addInitScript" && REQUEST_REPLACING_SCRIPT.test(current.getText())) found = true;
        else if (ts.isIdentifier(current.expression)) {
          const local = this.functions.get(current.expression.text);
          if (local !== undefined && !seen.has(local)) {
            seen.add(local);
            found = this.intercepts(local, seen);
          }
        }
      }
      ts.forEachChild(current, visit);
    };
    visit(node);
    return found;
  }
}

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

function interceptedIn(spec: SpecText): InterceptedTest[] {
  const analysis = new FileAnalysis(spec.file, spec.text);
  if (!analysis.parses) return [];
  const found: InterceptedTest[] = [];
  const walkScope = (body: ts.Node, titles: readonly string[], hooked: boolean): void => {
    const hookedHere = hooked || hooksOf(body).some((hook) => analysis.intercepts(hook));
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const structural = structuralCall(node);
        if (structural?.kind === "describe") return walkScope(structural.body, [...titles, structural.name], hookedHere);
        if (structural?.kind === "hook") return;
        if (structural?.kind === "test") {
          if (hookedHere || analysis.intercepts(structural.body)) found.push({ file: spec.file, name: [...titles, structural.name].join(TITLE_SEPARATOR) });
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(body, visit);
  };
  walkScope(analysis.sf, [], false);
  return found;
}

/* The tests of the delivered specs that intercept requests. Pure: the caller reads the specs through the confined reader. */
export function detectInterceptedTests(specs: readonly SpecText[]): InterceptedTest[] {
  return specs.flatMap(interceptedIn);
}
