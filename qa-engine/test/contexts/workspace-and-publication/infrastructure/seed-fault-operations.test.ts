/* The seed's response-corruption pass touches only the operations the orchestrator names. The seed cannot be imported (it needs the test runner's package), so the pure helpers between its `fault-operations` markers are transpiled from its source and run here. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const SEED = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "..", "config", "e2e", "fixtures.ts"), "utf8");

interface Operation { verb: string; pattern: string; re: RegExp }
const helpers = (() => {
  const start = SEED.indexOf("// >>> fault-operations");
  const end = SEED.indexOf("// <<< fault-operations <<<");
  assert.ok(start >= 0 && end > start, "the seed marks its fault-operation helpers");
  const js = ts.transpileModule(SEED.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(`${js}\nreturn { faultOperationsFromEnv, faultOperationFor };`)() as {
    faultOperationsFromEnv: (raw: string | undefined) => Operation[];
    faultOperationFor: (operations: readonly Operation[], method: string, pathname: string) => Operation | undefined;
  };
})();

test("with the operations variable unset, empty or not a list, no operation is named, so nothing is corrupted", () => {
  for (const raw of [undefined, "", "not json", "{}", "null", "[]"]) assert.deepEqual(helpers.faultOperationsFromEnv(raw), [], String(raw));
});

test("an entry is an operation only with a verb and a pattern that is a bounded regular expression", () => {
  const raw = JSON.stringify([
    { verb: "get", pattern: "^/orders/[^/]+/?$" },
    { verb: "GET", pattern: "(" },
    { verb: "GET", pattern: "x".repeat(201) },
    { verb: 1, pattern: "^/a$" },
    "GET ^/a$",
    null,
  ]);
  const operations = helpers.faultOperationsFromEnv(raw);
  assert.deepEqual(operations.map((o) => [o.verb, o.pattern]), [["GET", "^/orders/[^/]+/?$"]]);
});

test("at most 64 entries are read", () => {
  const raw = JSON.stringify(Array.from({ length: 80 }, (_, i) => ({ verb: "GET", pattern: `^/r${i}$` })));
  assert.equal(helpers.faultOperationsFromEnv(raw).length, 64);
});

test("a response is corrupted only when its method and pathname match a named operation", () => {
  const operations = helpers.faultOperationsFromEnv(JSON.stringify([{ verb: "GET", pattern: "^/orders/[^/]+/?$" }, { verb: "ANY", pattern: "^/ping$" }]));
  assert.equal(helpers.faultOperationFor(operations, "get", "/orders/7")?.pattern, "^/orders/[^/]+/?$");
  assert.equal(helpers.faultOperationFor(operations, "POST", "/orders/7"), undefined, "another verb");
  assert.equal(helpers.faultOperationFor(operations, "GET", "/invoices/7"), undefined, "another path");
  assert.equal(helpers.faultOperationFor(operations, "DELETE", "/ping")?.verb, "ANY");
  assert.equal(helpers.faultOperationFor([], "GET", "/orders/7"), undefined);
});

test("the corruption pass runs only when the switch is on and operations are named, and writes one counter per test", () => {
  assert.match(SEED, /process\.env\.QA_FAULT_INJECT === "1" \? faultOperationsFromEnv\(process\.env\.QA_FAULT_INJECT_OPERATIONS\) : \[\]/);
  assert.match(SEED, /if \(operations\.length > 0\) \{\s*await page\.route/);
  assert.match(SEED, /injected-\$\{process\.pid\}-\$\{faultCounterSequence\+\+\}\.json/);
});
