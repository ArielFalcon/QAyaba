/* The adapter turns what the dumps of a run cover (one entry for each dump, the lines of each changed file it covered, read and reduced by the injected read) into the report of the run: a file is covered on the lines of every dump that covered it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { V8BrowserCoverageAdapter, type CoveredLines } from "@contexts/objective-signal/infrastructure/v8-browser-coverage.adapter.ts";

const CHANGED_FILES = ["src/svc.ts"];

const covers = (...entries: Array<[string, number[]]>): CoveredLines => new Map(entries.map(([file, lines]) => [file, new Set(lines)]));

test("a file is covered on the lines of every dump that covered it, once each", async () => {
  const adapter = new V8BrowserCoverageAdapter(async () => [covers(["src/svc.ts", [1, 2]]), covers(["src/svc.ts", [2, 5]], ["src/other.ts", [9]]), covers()], CHANGED_FILES);

  const report = await adapter.collect("/e2e", "qa-abc");

  assert.deepEqual(report.covered.map((c) => [c.file, [...c.lines].sort((a, b) => a - b)]).sort(), [["src/other.ts", [9]], ["src/svc.ts", [1, 2, 5]]]);
});

test("returns an empty report when no dump was read (fail-open)", async () => {
  const adapter = new V8BrowserCoverageAdapter(async () => [], CHANGED_FILES);
  const report = await adapter.collect("/e2e", "qa-abc");
  assert.deepEqual(report.covered, []);
});

test("returns an empty report when no dump covers any of the changed files", async () => {
  const adapter = new V8BrowserCoverageAdapter(async () => [covers(), covers()], CHANGED_FILES);
  const report = await adapter.collect("/e2e", "qa-abc");
  assert.deepEqual(report.covered, []);
});

test("the dumps are read for the changed files the adapter was built with, and for the ones a collection is given instead", async () => {
  const asked: Array<[string, string, string[]]> = [];
  const adapter = new V8BrowserCoverageAdapter(async (specDir, namespace, changed) => {
    asked.push([specDir, namespace, changed]);
    return [];
  }, CHANGED_FILES);

  await adapter.collect("/e2e", "qa-abc");
  await adapter.collect("/e2e", "qa-def", ["src/other.ts"]);

  assert.deepEqual(asked, [["/e2e", "qa-abc", CHANGED_FILES], ["/e2e", "qa-def", ["src/other.ts"]]]);
});

test("what one collection adds to a report is its own: the lines of a dump are not changed by being merged", async () => {
  const first = covers(["src/svc.ts", [1]]);
  const adapter = new V8BrowserCoverageAdapter(async () => [first, covers(["src/svc.ts", [2]])], CHANGED_FILES);

  await adapter.collect("/e2e", "qa-abc");

  assert.deepEqual([...first.get("src/svc.ts")!], [1]);
});

test("the report says how many scripts the dumps held and how many carried a source map, so a change nothing maps to can be told from one that was never measurable", async () => {
  const adapter = new V8BrowserCoverageAdapter(async (_dir, _ns, _changed, scripts) => {
    scripts!.total += 7;
    return [covers()];
  }, CHANGED_FILES);

  const report = await adapter.collect("/e2e", "qa-abc");

  assert.deepEqual(report.scripts, { total: 7, withSourceMap: 0 });
});

test("a recollection adds the dumps of several namespaces into one report, leaving out of each the dumps of the spec files it excludes", async () => {
  const dumps: Record<string, Array<[string, CoveredLines]>> = {
    base: [
      ["flows-a-spec-ts-x-0-0.json", covers(["src/svc.ts", [1, 2]])],
      ["flows-b-spec-ts-y-0-0.json", covers(["src/svc.ts", [3]])],
    ],
    acc: [["flows-a-spec-ts-x-0-0.json", covers(["src/svc.ts", [7]])]],
  };
  const adapter = new V8BrowserCoverageAdapter(async (_dir, namespace, _files, _scripts, _branches, keep) => (dumps[namespace] ?? []).filter(([name]) => keep?.(name) ?? true).map(([, c]) => c), CHANGED_FILES);

  const report = await adapter.recollect("/e2e", [{ namespace: "base", exceptSpecFiles: ["flows/a.spec.ts"] }, { namespace: "acc" }]);

  assert.deepEqual(report.covered.map((c) => [c.file, [...c.lines].sort((a, b) => a - b)]), [["src/svc.ts", [3, 7]]], "the rewritten spec counts only from its new run");
});

test("a mutant's source is read with its edit and only from the dumps of its spec files; a source other than a mutant's that yields no dump makes the report a part", async () => {
  const dumps: Record<string, Array<[string, CoveredLines]>> = {
    base: [["flows-a-spec-ts-x-0-0.json", covers(["src/svc.ts", [1]])]],
    "base-mut0": [
      ["flows-a-spec-ts-x-0-0.json", covers(["src/svc.ts", [5]])],
      ["flows-b-spec-ts-y-0-0.json", covers(["src/svc.ts", [9]])],
    ],
  };
  const edits: unknown[] = [];
  const adapter = new V8BrowserCoverageAdapter(async (_dir, namespace, _files, _scripts, _branches, keep, _executable, mutant) => {
    edits.push(mutant);
    return (dumps[namespace] ?? []).filter(([name]) => keep?.(name) ?? true).map(([, c]) => c);
  }, CHANGED_FILES);
  const mutant = { url: "u", sha256: "h", edit: { start: 0, end: 1, replacement: "!" }, original: "a" };

  const proved = await adapter.recollect("/e2e", [{ namespace: "base" }, { namespace: "base-mut0", onlySpecFiles: ["flows/a.spec.ts"], mutant }]);
  const missingMutant = await adapter.recollect("/e2e", [{ namespace: "base" }, { namespace: "gone-mut1", mutant }]);
  const missingBase = await adapter.recollect("/e2e", [{ namespace: "gone" }, { namespace: "base-mut0", mutant }]);

  assert.deepEqual(proved.covered.map((c) => [c.file, [...c.lines].sort((a, b) => a - b)]), [["src/svc.ts", [1, 5]]], "the failing spec's dump only");
  assert.deepEqual(edits.slice(0, 2), [undefined, mutant]);
  assert.equal(proved.incomplete, undefined);
  assert.equal(missingMutant.incomplete, undefined, "a mutant's re-run that wrote nothing proves nothing and takes nothing away");
  assert.equal(missingBase.incomplete, true);
});
