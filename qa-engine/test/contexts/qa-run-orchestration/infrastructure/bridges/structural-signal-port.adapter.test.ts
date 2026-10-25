/* CodeGraphPort + CoChangePort (fakes here) + blast-radius-signal.ts's pure renderer into ONE StructuralSignalPort.render()
   call. One graph walk answers the change: its depth-0 symbols are the changed ones, the deeper ones the code that reaches
   them. Never throws: an unavailable answer degrades to an empty list for that field. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADVISORY_BUDGET, StructuralSignalPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/structural-signal-port.adapter.ts";
import { DOSSIER_HEADING, renderBlastRadiusSignal } from "@contexts/qa-run-orchestration/infrastructure/bridges/blast-radius-signal.ts";
import type { CodeExplorePort } from "@kernel/ports/code-explore.port.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";
import { ok, err } from "@kernel/result.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { CoChangePort } from "@kernel/ports/co-change.port.ts";
import type { ImpactedSymbol } from "@kernel/code/index.ts";
import type { Attrs } from "@kernel/telemetry/attribute-registry.ts";
import { newSandboxReport, withExecScope } from "../../../../../src/shared-infrastructure/process-sandbox/exec-scope.ts";

const SHA = "abc1234";
const report = (symbols: ImpactedSymbol[], truncated = false) => ok({ indexedSha: SHA, symbols, truncated });

function fakeCodeGraph(overrides: Partial<CodeGraphPort> = {}): CodeGraphPort {
  return {
    syncTo: overrides.syncTo ?? (async (repo, sha) => ({ repo, engine: "fake", engineVersion: "1", sha, outcome: "built", durationMs: 0, nodeCount: 1, edgeCount: 0 })),
    impactedSymbols: overrides.impactedSymbols ?? (async () => report([])),
    callersOf: overrides.callersOf ?? (async () => report([])),
    routes: overrides.routes ?? (async () => ok([])),
  };
}

function fakeCoChange(impl?: CoChangePort["coChangeCoupling"]): CoChangePort {
  return { coChangeCoupling: impl ?? (async () => ok([])) };
}

const changed = BlastRadius.of(Sha.of(SHA), ["src/Foo.java", "src/Bar.java"]);
const changedSymbol: ImpactedSymbol = { file: "src/Foo.java", symbol: "run", kind: "method", depth: 0 };
const caller: ImpactedSymbol = { file: "src/Caller.java", symbol: "call", kind: "method", depth: 1, via: { file: "src/Foo.java", symbol: "run" } };

test("renders the walk's changed symbols, the code that reaches them and the co-change files as the pure renderer would", async () => {
  const coupled = [{ file: "src/Coupled.java", couplingScore: 0.8, coChanges: 5 }];
  const adapter = new StructuralSignalPortAdapter(
    fakeCodeGraph({ impactedSymbols: async () => report([changedSymbol, caller]) }),
    fakeCoChange(async () => ok(coupled)),
    "/repo",
  );

  const { text } = await adapter.render("/repo", changed);

  const expected = renderBlastRadiusSignal({
    impacted: [{ file: "src/Foo.java", symbol: "run" }],
    callers: [{ file: "src/Caller.java", symbol: "call" }],
    coupled,
  });
  assert.equal(text, expected);
  assert.notEqual(text, "");
});

test("asks the graph once, within the advisory budget, and the co-change history with the same change", async () => {
  const budgets: unknown[] = [];
  let callersAsked = 0;
  let coChangeArg: BlastRadius | undefined;
  const adapter = new StructuralSignalPortAdapter(
    fakeCodeGraph({
      impactedSymbols: async (_repo, _changed, budget) => { budgets.push(budget); return report([changedSymbol]); },
      callersOf: async () => { callersAsked += 1; return report([]); },
    }),
    fakeCoChange(async (_repo, c) => { coChangeArg = c; return ok([]); }),
    "/repo",
  );

  await adapter.render("/repo", changed);

  assert.deepEqual(budgets, [ADVISORY_BUDGET], "one walk, within the declared budget");
  assert.equal(callersAsked, 0, "the walk already holds the callers: no per-symbol query");
  assert.equal(coChangeArg, changed);
});

test("an unavailable graph and history degrade to an empty block that names no symbols", async () => {
  const adapter = new StructuralSignalPortAdapter(
    fakeCodeGraph({ impactedSymbols: async () => err({ reason: "not indexed" }) }),
    fakeCoChange(async () => err({ reason: "git failed" })),
    "/repo",
  );

  const result = await adapter.render("/repo", changed);

  assert.deepEqual(result, { text: "", hasSymbols: false });
});

test("an empty BlastRadius renders nothing without asking the graph or the history", async () => {
  let called = false;
  const adapter = new StructuralSignalPortAdapter(
    fakeCodeGraph({ impactedSymbols: async () => { called = true; return report([]); } }),
    fakeCoChange(async () => { called = true; return ok([]); }),
    "/repo",
  );

  const result = await adapter.render("/repo", BlastRadius.of(Sha.of(SHA), []));

  assert.deepEqual(result, { text: "", hasSymbols: false });
  assert.equal(called, false);
});

test("a thrown error from either port degrades to an empty block, never propagates", async () => {
  const adapter = new StructuralSignalPortAdapter(
    fakeCodeGraph({ impactedSymbols: async () => { throw new Error("boom"); } }),
    fakeCoChange(async () => { throw new Error("boom"); }),
    "/repo",
  );

  assert.deepEqual(await adapter.render("/repo", changed), { text: "", hasSymbols: false });
});

test("the constructor's repo root wins over the call-site directory (the run indexed the repo root, not the e2e folder)", async () => {
  const seen: string[] = [];
  const adapter = new StructuralSignalPortAdapter(
    fakeCodeGraph({ impactedSymbols: async (repo) => { seen.push(repo); return report([]); } }),
    fakeCoChange(async (repo) => { seen.push(repo); return ok([]); }),
    "/mirrors/org/app",
  );

  await adapter.render("/mirrors/org/app/e2e", changed);

  assert.deepEqual(seen, ["/mirrors/org/app", "/mirrors/org/app"]);
});

test("the result names the commit of the index it read, and none when the graph gave no answer", async () => {
  const answered = new StructuralSignalPortAdapter(fakeCodeGraph({ impactedSymbols: async () => report([changedSymbol]) }), fakeCoChange(), "/repo");
  const unanswered = new StructuralSignalPortAdapter(fakeCodeGraph({ impactedSymbols: async () => err({ reason: "x" }) }), fakeCoChange(), "/repo");

  assert.equal((await answered.render("/repo", changed)).indexedSha, SHA);
  assert.equal("indexedSha" in (await unanswered.render("/repo", changed)), false);
});

/* A block that holds co-change files alone names the files that tend to move together, never the code the change reaches. */

test("changed symbols, with or without callers, make the block name symbols", async () => {
  const alone = new StructuralSignalPortAdapter(fakeCodeGraph({ impactedSymbols: async () => report([changedSymbol]) }), fakeCoChange(), "/repo");
  assert.equal((await alone.render("/repo", changed)).hasSymbols, true);

  const withCallers = new StructuralSignalPortAdapter(
    fakeCodeGraph({ impactedSymbols: async () => report([changedSymbol, caller]) }),
    fakeCoChange(async () => ok([{ file: "src/Coupled.java", couplingScore: 0.8, coChanges: 5 }])),
    "/repo",
  );
  const result = await withCallers.render("/repo", changed);
  assert.equal(result.hasSymbols, true);
  assert.ok(result.text.includes("`call`") && result.text.includes("`run`"));
});

test("co-change files alone render a block but leave the symbol flag false", async () => {
  const adapter = new StructuralSignalPortAdapter(
    fakeCodeGraph(),
    fakeCoChange(async () => ok([{ file: "src/Coupled.java", couplingScore: 0.8, coChanges: 5 }])),
    "/repo",
  );

  const { text, hasSymbols } = await adapter.render("/repo", changed);

  assert.ok(text.includes("src/Coupled.java"));
  assert.equal(hasSymbols, false);
});

/* The change dossier: the engine's read-equivalent source of the change's top symbols, inside the same block. */

const EXPLORED = ["**`src/Foo.java`** — 1 symbol", "```java", "3\tpublic void run() {", "4\t  const key = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';", "5\t}", "```"].join("\n");

function fakeExplore(answer: string | undefined, asked: Array<{ terms: readonly string[]; maxFiles: number }> = []): CodeExplorePort {
  return {
    explore: async (_repo, terms, maxFiles) => {
      asked.push({ terms, maxFiles });
      return answer === undefined ? err({ reason: "not indexed" }) : ok({ text: answer, indexedSha: SHA });
    },
  };
}

test("with the dossier on, the block carries the engine's source of the change's top symbols, sanitized, and names the files it shows", async () => {
  const asked: Array<{ terms: readonly string[]; maxFiles: number }> = [];
  const other: ImpactedSymbol = { file: "src/Bar.java", symbol: "idle", kind: "method", depth: 0 };
  const adapter = new StructuralSignalPortAdapter(
    fakeCodeGraph({ impactedSymbols: async () => report([other, changedSymbol, caller]) }),
    fakeCoChange(),
    "/repo",
    { explore: fakeExplore(EXPLORED, asked), limits: { maxSymbols: 4, maxFiles: 3, maxChars: 8_000 } },
  );

  const result = await adapter.render("/repo", changed);

  assert.deepEqual(asked, [{ terms: ["run", "idle"], maxFiles: 3 }], "the changed symbol the most code reaches comes first");
  assert.ok(result.text.includes(DOSSIER_HEADING));
  assert.ok(result.text.includes("3\tpublic void run() {"));
  assert.equal(result.text.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), false, "the engine's text is sanitized before it reaches the prompt");
  assert.deepEqual(result.providedFiles, ["src/Foo.java"]);
});

test("with the dossier off, or when the index cannot answer, the block is the lists alone", async () => {
  const asked: Array<{ terms: readonly string[]; maxFiles: number }> = [];
  const graph = fakeCodeGraph({ impactedSymbols: async () => report([changedSymbol, caller]) });
  const off = await new StructuralSignalPortAdapter(graph, fakeCoChange(), "/repo").render("/repo", changed);
  const unanswered = await new StructuralSignalPortAdapter(graph, fakeCoChange(), "/repo", { explore: fakeExplore(undefined, asked) }).render("/repo", changed);

  for (const result of [off, unanswered]) {
    assert.equal(result.text.includes(DOSSIER_HEADING), false);
    assert.equal("providedFiles" in result, false);
  }
  assert.equal(asked.length, 1);
});

test("a dossier is never asked for a change with no changed symbol", async () => {
  const asked: Array<{ terms: readonly string[]; maxFiles: number }> = [];
  const adapter = new StructuralSignalPortAdapter(fakeCodeGraph(), fakeCoChange(async () => ok([{ file: "src/Coupled.java", couplingScore: 0.8, coChanges: 5 }])), "/repo", { explore: fakeExplore(EXPLORED, asked) });
  const result = await adapter.render("/repo", changed);
  assert.deepEqual(asked, []);
  assert.equal(result.text.includes(DOSSIER_HEADING), false);
});

test("the lists give way to the dossier within the block's budget, and the dossier is shown whole", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ file: `src/very/long/path/to/a/module/number/${i}/File${i}.java`, symbol: `symbolWithALongName${i}` }));
  const text = renderBlastRadiusSignal({ impacted: many, callers: many, coupled: [], dossier: EXPLORED });
  assert.ok(Buffer.byteLength(text, "utf8") <= 20_000);
  assert.ok(text.endsWith(`${DOSSIER_HEADING}\n${EXPLORED}\n`));
  assert.match(text, /structural blast radius truncated/);
});

test("a block of co-change files alone carries no dossier", () => {
  const text = renderBlastRadiusSignal({ impacted: [], callers: [], coupled: [{ file: "a.ts", couplingScore: 0.5, coChanges: 3 }], dossier: EXPLORED });
  assert.equal(text.includes(DOSSIER_HEADING), false);
});

test("a dossier none of whose source fits the block's bytes is left out, and so are the files it would have shown", async () => {
  const wide = ["**`src/Foo.java`** — 1 symbol", "```java", `3\tString s = "${"é".repeat(7_800)}";`, "```"].join("\n");
  const adapter = new StructuralSignalPortAdapter(
    fakeCodeGraph({ impactedSymbols: async () => report([changedSymbol, caller]) }),
    fakeCoChange(),
    "/repo",
    { explore: fakeExplore(wide) },
  );

  const result = await adapter.render("/repo", changed);

  assert.equal(result.text.includes(DOSSIER_HEADING), false);
  assert.equal("providedFiles" in result, false, "a file the prompt does not show is not counted as provided");
});

/* What the operator can see of a render: the attributes put on the open phase's span and the warnings logged. */
async function observed<T>(fn: () => Promise<T>): Promise<{ value: T; notes: Attrs; logs: string[] }> {
  const notes: Attrs = {};
  const logs: string[] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args: unknown[]) => void logs.push(args.join(" "));
  console.error = (...args: unknown[]) => void logs.push(args.join(" "));
  try {
    const value = await withExecScope(
      { runId: "r1", workDir: "/tmp/qa-exec/r1", egress: { dev: [], install: [] }, report: newSandboxReport(), telemetry: { parent: () => undefined, annotate: (attrs) => void Object.assign(notes, attrs) } },
      fn,
    );
    return { value, notes, logs };
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
}

const reaching = fakeCodeGraph({ impactedSymbols: async () => report([changedSymbol, caller]) });

test("a dossier whose characters fit the cap but whose bytes would not fit the block is cut to the block's bytes and shown", async () => {
  const lines = Array.from({ length: 150 }, (_, i) => `${i + 3}\tconst s${i} = "${"é".repeat(45)}";`);
  const wide = ["**`src/Foo.java`** — 1 symbol", "```java", ...lines, "```"].join("\n");
  const { value: result, notes } = await observed(() => new StructuralSignalPortAdapter(reaching, fakeCoChange(), "/repo", { explore: fakeExplore(wide) }).render("/repo", changed));

  assert.ok(result.text.includes(DOSSIER_HEADING), "the dossier is shown, cut, not dropped");
  assert.ok(Buffer.byteLength(result.text, "utf8") <= 20_000);
  assert.deepEqual(result.providedFiles, ["src/Foo.java"]);
  assert.equal(notes["qayaba.structural.dossier"], "shown");
});

test("a dossier that cannot be shown leaves a log and a span attribute saying why: the engine could not answer, threw, or showed no file", async () => {
  const cases: Array<{ explore: CodeExplorePort; outcome: string }> = [
    { explore: fakeExplore(undefined), outcome: "unavailable" },
    { explore: { explore: async () => { throw new Error("engine crashed"); } }, outcome: "unavailable" },
    { explore: fakeExplore("**Exploration: run**\n\nNothing found."), outcome: "empty" },
  ];
  for (const { explore, outcome } of cases) {
    const { value: result, notes, logs } = await observed(() => new StructuralSignalPortAdapter(reaching, fakeCoChange(), "/repo", { explore }).render("/repo", changed));
    assert.equal(result.text.includes(DOSSIER_HEADING), false);
    assert.equal(notes["qayaba.structural.dossier"], outcome);
    assert.ok(logs.some((l) => l.includes("dossier")), `a log says the dossier was not shown (${outcome})`);
  }
});

test("a failed, thrown or truncated impact walk is logged and recorded, and render still returns", async () => {
  const cases: Array<{ graph: CodeGraphPort; walk: string }> = [
    { graph: fakeCodeGraph({ impactedSymbols: async () => err({ reason: "not indexed" }) }), walk: "failed" },
    { graph: fakeCodeGraph({ impactedSymbols: async () => { throw new Error("boom"); } }), walk: "failed" },
    { graph: fakeCodeGraph({ impactedSymbols: async () => report([changedSymbol, caller], true) }), walk: "truncated" },
  ];
  for (const { graph, walk } of cases) {
    const { notes, logs } = await observed(() => new StructuralSignalPortAdapter(graph, fakeCoChange(), "/repo").render("/repo", changed));
    assert.equal(notes["qayaba.structural.walk"], walk);
    assert.ok(logs.some((l) => l.includes("impact walk")), `a log says the walk was ${walk}`);
  }
  const ok = await observed(() => new StructuralSignalPortAdapter(reaching, fakeCoChange(), "/repo").render("/repo", changed));
  assert.equal(ok.notes["qayaba.structural.walk"], "complete");
  assert.deepEqual(ok.logs, [], "a complete walk logs nothing");
});
