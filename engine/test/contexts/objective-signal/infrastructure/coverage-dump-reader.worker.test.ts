/* The read with its real worker: the one boundary where the decoding of the coverage dumps leaves this thread. What the worker hands back must leave the collection the read builds exactly as decoding the same dumps in this thread leaves it, so that moving the CPU work off the loop changes no measurement: the lines, the scripts, the lines scripts hold code for, who ran what, the decisions and the mutation sites, including what a dump that cannot be used had added before it was found out. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoverageScripts, MutantEdit } from "@contexts/objective-signal/domain/coverage-collector.ts";
import { readV8Coverage } from "@contexts/objective-signal/infrastructure/coverage-dump-reader.ts";
import { undoMutant } from "@contexts/objective-signal/infrastructure/undo-mutant.ts";
import { defaultParseV8Coverage, type CoveredLines, type V8Entry } from "@contexts/objective-signal/infrastructure/v8-browser-coverage.adapter.ts";
import { BranchSink } from "@contexts/objective-signal/infrastructure/v8-branch-coverage.ts";
import { ranUnderCoverage } from "../support/ran-under-coverage.ts";

const NS = "qa-bot-abc";
const CHANGED = ["src/store.ts", "src/app/store.ts"];
const URL_OF_STORE = "https://dev.example/src/store.ts";

const STORE = `function load(found, failed, kind, cached) {
  let state = "idle";
  if (found) { state = "ready"; } else { state = "missing"; }
  const label = found ? "Ver" : "Buscar";
  const retry = failed && kind === 503;
  const source = cached ?? "network";
  switch (kind) {
    case 404: state = "missing"; break;
    default: state = state;
  }
  return [state, label, retry, source];
}
`;
/* A map that places each generated line at the same line of the changed file the bundle was made from. */
const SAME_LINES = { version: 3, sources: ["../src/app/store.ts"], mappings: ["AAAA", ...Array.from({ length: 12 }, () => "AACA")].join(";") };

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

function rig(t: TestContext): { e2e: string; dir: string } {
  const e2e = mkdtempSync(join(tmpdir(), "qa-coverage-worker-"));
  t.after(() => rmSync(e2e, { recursive: true, force: true }));
  const dir = join(e2e, ".qa", "coverage", NS);
  mkdirSync(dir, { recursive: true });
  return { e2e, dir };
}

/* The collection a read builds, in a form that can be compared. */
interface Sinks {
  scripts: CoverageScripts;
  branches: BranchSink;
  executable: CoveredLines;
  ranBy: Map<string, Set<string>>;
}
const newSinks = (): Sinks => ({ scripts: { total: 0, withSourceMap: 0 }, branches: new BranchSink(), executable: new Map(), ranBy: new Map() });
const sorted = (lines: CoveredLines): Array<[string, number[]]> => [...lines].map(([file, set]): [string, number[]] => [file, [...set].sort((a, b) => a - b)]).sort(([a], [b]) => a.localeCompare(b));
const snapshot = (used: CoveredLines[] | undefined, sinks: Sinks) => ({
  used: used?.map(sorted),
  scripts: sinks.scripts,
  executable: sorted(sinks.executable),
  ranBy: [...sinks.ranBy].map(([file, names]): [string, string[]] => [file, [...names].sort()]).sort(([a], [b]) => a.localeCompare(b)),
  branches: sinks.branches.result(),
  sites: sinks.branches.mutationSites(),
});

/* What reading the dumps of the namespace in this thread comes to: one dump after the other, each into the collection, the set used only if every dump could be. */
function readInThisThread(dir: string, sinks: Sinks, mutant?: MutantEdit): CoveredLines[] | undefined {
  const dumps: Array<[string, CoveredLines]> = [];
  let unusable = false;
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".json")).sort()) {
    sinks.branches.beginDump(name);
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
      const entries = Array.isArray(parsed) ? (parsed as V8Entry[]) : [];
      dumps.push([name, defaultParseV8Coverage(mutant ? undoMutant(entries, mutant) : entries, CHANGED, sinks.scripts, sinks.branches, sinks.executable)]);
    } catch {
      unusable = true;
    }
  }
  if (unusable) return undefined;
  for (const [name, covered] of dumps) for (const [file, lines] of covered) if (lines.size > 0) sinks.ranBy.set(file, (sinks.ranBy.get(file) ?? new Set<string>()).add(name));
  return dumps.map(([, covered]) => covered);
}

const readWithTheWorker = (e2e: string, sinks: Sinks, mutant?: MutantEdit) => readV8Coverage(e2e, NS, CHANGED, undefined, undefined, undefined, sinks.scripts, sinks.branches, undefined, sinks.executable, mutant, sinks.ranBy);

const entryRunning = async (calls: string, extra: Partial<V8Entry> = {}): Promise<V8Entry> => ({ url: URL_OF_STORE, source: STORE + calls, functions: await ranUnderCoverage(STORE + calls), ...extra });

test("with the real worker the read leaves the collection exactly as decoding the same dumps in this thread does: lines, scripts, code lines, who ran what, decisions and mutation sites", async (t) => {
  const { e2e, dir } = rig(t);
  const bundled = await entryRunning(`load(true, 0, 404, "x");\n`, { url: "https://dev.example/main.js", map: SAME_LINES });
  writeFileSync(join(dir, "a-first.json"), JSON.stringify([await entryRunning(`load(true, false, 404, "memory");\n`)]));
  writeFileSync(join(dir, "b-second.json"), JSON.stringify([await entryRunning(`load(false, true, 503, null);\n`), { url: "https://dev.example/vendor.js", source: "var x = 1;\n", functions: [] }]));
  writeFileSync(join(dir, "c-bundle.json"), JSON.stringify([bundled]));
  writeFileSync(join(dir, "d-none.json"), "[]");

  const expected = newSinks();
  const inThisThread = readInThisThread(dir, expected);
  const actual = newSinks();
  const read = await readWithTheWorker(e2e, actual);

  assert.deepEqual(snapshot(read, actual), snapshot(inThisThread, expected));
  assert.ok(expected.scripts.total >= 4 && expected.scripts.withSourceMap === 1, "the control: the dumps held scripts, one of them with a source map");
  assert.ok((expected.branches.result() ?? []).length > 0 && (expected.branches.mutationSites() ?? []).length > 0, "the control: there are decisions and sites to compare");
  assert.ok(expected.executable.size === 2 && expected.ranBy.size === 2, "the control: both changed files were reached, by the script itself and through its map");
});

test("with the real worker a dump that cannot be used leaves the set unused and the collection as decoding in this thread left it: what the dumps before it, and its own scripts before the bad one, had added", async (t) => {
  const { e2e, dir } = rig(t);
  writeFileSync(join(dir, "a-fine.json"), JSON.stringify([await entryRunning(`load(true, false, 404, "memory");\n`)]));
  writeFileSync(join(dir, "b-bad-second-script.json"), JSON.stringify([await entryRunning(`load(false, true, 503, null);\n`), { url: URL_OF_STORE, source: "x", functions: 5 }]));
  writeFileSync(join(dir, "c-fine.json"), JSON.stringify([await entryRunning(`load(false, false, 1, null);\n`)]));

  const expected = newSinks();
  const inThisThread = readInThisThread(dir, expected);
  const actual = newSinks();
  const read = await readWithTheWorker(e2e, actual);

  assert.equal(inThisThread, undefined, "the control: this thread does not use the set");
  assert.deepEqual(snapshot(undefined, actual), snapshot(undefined, expected));
  assert.deepEqual(read, []);
  assert.equal(expected.scripts.total, 4, "the control: three fine scripts and the bad one's first had been counted");
});

test("with the real worker the dumps of a mutant's re-run are read with its edit undone, as in this thread", async (t) => {
  const { e2e, dir } = rig(t);
  const served = STORE + `load(true, false, 404, "memory");\n`;
  const at = served.indexOf("(found)") + 1;
  const mutated = served.slice(0, at) + "!(found)" + served.slice(at + "found".length);
  const mutant: MutantEdit = { url: URL_OF_STORE, sha256: sha(served), edit: { start: at, end: at + "found".length, replacement: "!(found)" }, original: "found" };
  writeFileSync(join(dir, "a-mutant.json"), JSON.stringify([{ url: URL_OF_STORE, source: mutated, functions: await ranUnderCoverage(mutated) }]));

  const expected = newSinks();
  const inThisThread = readInThisThread(dir, expected, mutant);
  const actual = newSinks();
  const read = await readWithTheWorker(e2e, actual, mutant);

  assert.deepEqual(snapshot(read, actual), snapshot(inThisThread, expected));
  assert.ok((expected.branches.result() ?? []).length > 0, "the control: the mutant's dump was placed on the served script");
});
