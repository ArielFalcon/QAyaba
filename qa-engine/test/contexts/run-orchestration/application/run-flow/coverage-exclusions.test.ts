/* Changed code no web run can load by the change's own design, and test support, are decided once from the run's facts and handed to every measurement of the run, so each one leaves out the same files. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { coverageExclusionsOf, measureCoverage, recountAfter, type GapRegeneration } from "@contexts/run-orchestration/application/run-flow/phases/coverage.steps.ts";
import { initialRunState, type RunState } from "@contexts/run-orchestration/application/run-flow/run-state.ts";
import type { WorkspaceRunContext } from "@contexts/run-orchestration/application/run-flow/run-context.ts";
import type { CoverageExclusions } from "@contexts/objective-signal/application/index.ts";
import type { ChangeScope } from "@contexts/change-analysis/domain/change-scope.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { RouteAvailabilityFact } from "@kernel/route-availability.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { ImportersReport } from "@kernel/code/index.ts";
import { err, ok } from "@kernel/result.ts";
import { Sha } from "@kernel/sha.ts";

const PREVIEW = "src/app/preview.page.ts";
const HELPER = "src/app/store.spec-helper.ts";
const CHECKOUT = "src/app/checkout.ts";

const section = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,2 @@\n+a\n+b\n`;
const DIFF = section(CHECKOUT) + section(PREVIEW) + section(HELPER);

const seed = (file: string) => ({ file, symbol: "S" });
const candidate = (route: string, files: string[]): UseCaseCandidate => ({
  id: `uc-${route}`,
  entry: { kind: "page", repo: "o/app", route },
  tier: "direct",
  basis: "graph",
  evidence: [],
  seeds: files.map(seed),
  confidence: 1,
  reachability: "page",
  pages: [],
  existingSpecs: [],
});
const scopeOf = (files: string[]): ChangeScope => ({
  repos: [{ repo: "o/app", role: "primary", indexedSha: "abc", changedFiles: files, seeds: files.map(seed), seedBasis: "lines", entryPoints: [], entryPointsTruncated: false }],
  reach: [],
  hubs: [],
  disagreements: [],
  omitted: 0,
  degraded: [],
});
const byDesign = (route: string): RouteAvailabilityFact => ({
  route,
  outcome: { kind: "redirected", to: "/home", mechanism: "client" },
  basis: { class: "change-introduced", via: "route-declaration", at: "src/app.routes.ts:3" },
});

function stateOf(overrides: { facts?: RouteAvailabilityFact[]; candidates?: UseCaseCandidate[] } = {}): RunState {
  const state = initialRunState();
  state.classification = { ...state.classification, diff: DIFF } as RunState["classification"];
  state.grounding = {
    ...state.grounding,
    changeScope: scopeOf([CHECKOUT, PREVIEW]),
    candidates: overrides.candidates ?? [candidate("/checkout", [CHECKOUT]), candidate("/upload-menu/preview", [PREVIEW])],
    routeAvailability: { read: 2, facts: overrides.facts ?? [byDesign("/upload-menu/preview")] },
  };
  return state;
}

const importers = (files: ImportersReport["files"]): ImportersReport => ({ indexedSha: "abc", files });
const HELPER_IMPORTERS = importers([
  { file: CHECKOUT, indexed: true, importers: ["src/app/app.ts"], complete: true },
  { file: HELPER, indexed: true, importers: ["src/app/a.spec.ts", "src/app/b.spec.ts"], complete: true },
]);

function ctxOf(codeGraph?: Partial<CodeGraphPort>, extra: { triggerRepo?: string } = {}) {
  const measured: unknown[] = [];
  const recounted: unknown[] = [];
  const asked: unknown[] = [];
  const ctx = {
    deps: {
      ...(codeGraph ? { codeGraph: { ...codeGraph, importersOf: codeGraph.importersOf && (async (dir: string, files: readonly string[]) => (asked.push([dir, files]), codeGraph.importersOf!(dir, files))) } } : {}),
      objectiveSignal: {
        measure: async (...args: unknown[]) => (measured.push(args[4]), { status: "pass", ratio: 1, measurement: { changedLines: 2, coveredChanged: 2, changedFiles: 1, mappedFiles: 1, unreachableByDesign: [{ file: PREVIEW, routes: ["/upload-menu/preview"] }], testSupportFiles: [{ file: HELPER, importers: 2 }] } }),
        recount: async (...args: unknown[]) => (recounted.push(args[4]), { status: "pass", ratio: 1, uncovered: [], untakenArms: [], measurement: { changedLines: 2, coveredChanged: 2, changedFiles: 1, mappedFiles: 1 } }),
        blocks: () => false,
      },
    },
    input: { sha: Sha.of("abc1234"), mode: "diff", ...extra },
    cfg: { coveragePolicyMode: "signal" },
    workspace: { specDir: "/e2e" },
    services: { specRoot: { mirrorDir: "/mirror" } },
  } as unknown as WorkspaceRunContext;
  return { ctx, measured, recounted, asked };
}

test("a file only reached through a route the change made unavailable, and a file only tests import, are left out, the rest counted", async () => {
  const { ctx, asked } = ctxOf({ importersOf: async () => ok(HELPER_IMPORTERS) });

  const out = await coverageExclusionsOf(stateOf(), ctx);

  assert.deepEqual(out, { unreachableByDesign: [{ file: PREVIEW, routes: ["/upload-menu/preview"] }], testSupportFiles: [{ file: HELPER, importers: 2 }] });
  assert.deepEqual(asked, [["/mirror", [CHECKOUT, HELPER]]], "the graph is asked only about the files the route facts did not settle");
});

test("a file reached by an unavailable route and by an available one stays counted", async () => {
  const state = stateOf({ candidates: [candidate("/checkout", [CHECKOUT, PREVIEW]), candidate("/upload-menu/preview", [PREVIEW])] });
  const { ctx } = ctxOf({ importersOf: async () => ok(importers([])) });

  assert.equal(await coverageExclusionsOf(state, ctx), undefined);
});

test("a file imported by a test and by production code stays counted", async () => {
  const { ctx } = ctxOf({ importersOf: async () => ok(importers([{ file: HELPER, indexed: true, importers: ["src/app/a.spec.ts", "src/app/page.ts"], complete: true }])) });

  assert.equal(await coverageExclusionsOf(stateOf({ facts: [] }), ctx), undefined);
});

test("without the route facts, the import edges or an answering graph, every file stays counted", async () => {
  assert.equal(await coverageExclusionsOf(stateOf({ facts: [] }), ctxOf().ctx), undefined, "no graph");
  assert.equal(await coverageExclusionsOf(stateOf({ facts: [] }), ctxOf({}).ctx), undefined, "a graph with no import edges");
  assert.equal(await coverageExclusionsOf(stateOf({ facts: [] }), ctxOf({ importersOf: async () => err({ reason: "the repo is not indexed in this run" }) }).ctx), undefined, "a graph that cannot answer");
  const state = stateOf();
  state.grounding = { ...state.grounding, routeAvailability: undefined, changeScope: undefined };
  assert.equal(await coverageExclusionsOf(state, ctxOf().ctx), undefined, "no scope and no facts");
});

test("a cross-repo run, whose diff is withheld, leaves nothing out", async () => {
  const { ctx, asked } = ctxOf({ importersOf: async () => ok(HELPER_IMPORTERS) }, { triggerRepo: "o/svc" });

  assert.equal(await coverageExclusionsOf(stateOf(), ctx), undefined);
  assert.deepEqual(asked, []);
});

test("the first measurement hands the exclusions to the port, records them beside the ratio and keeps them for the recounts", async () => {
  const { ctx, measured, recounted } = ctxOf({ importersOf: async () => ok(HELPER_IMPORTERS) });
  const state = stateOf();
  state.execution = { ...state.execution, run: { verdict: "pass", cases: [], logs: "" } } as RunState["execution"];

  const out = await measureCoverage(state, ctx);
  const coverage = (out as { update: { coverage: RunState["coverage"] } }).update.coverage;

  const expected: CoverageExclusions = { unreachableByDesign: [{ file: PREVIEW, routes: ["/upload-menu/preview"] }], testSupportFiles: [{ file: HELPER, importers: 2 }] };
  assert.deepEqual((measured[0] as { exclusions: CoverageExclusions }).exclusions, expected);
  assert.deepEqual(coverage.exclusions, expected);
  assert.deepEqual(coverage.changeCoverage, { executableLines: 2, unreachableByDesign: expected.unreachableByDesign, testSupportFiles: expected.testSupportFiles });

  await recountAfter({ ...state, coverage }, ctx, { outcome: "accepted", run: {}, acceptanceCalls: 1, leadCorrections: 0, reruns: [{ namespace: "r-acc0", specFiles: ["a.spec.ts"] }] } as unknown as GapRegeneration);
  assert.deepEqual((recounted[0] as { exclusions: CoverageExclusions }).exclusions, expected, "a recount leaves out the same files");
});

test("a run with nothing to leave out measures as before: the port is handed no exclusions", async () => {
  const { ctx, measured } = ctxOf({ importersOf: async () => ok(importers([])) });
  const state = stateOf({ facts: [] });
  state.execution = { ...state.execution, run: { verdict: "pass", cases: [], logs: "" } } as RunState["execution"];

  await measureCoverage(state, ctx);

  assert.equal("exclusions" in (measured[0] as object), false);
});
