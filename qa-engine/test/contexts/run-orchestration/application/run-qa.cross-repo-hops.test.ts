/* The cross-repo impact of a run follows the declared links over more than one hop (RFC-0011): the real impact use case and the real change scope over a fake code graph keyed by repo, through the run's two steps. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sha } from "@kernel/sha.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { ok } from "@kernel/result.ts";
import { DEFAULT_WALK_POLICY, type GraphRoute, type ImpactedSymbol, type LocalSymbolRef } from "@kernel/code/index.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { ServiceLink } from "@kernel/service-links.ts";
import { ChangeSet, crossRepoCallSite, fileImplementsPage, handlerServesOperation, openapiOperationDiff, type ChangeScope, type ChangeScopePort } from "@contexts/change-analysis/application/index.ts";
import { ChangeScopePortAdapter } from "@contexts/change-analysis/infrastructure/adapters/change-scope-port.adapter.ts";
import { CrossRepoImpactPortAdapter } from "@contexts/service-topology/infrastructure/adapters/cross-repo-impact-port.adapter.ts";
import type { SandboxedBinaryRunner } from "../../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { dispose, newRig, observe, scratchDir, type Rig } from "./run-flow/run-end-rig.ts";

const APP = "org/app";
const B = "org/b";
const C = "org/c";
const C_SHA = Sha.of("c333333");
const APP_SHA = Sha.of("a111111");
const C_FILE = "c/ItemController.java";
const ORDERS_PAGE = "web/src/app/orders/orders.page.ts";
const APP_CALL = { file: "web/src/app/orders/orders.api.ts", symbol: "listOrders" };
const B_CALL = { file: "b/OrderClient.java", symbol: "fetch" };
const B_HANDLER = { file: "b/OrderController.java", symbol: "listOrders" };
const C_HANDLER = { file: C_FILE, symbol: "list" };
const DIFF = `diff --git a/${C_FILE} b/${C_FILE}\n--- a/${C_FILE}\n+++ b/${C_FILE}\n@@ -1,1 +1,2 @@\n a\n+b\n`;
const MAP = { routes: [{ path: "/orders", implementationFiles: [ORDERS_PAGE] }], api: [], feBe: [] };

const appToB: ServiceLink = { from: { repo: APP, ...APP_CALL }, to: { repo: B, ...B_HANDLER }, transport: "http", operation: { verb: "GET", path: "/orders" }, confidence: 0.9, source: "openapi-http-resolver" };
const bToC: ServiceLink = { from: { repo: B, ...B_CALL }, to: { repo: C, file: "c/api.yaml", symbol: "list" }, transport: "http", operation: { verb: "GET", path: "/items" }, confidence: 0.9, source: "http-backend-resolver" };

const sym = (ref: LocalSymbolRef, depth: number, extra: Partial<ImpactedSymbol> = {}): ImpactedSymbol => ({ ...ref, kind: "method", depth, confidence: 1, ...extra });
const report = (symbols: ImpactedSymbol[]) => ok({ indexedSha: "x", symbols, truncated: false, seedBasis: "lines" as const });
const handlerRoute = (target: LocalSymbolRef, method: string, path: string): GraphRoute => ({ file: target.file, line: 1, method, path, target: { ...target, kind: "method" } });

interface Dirs { app: string; b: string; c: string }

/* A code graph per repo directory: what each index would answer for the chain app -> B -> C. */
function chainGraph(dirs: Dirs, indexed: string[]): CodeGraphPort {
  return {
    syncTo: async (repoDir, sha) => {
      indexed.push(`${repoDir}@${sha}`);
      return { repo: repoDir, engine: "fake", engineVersion: "1", sha, outcome: "built", durationMs: 0, nodeCount: 1, edgeCount: 0 };
    },
    impactedSymbols: async (repoDir) => {
      if (repoDir === dirs.c) return report([sym(C_HANDLER, 0)]);
      if (repoDir === dirs.app) return report([sym(APP_CALL, 0)]);
      throw new Error(`no walk of a change expected in ${repoDir}`);
    },
    callersOf: async (repoDir, seeds) => {
      if (repoDir === dirs.b) {
        assert.deepEqual(seeds, [B_CALL]);
        return report([sym(B_CALL, 0), sym(B_HANDLER, 1, { via: B_CALL, seeds: [{ ...B_CALL, hops: 1 }] })]);
      }
      if (repoDir === dirs.app) {
        assert.deepEqual(seeds, [APP_CALL]);
        return report([sym(APP_CALL, 0), sym({ file: ORDERS_PAGE, symbol: "load" }, 1, { via: APP_CALL, seeds: [{ ...APP_CALL, hops: 1 }] })]);
      }
      throw new Error(`no walk from call sites expected in ${repoDir}`);
    },
    routes: async (repoDir) => {
      if (repoDir === dirs.c) return ok([handlerRoute(C_HANDLER, "GET", "/items")]);
      if (repoDir === dirs.b) return ok([handlerRoute(B_HANDLER, "GET", "/orders")]);
      return ok([{ file: ORDERS_PAGE, line: 1, path: "/orders" }]);
    },
  };
}

interface World { dirs: Dirs; indexed: string[]; scopes: ChangeScope[]; rig: Rig }

/* The run's two steps over the real use case and the real scope adapter; `changed` is the repo the run's change is in. */
function world(links: readonly ServiceLink[], changed: "c" | "app"): World {
  const rig = newRig();
  const root = scratchDir(rig, "qa-hops-");
  const dirs: Dirs = { app: join(root, "app"), b: join(root, "b"), c: join(root, "c") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const indexed: string[] = [];
  const graph = chainGraph(dirs, indexed);
  const mirrors = { mirrorDir: async (repo: string) => (repo === APP ? dirs.app : repo === B ? dirs.b : dirs.c) };
  const runner: SandboxedBinaryRunner = { run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }) };
  const sha = changed === "c" ? C_SHA : APP_SHA;
  const changedFile = changed === "c" ? C_FILE : APP_CALL.file;
  const makeVcs = () => ({ blastRadius: async () => BlastRadius.of(sha, [changedFile]) });
  const real = new ChangeScopePortAdapter({ codeGraph: graph, budget: DEFAULT_WALK_POLICY, proofs: [fileImplementsPage, handlerServesOperation(() => false), crossRepoCallSite, openapiOperationDiff], loadMap: () => MAP });
  const scopes: ChangeScope[] = [];
  const changeScope: ChangeScopePort = { resolve: async (request) => { const scope = await real.resolve(request); scopes.push(scope); return scope; }, candidates: (request) => real.candidates(request) };
  rig.input =
    changed === "c"
      ? { changeSet: ChangeSet.of("demo", [{ repo: C, role: "service", headSha: C_SHA }]), sha: C_SHA, triggerRepo: C }
      : { changeSet: ChangeSet.of("demo", [{ repo: APP, role: "primary", headSha: APP_SHA }]), sha: APP_SHA };
  rig.classify = async () => ({ action: "generate", reason: "x", diff: DIFF.replaceAll(C_FILE, changedFile), intent: { type: "feat", breaking: false, message: "m", changedFiles: [changedFile] } });
  rig.extra = {
    serviceLinks: { resolve: async () => ({ links: [...links], drift: [] }) },
    crossRepoImpact: new CrossRepoImpactPortAdapter({ mirrors, makeVcs, codeGraph: graph, runner }),
    changeScope,
    codeGraph: graph,
    codeGraphRepoDir: changed === "c" ? dirs.c : dirs.app,
    ...(changed === "c" ? { codeGraphPrimary: { repo: APP, repoDir: dirs.app, headSha: async () => APP_SHA.toString() } } : {}),
    codeGraphMirrors: new Map([[B, { repoDir: dirs.b, headSha: async () => "b222222" }]]),
  };
  return { dirs, indexed, scopes, rig };
}

const pageEntries = (scope: ChangeScope) => scope.reach.filter((r) => r.entry.kind === "page");

test("a change in service C reaches the app's page through the unchanged service B: the chain is the evidence and both links are counted", { todo: "RFC-0011 U4: the walk follows the chain" }, async () => {
  const w = world([appToB, bToC], "c");
  try {
    const observed = await observe(w.rig, "hops-upstream");
    assert.equal(observed.result?.decision.verdict, "pass");
    const pages = pageEntries(w.scopes[0]!);
    assert.deepEqual(pages.map((r) => [r.entry.kind === "page" && r.entry.route, r.tier, r.basis]), [["/orders", "cross-repo", "call-site"]]);
    assert.deepEqual(pages[0]!.evidence.slice(0, 2), [`${C}: GET /items`, `${B}: GET /orders`]);
    assert.deepEqual(w.scopes[0]!.degraded, []);
    assert.equal(observed.saved[0]?.gateSignals?.crossRepoImpactedCount, 2);
  } finally {
    dispose(w.rig);
  }
});

test("one hop only: a change in C with just the app's link to C reaches the page by that link alone", async () => {
  const appToC: ServiceLink = { ...appToB, to: { repo: C, file: "c/api.yaml", symbol: "list" }, operation: { verb: "GET", path: "/items" } };
  const w = world([appToC], "c");
  try {
    const observed = await observe(w.rig, "hops-one");
    const pages = pageEntries(w.scopes[0]!);
    assert.deepEqual(pages.map((r) => r.entry.kind === "page" && r.entry.route), ["/orders"]);
    assert.deepEqual(pages[0]!.evidence[0], `${C}: GET /items`);
    assert.notEqual(pages[0]!.evidence[1], `${B}: GET /orders`);
    assert.equal(observed.saved[0]?.gateSignals?.crossRepoImpactedCount, 1);
    assert.deepEqual(w.indexed.sort(), [`${w.dirs.app}@${APP_SHA.toString()}`, `${w.dirs.c}@${C_SHA.toString()}`].sort());
  } finally {
    dispose(w.rig);
  }
});

test("a change in the app alone with only its link to a backend records no cross-repo impact, as before", async () => {
  const w = world([appToB], "app");
  try {
    const observed = await observe(w.rig, "hops-app-only");
    assert.equal(observed.saved[0]?.gateSignals?.crossRepoImpactedCount, undefined);
    assert.deepEqual(w.scopes[0]!.degraded, []);
  } finally {
    dispose(w.rig);
  }
});
