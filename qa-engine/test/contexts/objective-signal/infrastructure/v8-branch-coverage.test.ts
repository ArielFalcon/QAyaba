/* Branch coverage of the changed code from what V8 ran: the decisions of a script that is a changed file, or of a bundle whose source map places them in one, with each arm taken when V8's block counts say it ran in at least one dump. The counts here are V8's own: each script runs in this process under precise block coverage, as a browser page's do. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { V8BrowserCoverageAdapter, defaultParseV8Coverage, type V8Entry } from "@contexts/objective-signal/infrastructure/v8-browser-coverage.adapter.ts";
import { BranchSink, MAX_BRANCH_DECISIONS } from "@contexts/objective-signal/infrastructure/v8-branch-coverage.ts";

let scriptCount = 0;

/* The functions V8's precise block coverage reports for `source` once it has run. */
async function ranUnderCoverage(source: string): Promise<V8Entry["functions"]> {
  const filename = `branch-probe-${++scriptCount}.js`;
  const session = new Session();
  session.connect();
  try {
    await session.post("Profiler.enable");
    await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
    new vm.Script(source, { filename }).runInThisContext();
    const { result } = await session.post("Profiler.takePreciseCoverage");
    await session.post("Profiler.stopPreciseCoverage");
    const script = result.find((s) => s.url === filename);
    assert.ok(script, "V8 reported the script");
    return script.functions;
  } finally {
    session.disconnect();
  }
}

const STORE = `function load(found, failed, kind, cached) {
  let state = "idle";
  if (found) { state = "ready"; } else { state = "missing"; }
  if (failed) { state = "failed"; }
  const label = found ? "Ver" : "Buscar";
  const retry = failed && kind === 503;
  const source = cached ?? "network";
  switch (kind) {
    case 404: state = "missing"; break;
    case 503: state = "failed"; break;
    default: state = state;
  }
  return [state, label, retry, source];
}
`;

/* What the decisions of src/store.ts say after `calls` ran, served at the file's own URL. */
async function branchesOf(calls: string) {
  const source = STORE + calls;
  const functions = await ranUnderCoverage(source);
  const sink = new BranchSink();
  defaultParseV8Coverage([{ url: "https://dev.example/src/store.ts", source, functions }], ["src/store.ts"], undefined, undefined, sink);
  return sink.result()!;
}

const arms = (hits: Awaited<ReturnType<typeof branchesOf>>, line: number) => Object.fromEntries(hits.filter((h) => h.line === line).flatMap((h) => h.arms.map((a) => [a.label, a.taken])));

test("each decision of a changed file is found at its line with whether each arm ran: explicit and implicit else, both sides of a conditional, a short circuit and every switch clause", async () => {
  const hits = await branchesOf(`load(true, false, 404, "memory");\n`);

  assert.deepEqual(hits.map((h) => [h.line, h.kind]), [[3, "if"], [4, "if"], [5, "conditional"], [6, "logical"], [7, "logical"], [8, "switch"]]);
  assert.deepEqual(arms(hits, 3), { then: true, else: false }, "the explicit else never ran");
  assert.deepEqual(arms(hits, 4), { then: false, else: true }, "the implicit else ran: the decision was reached and its then was not");
  assert.deepEqual(arms(hits, 5), { true: true, false: false });
  assert.deepEqual(arms(hits, 6), { "right of && evaluated": false, "&& short-circuited": true });
  assert.deepEqual(arms(hits, 7), { "right of ?? evaluated": false, "?? short-circuited": true }, "a value that is not nullish never evaluates the fallback");
  assert.deepEqual(arms(hits, 8), { "case 404": true, "case 503": false, default: false });
});

test("an arm taken in any dump is taken, and a dump of a script whose decisions all ran in another adds nothing new", async () => {
  const first = await ranUnderCoverage(STORE + `load(true, false, 404, "memory");\n`);
  const second = await ranUnderCoverage(STORE + `load(false, true, 503, null);\n`);
  const sink = new BranchSink();
  const url = "https://dev.example/src/store.ts";
  defaultParseV8Coverage([{ url, source: STORE + `load(true, false, 404, "memory");\n`, functions: first }], ["src/store.ts"], undefined, undefined, sink);
  defaultParseV8Coverage([{ url, source: STORE + `load(false, true, 503, null);\n`, functions: second }], ["src/store.ts"], undefined, undefined, sink);

  const hits = sink.result()!;
  assert.deepEqual(arms(hits, 3), { then: true, else: true });
  assert.deepEqual(arms(hits, 4), { then: true, else: true });
  assert.deepEqual(arms(hits, 6), { "right of && evaluated": true, "&& short-circuited": true });
  assert.deepEqual(arms(hits, 8), { "case 404": true, "case 503": true, default: false });
});

/* ── a bundle, with the source map that places its decisions ─────── */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function vlq(n: number): string {
  let rest = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = "";
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest > 0) digit |= 32;
    out += B64[digit];
  } while (rest > 0);
  return out;
}

/* A map whose generated line i (0-based) starts with one segment at column 0 from `lines[i]` = [source, original line (0-based)], or none for null. */
function lineMap(sources: string[], lines: Array<[number, number] | null>) {
  let source = 0;
  let line = 0;
  const mappings = lines
    .map((at) => {
      if (!at) return "";
      const text = vlq(0) + vlq(at[0] - source) + vlq(at[1] - line) + vlq(0);
      [source, line] = at;
      return text;
    })
    .join(";");
  return { version: 3, sources, mappings };
}

test("a bundle's decisions are placed in the changed file its map names, at the original line; decisions of other sources, or of a line no segment maps, are not counted", async () => {
  const prelude = `function vendor(x) { return x ? 1 : 2; }\nvendor(true);\n`;
  const storeLines = STORE.split("\n").length - 1;
  const source = prelude + STORE + `load(false, false, 1, null);\n`;
  const functions = await ranUnderCoverage(source);
  const map = lineMap(["../node_modules/vendor.js", "../src/app/store.ts"], [[0, 0], [0, 1], ...Array.from({ length: storeLines }, (_, i): [number, number] | null => (i === 4 ? null : [1, i + 10]))]);
  const sink = new BranchSink();

  defaultParseV8Coverage([{ url: "https://dev.example/main.js", source, functions, map }], ["src/app/store.ts"], undefined, undefined, sink);

  const hits = sink.result()!;
  assert.deepEqual([...new Set(hits.map((h) => h.file))], ["src/app/store.ts"], "the vendor decision maps to no changed file");
  /* Store line k is generated line k+1 (0-based, after the two of the prelude), which the map places at original line k+10 (1-based); store line 5 is the unmapped one. */
  assert.deepEqual(hits.map((h) => h.line), [13, 14, 16, 17, 18], "original lines are the map's, and the unmapped generated line places nothing");
  assert.deepEqual(Object.fromEntries(hits.find((h) => h.line === 13)!.arms.map((a) => [a.label, a.taken])), { then: false, else: true });
});

test("a script the parser cannot read within the bounds leaves the branches unused and the line coverage as it was", async () => {
  const many = Array.from({ length: MAX_BRANCH_DECISIONS + 1 }, (_, i) => `x${i} ? 1 : 0;`).join("\n");
  const source = `var ${Array.from({ length: MAX_BRANCH_DECISIONS + 1 }, (_, i) => `x${i} = 0`).join(", ")};\n${many}\n`;
  const sink = new BranchSink();

  const covered = defaultParseV8Coverage([{ url: "https://dev.example/src/flags.ts", source, functions: [{ ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] }] }], ["src/flags.ts"], undefined, undefined, sink);

  assert.equal(sink.result(), undefined);
  assert.equal(covered.get("src/flags.ts")?.has(1), true);
});

test("the time the dumps are given, spent while a script's branches are read, ends the whole set as it ends the line coverage", () => {
  const sink = new BranchSink();
  let asked = 0;
  const spent = () => ++asked > 1;
  assert.throws(() => defaultParseV8Coverage([{ url: "https://dev.example/src/store.ts", source: STORE, functions: [] }], ["src/store.ts"], spent, undefined, sink));
});

test("the browser collector reports the decisions beside the covered lines, and none when no dump was used", async () => {
  const source = STORE + `load(true, false, 404, "memory");\n`;
  const functions = await ranUnderCoverage(source);
  const entries: V8Entry[] = [{ url: "https://dev.example/src/store.ts", source, functions }];
  const read = (dumps: V8Entry[][]) => new V8BrowserCoverageAdapter(async (_dir, _ns, files, scripts, branches) => dumps.map((d) => defaultParseV8Coverage(d, files, undefined, scripts, branches)), ["src/store.ts"]);

  const report = await read([entries]).collect("/e2e", "ns");
  assert.equal(report.branches?.length, 6);
  assert.ok(report.covered.some((c) => c.file === "src/store.ts"));

  assert.equal("branches" in (await read([]).collect("/e2e", "ns")), false);
});

/* ── mutation sites: the edits of the served script that invert a decision or a comparison of the changed code ─────── */

test("the mutation sites of a changed file are its conditions and comparison or logical operators that ran, each an exact edit of the served script with the dumps that ran it", async () => {
  const source = `function gate(status, ok) {
  if (status === 404) return "missing";
  return ok && status < 500 ? "ready" : "failed";
}
function never(x) { return x > 1; }
gate(404, true);
`;
  const functions = await ranUnderCoverage(source);
  const sink = new BranchSink();
  sink.beginDump("flows-detail-spec-ts-missing-0-0.json");
  defaultParseV8Coverage([{ url: "https://dev.example/src/gate.ts", source, functions }], ["src/gate.ts"], undefined, undefined, sink);

  const sites = sink.mutationSites()!;
  assert.deepEqual(sites.map((s) => [s.line, s.operator]), [[2, "=== → !=="], [2, "negate condition"]], "line 3 never ran past the early return, and `never` never ran");
  const negate = sites.find((s) => s.operator === "negate condition")!;
  assert.equal(source.slice(0, negate.edit.start) + negate.edit.replacement + source.slice(negate.edit.end), source.replace("if (status === 404)", "if (!(status === 404))"));
  assert.deepEqual(negate.script, { url: "https://dev.example/src/gate.ts", sha256: createHash("sha256").update(source).digest("hex") });
  assert.deepEqual(negate.ranIn, ["flows-detail-spec-ts-missing-0-0.json"]);
});

test("a site that ran in several dumps names each of them once", async () => {
  const source = `function f(a) { return a === 1 ? 2 : 3; }\nf(1);\n`;
  const functions = await ranUnderCoverage(source);
  const sink = new BranchSink();
  for (const dump of ["a-0-0.json", "b-0-0.json", "a-0-0.json"]) {
    sink.beginDump(dump);
    defaultParseV8Coverage([{ url: "https://dev.example/src/f.ts", source, functions }], ["src/f.ts"], undefined, undefined, sink);
  }
  assert.deepEqual(sink.mutationSites()!.map((s) => s.ranIn), [["a-0-0.json", "b-0-0.json"], ["a-0-0.json", "b-0-0.json"]]);
});

test("a logical operator is a site when its expression ran, even when its right side never did (V8 opens the right side's range at the operator)", async () => {
  const source = `function pick(param) {\n  return param || "fallback";\n}\npick("given");\n`;
  const functions = await ranUnderCoverage(source);
  const sink = new BranchSink();
  sink.beginDump("d-0-0.json");
  defaultParseV8Coverage([{ url: "https://dev.example/src/pick.ts", source, functions }], ["src/pick.ts"], undefined, undefined, sink);
  assert.deepEqual(sink.mutationSites()!.map((s) => [s.line, s.operator]), [[2, "|| → &&"]]);
});
