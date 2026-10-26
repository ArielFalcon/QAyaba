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
