/* The measurement execution is the mutants' first unmutated observation (RFC-0015 A′): the oracle runs no observation of its own before the mutants, and a mutant whose only reaching tests failed under the measurement is not judged. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BundleMutationOracleAdapter } from "@contexts/objective-signal/infrastructure/bundle-mutation-oracle.adapter.ts";
import type { MutantRun } from "@contexts/objective-signal/domain/coverage-collector.ts";
import type { ObservedPage } from "@contexts/objective-signal/domain/observed-page.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { testOfCase } from "@contexts/objective-signal/domain/dump-names.ts";

const MAP = "flows/map.spec.ts › applies the theme";
const LIST = "flows/list.spec.ts › lists the shops";

const mutant = (tests?: string[], specFiles = ["flows/map.spec.ts"]): MutantRun => ({
  site: { file: "src/map-shell.ts", line: 67, column: 4, operator: "negate condition", script: { url: "https://dev.example/main.js", sha256: "abc" }, edit: { start: 10, end: 20, replacement: "!x" }, original: "x", ranIn: [] },
  specFiles,
  ...(tests ? { tests } : {}),
});

const pass = (name: string, file?: string): QaCase => ({ name, status: "pass", ...(file ? { file } : {}) });
const page = (name: string, style: string): ObservedPage => ({ name, requests: [{ method: "GET", url: `https://api.example/styles/${style}`, count: 1 }], dom: ["heading: Map"] });

function runs(mutatedStyle: string) {
  const namespaces: string[] = [];
  const run: ConstructorParameters<typeof BundleMutationOracleAdapter>[0] = async ({ namespace, mutant: m }) => {
    namespaces.push(namespace);
    const editsScript = m !== undefined && (JSON.parse(m) as { url: string }).url !== "";
    return { verdict: "pass", cases: [pass(MAP, "flows/map.spec.ts")], observations: [page(MAP, editsScript ? mutatedStyle : "light")] };
  };
  return { namespaces, run };
}

test("with the measurement's pages in hand, no observation runs before the mutants, and a survivor is compared with the measurement and the one after", async () => {
  const { namespaces, run } = runs("dark");
  const oracle = new BundleMutationOracleAdapter(run, () => 1, "https://dev.example");

  const result = await oracle.measure([mutant([testOfCase(MAP)])], "/e2e", "run-1-measure", [MAP], { observe: true, before: { cases: [pass(MAP, "flows/map.spec.ts")], observations: [page(MAP, "light")] } });

  assert.deepEqual(namespaces, ["run-1-measure-mut0", "run-1-measure-obs2"]);
  assert.equal(result?.survived[0]?.moved?.kind, "moved");
});

test("a mutant whose only reaching tests failed under the measurement is not judged, never counted as survived, and its re-run is not spent", async () => {
  const { namespaces, run } = runs("light");
  const oracle = new BundleMutationOracleAdapter(run, () => 1, "https://dev.example");

  const result = await oracle.measure([mutant([testOfCase(LIST)], ["flows/list.spec.ts"]), mutant([testOfCase(MAP)])], "/e2e", "run-1-measure", [MAP], { notGreen: [testOfCase(LIST)] });

  assert.deepEqual(namespaces, ["run-1-measure-mut1"]);
  assert.equal(result?.applied, 1);
  assert.equal(result?.survived.length, 1);
  assert.deepEqual(result?.notJudged, { "baseline-not-green-under-measurement": 1 });
});

test("a pass whose every mutant was left unjudged for that reason still says so", async () => {
  const { namespaces, run } = runs("light");
  const oracle = new BundleMutationOracleAdapter(run, () => 1, "https://dev.example");

  const result = await oracle.measure([mutant([testOfCase(LIST)], ["flows/list.spec.ts"])], "/e2e", "run-1-measure", [MAP], { notGreen: [testOfCase(LIST)] });

  assert.deepEqual(namespaces, []);
  assert.equal(result?.applied, 0);
  assert.deepEqual(result?.notJudged, { "baseline-not-green-under-measurement": 1 });
});
