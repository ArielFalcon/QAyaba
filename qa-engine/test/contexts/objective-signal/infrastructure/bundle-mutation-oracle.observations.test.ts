/* What a surviving mutant moved. When the oracle is asked to observe, each mutant's re-run records the pages of its tests; a survivor is then compared with two unmutated re-runs of the same tests, one before the first mutant and one after the last, and the difference is handed to the regeneration that answers it. Unasked, the oracle does what it always did. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BundleMutationOracleAdapter } from "@contexts/objective-signal/infrastructure/bundle-mutation-oracle.adapter.ts";
import type { MutantRun } from "@contexts/objective-signal/domain/coverage-collector.ts";
import type { ObservedPage } from "@contexts/objective-signal/domain/observed-page.ts";
import type { QaCase } from "@kernel/qa-case.ts";

const SCRIPT_URL = "https://dev.example/main.js";
const SCRIPT_SHA = "abc123def";
const EDIT = "!(theme === 'dark')";

const mutant = (line: number, specFiles = ["flows/map.spec.ts"], tests?: string[]): MutantRun => ({
  site: {
    file: "src/map-shell.ts",
    line,
    column: 4,
    operator: "negate condition",
    script: { url: SCRIPT_URL, sha256: SCRIPT_SHA },
    edit: { start: 10, end: 20, replacement: EDIT },
    original: "theme === 'dark'",
    ranIn: ["flows-map-spec-ts-x-0-0.json"],
  },
  specFiles,
  ...(tests ? { tests } : {}),
});

const pass = (name: string): QaCase => ({ name, status: "pass" });
const fail = (name: string): QaCase => ({ name, status: "fail" });
const TEST = "flows/map.spec.ts › applies the theme";
const page = (name: string, style: string): ObservedPage => ({ name, requests: [{ method: "GET", url: `https://api.maps.example/styles/v1/acme/${style}`, count: 1 }], dom: ["heading: Map"] });

interface Call { namespace: string; mutant: string | undefined; specFiles: string[]; observe: boolean | undefined }

/* What the seed's mutation fixture reads from a re-run's mutant: the script it edits (none when the edit names no script, so no response is touched) and the tests it lets run. */
const selection = (m: string | undefined): { editsScript: boolean; tests?: unknown } => {
  if (m === undefined) return { editsScript: false };
  const parsed = JSON.parse(m) as { url: string; sha256: string; tests?: unknown };
  return { editsScript: parsed.url !== "" && parsed.sha256 !== "", ...(parsed.tests !== undefined ? { tests: parsed.tests } : {}) };
};
const isUnmutated = (m: string | undefined): boolean => !selection(m).editsScript;

/* A fake re-run: the mutated one shows `mutated` pages, the first unmutated one `plain` and the second `plain2` (`plain` when unset); either may be an infra error or throw. */
function fakeRuns(opts: { mutated?: ObservedPage[] | undefined; plain?: ObservedPage[] | undefined; plain2?: ObservedPage[] | undefined; plainVerdict?: string; plainCases?: QaCase[]; plainThrows?: boolean; mutatedCases?: QaCase[] }): { calls: Call[]; run: ConstructorParameters<typeof BundleMutationOracleAdapter>[0] } {
  const calls: Call[] = [];
  let unmutated = 0;
  return {
    calls,
    run: async ({ namespace, mutant: m, specFiles, observe }) => {
      calls.push({ namespace, mutant: m, specFiles, observe });
      if (isUnmutated(m)) {
        if (opts.plainThrows) throw new Error("the runner broke");
        const pages = unmutated++ === 0 || !("plain2" in opts) ? opts.plain : opts.plain2;
        return { verdict: opts.plainVerdict ?? "pass", cases: opts.plainCases ?? [pass(TEST)], ...(pages ? { observations: pages } : {}) };
      }
      return { verdict: "pass", cases: opts.mutatedCases ?? [pass(TEST)], ...(opts.mutated ? { observations: opts.mutated } : {}) };
    },
  };
}

const measure = (oracle: BundleMutationOracleAdapter, mutants = [mutant(67)]) => oracle.measure(mutants, "/e2e", "run-1", [TEST], { observe: true });

test("a survivor whose re-run requested a different pathname than the unmutated re-run is handed the request that moved", async () => {
  const { calls, run } = fakeRuns({ mutated: [page(TEST, "dark")], plain: [page(TEST, "light")] });

  const result = await measure(new BundleMutationOracleAdapter(run, () => 1, "https://dev.example"));

  assert.deepEqual(result?.survived[0]?.moved, {
    kind: "moved",
    requests: { added: ["GET https://api.maps.example/styles/v1/acme/dark"], removed: ["GET https://api.maps.example/styles/v1/acme/light"] },
    dom: { added: [], removed: [] },
    tests: [TEST],
  });
  assert.equal(result?.survived[0]?.movedBySpec, undefined, "a test no spec file is known for is told over all the survivor's tests only");
  assert.deepEqual(calls.map((c) => [c.namespace, c.observe, isUnmutated(c.mutant), c.specFiles]), [
    ["run-1-obs", true, true, ["flows/map.spec.ts"]],
    ["run-1-mut0", true, false, ["flows/map.spec.ts"]],
    ["run-1-obs2", true, true, ["flows/map.spec.ts"]],
  ], "an unmutated re-run before the first mutant and one after the last bracket the mutants' re-runs, so what drifts over the pass is noise too");
});

test("what differs between the two unmutated re-runs is noise: a survivor is told only what neither showed and the mutation did, or both showed and the mutation did not", async () => {
  const token = { method: "POST", url: "https://auth.example/token", count: 1 };
  const withToken = (p: ObservedPage): ObservedPage => ({ ...p, requests: [...p.requests, token], dom: [...p.dom, "text: 11 €"] });
  const priceChanged = (p: ObservedPage): ObservedPage => ({ ...p, dom: [...p.dom, "text: 12 €"] });
  const { run } = fakeRuns({ mutated: [priceChanged(withToken(page(TEST, "dark")))], plain: [withToken(page(TEST, "light"))], plain2: [priceChanged(page(TEST, "light"))] });

  const result = await measure(new BundleMutationOracleAdapter(run, () => 1, "https://dev.example"));

  assert.deepEqual(result?.survived[0]?.moved, {
    kind: "moved",
    requests: { added: ["GET https://api.maps.example/styles/v1/acme/dark"], removed: ["GET https://api.maps.example/styles/v1/acme/light"] },
    dom: { added: [], removed: [] },
    tests: [TEST],
  });
});

test("a survivor is told what moved per spec file, each over its own tests, beside what moved over all of them", async () => {
  const listTest = "flows/list.spec.ts › rows";
  const mapCase = (status: "pass" | "fail" = "pass"): QaCase => ({ name: TEST, status, file: "flows/map.spec.ts" });
  const listCase: QaCase = { name: listTest, status: "pass", file: "flows/list.spec.ts" };
  const listPage: ObservedPage = { name: listTest, requests: [{ method: "GET", url: "https://dev.example/api/places", count: 1 }], dom: ["heading: Places"] };
  const { run } = fakeRuns({ mutated: [page(TEST, "dark"), listPage], plain: [page(TEST, "light"), listPage], plainCases: [mapCase(), listCase], mutatedCases: [mapCase(), listCase] });

  const result = await new BundleMutationOracleAdapter(run, () => 1, "https://dev.example").measure([mutant(67, ["flows/list.spec.ts", "flows/map.spec.ts"])], "/e2e", "run-1", [TEST, listTest], { observe: true });

  const survivor = result?.survived[0];
  assert.equal(survivor?.moved?.kind, "moved");
  assert.deepEqual(survivor?.movedBySpec, [
    { spec: "flows/list.spec.ts", moved: { kind: "unmoved", tests: 1 } },
    { spec: "flows/map.spec.ts", moved: survivor?.moved },
  ]);
});

test("a second unmutated re-run that could not run leaves no noise floor: the survivor is unobserved", async () => {
  let unmutated = 0;
  const run: ConstructorParameters<typeof BundleMutationOracleAdapter>[0] = async ({ mutant: m }) => {
    if (!isUnmutated(m)) return { verdict: "pass", cases: [pass(TEST)], observations: [page(TEST, "dark")] };
    return unmutated++ === 0 ? { verdict: "pass", cases: [pass(TEST)], observations: [page(TEST, "light")] } : { verdict: "infra-error", cases: [] };
  };
  const result = await measure(new BundleMutationOracleAdapter(run, () => 1, "https://dev.example"));
  assert.deepEqual(result?.survived[0]?.moved, { kind: "unobserved", reason: "baseline" });
});

test("a survivor whose pages are the same with and without the mutation is stated as such, with how many tests were compared", async () => {
  const { run } = fakeRuns({ mutated: [page(TEST, "light")], plain: [page(TEST, "light")] });
  const result = await measure(new BundleMutationOracleAdapter(run, () => 1, "https://dev.example"));
  assert.deepEqual(result?.survived[0]?.moved, { kind: "unmoved", tests: 1 });
});

test("the unmutated re-run before the mutants covers every mutant's spec files, the one after them the survivors', and none follows when nothing survived", async () => {
  const both = fakeRuns({ mutated: [page(TEST, "dark")], plain: [page(TEST, "light")] });
  await measure(new BundleMutationOracleAdapter(both.run, () => 1, "https://dev.example"), [mutant(67), mutant(70, ["flows/map.spec.ts", "flows/list.spec.ts"])]);
  assert.deepEqual(both.calls.filter((c) => isUnmutated(c.mutant)).map((c) => [c.namespace, c.specFiles]), [
    ["run-1-obs", ["flows/list.spec.ts", "flows/map.spec.ts"]],
    ["run-1-obs2", ["flows/list.spec.ts", "flows/map.spec.ts"]],
  ]);

  const killed = fakeRuns({ mutatedCases: [fail(TEST)], mutated: [page(TEST, "dark")] });
  const result = await measure(new BundleMutationOracleAdapter(killed.run, () => 1, "https://dev.example"));
  assert.equal(result?.killed, 1);
  assert.deepEqual(killed.calls.map((c) => c.namespace), ["run-1-obs", "run-1-mut0"], "no survivor, no unmutated re-run after the mutants");
});

test("the unmutated re-runs run the tests the mutants ran, and edit no script: before the mutants every mutant's tests, after them the survivors'", async () => {
  const mapTest = "flows-map-spec-ts-applies-the-theme";
  const listTest = "flows-list-spec-ts-rows";
  let mutants = 0;
  const calls: Call[] = [];
  const run: ConstructorParameters<typeof BundleMutationOracleAdapter>[0] = async ({ namespace, mutant: m, specFiles, observe }) => {
    calls.push({ namespace, mutant: m, specFiles, observe });
    if (isUnmutated(m)) return { verdict: "pass", cases: [pass(TEST)], observations: [page(TEST, "light")] };
    /* The first mutant is killed, the second survives. */
    return { verdict: "pass", cases: [mutants++ === 0 ? fail(TEST) : pass(TEST)], observations: [page(TEST, "dark")] };
  };

  await measure(new BundleMutationOracleAdapter(run, () => 1, "https://dev.example"), [mutant(67, ["flows/list.spec.ts"], [listTest]), mutant(70, ["flows/map.spec.ts"], [mapTest])]);

  assert.deepEqual(calls.filter((c) => isUnmutated(c.mutant)).map((c) => [c.namespace, c.specFiles, selection(c.mutant)]), [
    ["run-1-obs", ["flows/list.spec.ts", "flows/map.spec.ts"], { editsScript: false, tests: [listTest, mapTest] }],
    ["run-1-obs2", ["flows/map.spec.ts"], { editsScript: false, tests: [mapTest] }],
  ]);
});

test("a mutant that names no tests ran every test of its spec files, so the unmutated re-runs run them all too", async () => {
  const { calls, run } = fakeRuns({ mutated: [page(TEST, "dark")], plain: [page(TEST, "light")] });
  await measure(new BundleMutationOracleAdapter(run, () => 1, "https://dev.example"), [mutant(67, ["flows/map.spec.ts"], ["flows-map-spec-ts-x"]), mutant(70)]);
  assert.deepEqual(calls.filter((c) => isUnmutated(c.mutant)).map((c) => c.mutant), [undefined, undefined]);
});

test("a re-run that left no observation, an unmutated re-run that could not run and one that broke leave the survivor unobserved without changing what was judged", async () => {
  const cases = [
    fakeRuns({ mutated: undefined, plain: [page(TEST, "light")] }),
    fakeRuns({ mutated: [page(TEST, "dark")], plain: undefined }),
    fakeRuns({ mutated: [page(TEST, "dark")], plain: [page(TEST, "light")], plainVerdict: "infra-error" }),
    fakeRuns({ mutated: [page(TEST, "dark")], plainThrows: true }),
  ];
  const kinds: unknown[] = [];
  for (const { run } of cases) {
    const result = await measure(new BundleMutationOracleAdapter(run, () => 1, "https://dev.example"));
    assert.equal(result?.applied, 1);
    assert.equal(result?.survived.length, 1);
    kinds.push(result?.survived[0]?.moved);
  }
  assert.deepEqual(kinds, [
    { kind: "unobserved", reason: "mutant" },
    { kind: "unobserved", reason: "baseline" },
    { kind: "unobserved", reason: "baseline" },
    { kind: "unobserved", reason: "baseline" },
  ]);
});

test("a test that did not pass in the unmutated re-run says nothing of the mutation and is not compared", async () => {
  const { run } = fakeRuns({ mutated: [page(TEST, "dark")], plain: [page(TEST, "light")], plainCases: [fail(TEST)] });
  const result = await measure(new BundleMutationOracleAdapter(run, () => 1, "https://dev.example"));
  assert.deepEqual(result?.survived[0]?.moved, { kind: "unobserved", reason: "no-common-test" });
});

test("what moved holds nothing of the mutant: not the served script, its digest nor the edit", async () => {
  const { run } = fakeRuns({ mutated: [page(TEST, "dark")], plain: [page(TEST, "light")] });
  const result = await measure(new BundleMutationOracleAdapter(run, () => 1, "https://dev.example"));
  const recorded = JSON.stringify(result?.survived[0]?.moved);
  for (const secret of [SCRIPT_URL, SCRIPT_SHA, EDIT, "start", "replacement"]) assert.ok(!recorded.includes(secret), secret);
});

test("a mutation pass that is not asked to observe makes the re-runs it always made and records no difference", async () => {
  const { calls, run } = fakeRuns({ mutated: [page(TEST, "dark")], plain: [page(TEST, "light")] });
  const result = await new BundleMutationOracleAdapter(run, () => 1, "https://dev.example").measure([mutant(67)], "/e2e", "run-1", [TEST]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.observe, undefined);
  assert.equal(result?.survived[0] !== undefined && "moved" in result.survived[0], false);
});
