/*
 * One writer per field. The fields several steps feed are written only through the reducers of run-flow/reducers.ts, each imported
 * by the modules that own that write; every step says which top-level fields it updates, and the runner refuses an update outside.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as reducers from "@contexts/qa-run-orchestration/application/run-flow/reducers.ts";
import { initialRunState } from "@contexts/qa-run-orchestration/application/run-flow/run-state.ts";
import { BEFORE_WORKSPACE, IN_WORKSPACE } from "@contexts/qa-run-orchestration/application/run-flow/run-steps.ts";

const application = join(import.meta.dirname, "..", "..", "..", "..", "..", "src", "contexts", "qa-run-orchestration", "application");
const REDUCERS = "run-flow/reducers.ts";

/* Per top-level field of the state: each reducer that writes it, and the modules allowed to import that reducer. */
const WRITERS: Record<string, Record<string, readonly string[]>> = {
  execution: {
    withRun: ["run-flow/phases/execute.steps.ts", "run-flow/phases/fix-loop.steps.ts", "run-flow/phases/coverage.steps.ts", "run-flow/phases/review.steps.ts"],
    addRetries: ["run-flow/phases/execute.steps.ts", "run-flow/phases/fix-loop.steps.ts", "run-flow/phases/review.steps.ts"],
  },
  coverage: {
    withAcceptanceCalls: ["run-flow/phases/coverage.steps.ts", "run-flow/phases/review.steps.ts"],
    acceptedRegeneration: ["run-flow/phases/coverage.steps.ts", "run-flow/phases/review.steps.ts"],
    remeasured: ["run-flow/phases/review.steps.ts"],
  },
  generation: {
    mergeDelivered: ["run-flow/phases/generate.steps.ts", "run-flow/phases/generation-services.ts"],
    rollbackDelivered: ["run-flow/phases/coverage.steps.ts", "run-flow/phases/review.steps.ts"],
  },
  proof: { recordProof: ["run-qa.use-case.ts"] },
  run: { recordRunFact: ["run-flow/failure-ends.ts", "run-flow/phases/generate.steps.ts", "run-flow/phases/ground.steps.ts", "run-qa.use-case.ts"] },
  coordination: { recordCoordination: ["run-qa.use-case.ts"] },
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

const modules = sources(application).map((path) => ({ rel: relative(application, path), text: readFileSync(path, "utf8") }));

/* The reducers each module imports from reducers.ts. */
function importsOf(text: string): string[] {
  return [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*\/reducers\.ts"/g)].flatMap((match) => match[1]!.split(",").map((name) => name.replace(/^\s*type\s+/, "").trim()).filter(Boolean));
}

const importers = (reducer: string): string[] => modules.filter((m) => importsOf(m.text).includes(reducer)).map((m) => m.rel).sort();

test("every reducer is declared for the field it writes", () => {
  const declared = Object.values(WRITERS).flatMap((byReducer) => Object.keys(byReducer)).sort();
  assert.deepEqual(Object.keys(reducers).sort(), declared);
});

for (const [field, byReducer] of Object.entries(WRITERS)) {
  for (const [reducer, allowed] of Object.entries(byReducer)) {
    test(`the "${field}" reducer ${reducer} is imported by exactly the modules that own that write`, () => {
      assert.deepEqual(importers(reducer), [...allowed].sort());
    });
  }
}

/* The shapes of a write the reducers replace: a section literal naming a reducer's field, a direct assignment to the ledger. */
const DIRECT_WRITES: ReadonlyArray<{ what: string; test: (text: string) => boolean }> = [
  { what: "an assignment to the delivered ledger", test: (text) => /\.delivered\s*=(?!=)/.test(text) },
  { what: "an assignment to the proof", test: (text) => /\.proof(\[[^\]]*\]|\.\w+)\s*=(?!=)/.test(text) },
  { what: "an assignment to the coordination", test: (text) => /\.coordination\s*=(?!=)/.test(text) },
  { what: "an assignment to a fact of the run", test: (text) => /state\.run(\[[^\]]*\]|\.\w+)\s*=(?!=)/.test(text) },
  { what: "an execution section naming run or retries", test: (text) => [...text.matchAll(/\bexecution:\s*\{\s*\.\.\.[\w.()]+,\s*([^}]*)\}/g)].some((m) => /\b(run|retries)\b/.test(m[1]!)) },
  { what: "a coverage section naming acceptanceCalls or acceptedRegenAfterMeasure", test: (text) => [...text.matchAll(/\bcoverage:\s*\{\s*\.\.\.[\w.()]+,\s*([^}]*)\}/g)].some((m) => /\b(acceptanceCalls|acceptedRegenAfterMeasure)\b/.test(m[1]!)) },
];

test("no module of the run flow writes a reducer's field itself", () => {
  const flow = modules.filter((m) => m.rel.startsWith("run-flow/") && m.rel !== REDUCERS && m.rel !== "run-flow/run-state.ts");
  const offenders = flow.flatMap((m) => DIRECT_WRITES.filter((write) => write.test(m.text)).map((write) => `${m.rel}: ${write.what}`));
  assert.deepEqual(offenders, []);
});

test("every step of the two tables declares the fields it updates, and only fields the state has", () => {
  const fields = new Set(Object.keys(initialRunState()));
  for (const step of [...BEFORE_WORKSPACE, ...IN_WORKSPACE]) {
    assert.ok(Array.isArray(step.writes), `the step "${step.id}" declares what it writes`);
    for (const field of step.writes!) assert.ok(fields.has(field as string), `the step "${step.id}" names "${String(field)}", which the state does not have`);
  }
});

test("every field of the state is written by a step's update or through a reducer", () => {
  const byStep = new Set([...BEFORE_WORKSPACE, ...IN_WORKSPACE].flatMap((step) => (step.writes ?? []) as string[]));
  const byReducer = new Set(Object.keys(WRITERS));
  const unwritten = Object.keys(initialRunState()).filter((field) => !byStep.has(field) && !byReducer.has(field));
  assert.deepEqual(unwritten, []);
});
