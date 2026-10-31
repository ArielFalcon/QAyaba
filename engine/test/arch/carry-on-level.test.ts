/* A catch block that carries on past a fault takes the level of its line from `carryOn`, which returns the level the failure policy gives
   it. A literal level (a logger method, or the literal level handed to `announceSuite`) after a `carryOn(` is a call site choosing again, so
   it fails here. A catch that ends the run after `carryOn` is the one listed exception. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const SCANNED_ROOTS = ["platform", "engine/src"];
const LEVEL_METHODS = new Set(["debug", "info", "warn", "error"]);

/* The catch throws the run's end right after carryOn, so its line is an end, not a carried-on fault. Only that line is exempt: the file is named with the start of the call. */
const ENDS_THE_RUN: Readonly<Record<string, string>> = {
  "engine/src/contexts/run-orchestration/application/run-flow/phases/generate.steps.ts": "engineLog.error(`[qa] coordination failed (no author sidekick ran)",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

const isCallTo = (node: ts.Node, name: string): node is ts.CallExpression =>
  ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;

/* The literal-level lines inside the catch blocks of `text` that call carryOn. */
function literalLevelsAfterCarryOn(text: string): string[] {
  const file = ts.createSourceFile("scanned.ts", text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node) && containsCall(node.block, "carryOn")) {
      const inspect = (inner: ts.Node): void => {
        if (ts.isCallExpression(inner)) {
          const callee = inner.expression;
          if (ts.isPropertyAccessExpression(callee) && LEVEL_METHODS.has(callee.name.text)) found.push(inner.getText(file));
          if (ts.isPropertyAccessExpression(callee) && callee.name.text === "announceSuite" && inner.arguments.some((arg) => ts.isStringLiteral(arg) && LEVEL_METHODS.has(arg.text))) found.push(inner.getText(file));
        }
        ts.forEachChild(inner, inspect);
      };
      inspect(node.block);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function containsCall(node: ts.Node, name: string): boolean {
  let hit = false;
  const walk = (inner: ts.Node): void => {
    if (isCallTo(inner, name)) hit = true;
    if (!hit) ts.forEachChild(inner, walk);
  };
  walk(node);
  return hit;
}

test("no catch block that carries on past a fault writes its line at a literal level", () => {
  const offenders = SCANNED_ROOTS.flatMap((root) => sourceFiles(join(repoRoot, root)))
    .map((file) => relative(repoRoot, file).split("\\").join("/"))
    .flatMap((rel) =>
      literalLevelsAfterCarryOn(readFileSync(join(repoRoot, rel), "utf8"))
        .filter((call) => !(ENDS_THE_RUN[rel] !== undefined && call.startsWith(ENDS_THE_RUN[rel]!)))
        .map((call) => `${rel}: ${call.split("\n")[0]}`),
    );
  assert.deepEqual(offenders, []);
});

test("a literal level after carryOn is caught, a level the policy returned is not", () => {
  const literal = "try { go(); } catch (err) { carryOn(err); engineLog.error('lost'); host.announceSuite('lost', 'warn'); }";
  const derived = "try { go(); } catch (err) { const level = carryOn(err); engineLog[level]('lost'); host.announceSuite('lost', level); }";
  const unrelated = "try { go(); } catch (err) { engineLog.error('lost'); }";
  assert.equal(literalLevelsAfterCarryOn(literal).length, 2);
  assert.deepEqual(literalLevelsAfterCarryOn(derived), []);
  assert.deepEqual(literalLevelsAfterCarryOn(unrelated), []);
});

test("the one line allowed to keep a literal level is still in a catch that ends the run after carryOn, and is the only literal level of its file", () => {
  for (const [rel, start] of Object.entries(ENDS_THE_RUN)) {
    const calls = literalLevelsAfterCarryOn(readFileSync(join(repoRoot, rel), "utf8"));
    assert.deepEqual(calls.filter((call) => call.startsWith(start)).length, 1, `${rel} no longer needs its exception`);
    assert.deepEqual(calls.filter((call) => !call.startsWith(start)), [], `${rel} has another literal level after carryOn`);
  }
});

test("an exempt line does not exempt another literal level of its file", () => {
  const text = "try { go(); } catch (err) { carryOn(err); engineLog.error('ends'); } try { go(); } catch (err) { carryOn(err); engineLog.warn('lost'); }";
  const calls = literalLevelsAfterCarryOn(text);
  assert.deepEqual(calls.filter((call) => !call.startsWith("engineLog.error('ends'")), ["engineLog.warn('lost')"]);
});
