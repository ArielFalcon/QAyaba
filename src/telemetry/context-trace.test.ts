/* The grounding sources as context spans: what each supplied, as stable ids, under the phase that is open, over the real telemetry adapter. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TracedCrossRepoImpactPort,
  TracedCurriculumPort,
  TracedLearningPort,
  TracedServiceLinksPort,
  TracedStructuralSignalPort,
  telemetryGroundingTrace,
} from "../../qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/context-trace";
import { PreGenerationGroundingPortAdapter } from "../../qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/pre-generation-grounding-port.adapter";
import type { CrossRepoImpact, CurriculumPort, LearningPort, RetrievedRule, SelectedExemplar, ServiceLink, ServiceLinksPort, StructuralSignalPort } from "../../qa-engine/src/contexts/qa-run-orchestration/application/ports/index";
import { buildContextPack, type ContextPackDeps } from "@contexts/generation/infrastructure/context-pack";
import { createCaptureDomDeps } from "@contexts/generation/infrastructure/dom-snapshot";
import { domCaptureObserver } from "@contexts/generation/infrastructure/dom-capture-trace";
import { MAX_ITEM_IDS } from "@contexts/generation/domain/context-item-ids";
import { newSandboxReport, withExecScope, type RunScope } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-scope";
import { createRunSecretScope, withRunSecretScope } from "../../qa-engine/src/shared-infrastructure/run-secret-redaction";
import { testExecSandbox } from "../../qa-engine/test/support/exec-sandbox-harness";
import { Sha } from "@kernel/sha";
import { BlastRadius } from "@kernel/blast-radius";
import { ThrowingTelemetry } from "@kernel/telemetry/guarded-telemetry";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port";
import { traceHarness } from "./trace-harness";

const rule = (id: string): RetrievedRule => ({ id, trigger: `trigger ${id}`, action: `action ${id}`, errorClass: "selector", status: "active", confidence: "high" });

function inPhase<T>(h: ReturnType<typeof traceHarness>, fn: () => T): T {
  const phase = h.telemetry.startSpan("qayaba.phase.ground");
  const scope: RunScope = { runId: "r", workDir: "", egress: { dev: [], install: [] }, report: newSandboxReport(), telemetry: { parent: () => phase.context() } };
  try {
    return withExecScope(scope, fn);
  } finally {
    phase.end();
  }
}

function contextSpan(h: ReturnType<typeof traceHarness>, source: string) {
  return h.only(`qayaba.context.${source}`);
}

test("the learned rules a run was given are a span under the phase with their ids, count and size", async () => {
  const h = traceHarness();
  const inner: LearningPort = { fold: async () => {}, retrieve: async () => [rule("r-1"), rule("r-2")] };
  await inPhase(h, () => new TracedLearningPort(inner, h.telemetry).retrieve(Sha.of("abc1234")));
  const span = contextSpan(h, "learning");
  assert.equal(span.parentSpanContext?.spanId, h.only("qayaba.phase.ground").spanContext().spanId);
  assert.deepEqual(span.attributes["qayaba.context.item_ids"], ["rule:r-1", "rule:r-2"]);
  assert.equal(span.attributes["qayaba.context.items.count"], 2);
  assert.equal(span.attributes["qayaba.context.source"], "learning");
  assert.equal(span.attributes["qayaba.context.bytes"], Buffer.byteLength("trigger r-1action r-1trigger r-2action r-2"));
  assert.deepEqual(h.measurements.filter((m) => m.name === "qayaba.context.bytes").map((m) => m.attrs), [{ "qayaba.context.source": "learning" }]);
});

test("the same sources in two runs have the same ids", async () => {
  const idsOfRun = async (): Promise<unknown> => {
    const h = traceHarness();
    await inPhase(h, async () => {
      await new TracedLearningPort({ fold: async () => {}, retrieve: async () => [rule("r-9"), rule("r-3")] }, h.telemetry).retrieve(Sha.of("abc1234"));
      const exemplar: SelectedExemplar = { id: "form-submit", name: "form", template: "tpl", archetype: "form", proven: false, promotionCount: 0 };
      await new TracedCurriculumPort({ select: async () => [exemplar], fold: async () => {} }, h.telemetry).select("diff", ["a.ts"]);
    });
    return h.spans().filter((s) => s.name.startsWith("qayaba.context.")).map((s) => [s.name, s.attributes["qayaba.context.item_ids"]]);
  };
  assert.deepEqual(await idsOfRun(), await idsOfRun());
  assert.deepEqual((await idsOfRun()) as unknown[], [
    ["qayaba.context.learning", ["rule:r-9", "rule:r-3"]],
    ["qayaba.context.curriculum", ["exemplar:form-submit"]],
  ]);
});

test("a source with more items than a span carries keeps the first 200 ids and counts the rest", async () => {
  const h = traceHarness();
  const many = Array.from({ length: MAX_ITEM_IDS + 50 }, (_, i) => rule(`r-${i}`));
  await inPhase(h, () => new TracedLearningPort({ fold: async () => {}, retrieve: async () => many }, h.telemetry).retrieve(Sha.of("abc1234")));
  const span = contextSpan(h, "learning");
  assert.equal((span.attributes["qayaba.context.item_ids"] as string[]).length, MAX_ITEM_IDS);
  assert.equal(span.attributes["qayaba.context.item_ids.overflow"], 50);
  assert.equal(span.attributes["qayaba.context.items.count"], MAX_ITEM_IDS + 50);
});

test("service links, the structural signal and the cross-repo impact each name what they supplied", async () => {
  const h = traceHarness();
  const link: ServiceLink = { from: { repo: "o/web", file: "a.ts", symbol: "call" }, to: { repo: "o/api", file: "b.ts", symbol: "handler" }, transport: "http", confidence: 0.9, source: "t" };
  const links: ServiceLinksPort = { resolve: async () => ({ links: [link], drift: [] }) };
  const signal: StructuralSignalPort = { render: async () => ({ text: "### Blast radius\n- a.ts (fn)\n- b.ts (g)\n", hasSymbols: true }) };
  const impact: CrossRepoImpact = { impactedLinks: [{ link, tier: "contract-file" }] };
  await inPhase(h, async () => {
    await new TracedServiceLinksPort(links, h.telemetry).resolve();
    await new TracedStructuralSignalPort(signal, h.telemetry).render("/repo", BlastRadius.of(Sha.of("abc1234"), []));
    await new TracedCrossRepoImpactPort({ resolve: async () => impact }, h.telemetry).resolve("o/api", "abc", [link]);
  });
  assert.deepEqual(contextSpan(h, "service-links").attributes["qayaba.context.item_ids"], ["svc-link:o/web/call→o/api/handler"]);
  assert.equal((contextSpan(h, "structural-signal").attributes["qayaba.context.item_ids"] as string[]).length, 2);
  assert.deepEqual(contextSpan(h, "cross-repo-impact").attributes["qayaba.context.item_ids"], ["impact:contract-file:o/web/call→o/api/handler"]);
});

test("a run's own secret inside an id is taken out of the exported span", async () => {
  const h = traceHarness();
  const secrets = createRunSecretScope();
  secrets.addAccountSecrets(["hunter2-secret-value"]);
  await withRunSecretScope(secrets, () => inPhase(h, () => new TracedLearningPort({ fold: async () => {}, retrieve: async () => [rule("hunter2-secret-value")] }, h.telemetry).retrieve(Sha.of("abc1234"))));
  assert.equal(JSON.stringify(contextSpan(h, "learning").attributes).includes("hunter2-secret-value"), false);
});

test("a port traced by a telemetry that throws returns what it returned, and an error of the port goes on", async () => {
  const broken = new ThrowingTelemetry();
  const rules = [rule("r-1")];
  assert.deepEqual(await new TracedLearningPort({ fold: async () => {}, retrieve: async () => rules }, broken).retrieve(Sha.of("abc1234")), rules);
  const curriculum: CurriculumPort = { select: async () => [], fold: async () => {} };
  assert.deepEqual(await new TracedCurriculumPort(curriculum, broken).select(undefined, []), []);
  const failing: StructuralSignalPort = { render: async () => { throw new Error("graph down"); } };
  await assert.rejects(new TracedStructuralSignalPort(failing, traceHarness().telemetry).render("/repo", BlastRadius.of(Sha.of("abc1234"), [])), /graph down/);
});

/* ---- the grounding adapter: context map, brief, route ranking and pack ---- */

const MAP = {
  builtAtSha: "abc1234",
  routes: [{ path: "/orders", implementationFiles: ["src/orders/list.ts"] }, { path: "/b" }],
  api: [{ operationId: "listOrders", method: "GET", path: "/api/orders" }],
  feBe: [{ route: "/orders", operationId: "listOrders", via: "ordersApi" }],
  flows: [{ id: "checkout", routes: ["/orders"] }],
};
const DIFF = [
  "diff --git a/src/orders/list.html b/src/orders/list.html",
  "--- a/src/orders/list.html",
  "+++ b/src/orders/list.html",
  "@@ -1,1 +1,2 @@",
  " <div>",
  '+<button data-testid="save-btn">Save</button>',
  "",
].join("\n");

function groundingFixture(telemetry: TelemetryPort, opts: { trace?: boolean } = {}) {
  const e2eDir = mkdtempSync(join(tmpdir(), "ground-trace-"));
  const packDeps: ContextPackDeps = {
    captureDomForRoutes: async (routes, input) => {
      input.onPages?.(routes.map((route) => ({ route, grounded: true, links: [], testIds: route === "/orders" ? ["save-btn", "other"] : [] })));
      return routes.map((route) => `route ${route}:\n  button: Save`).join("\n");
    },
    domDeps: { render: async () => [] },
    log: () => {},
  };
  const adapter = new PreGenerationGroundingPortAdapter(
    { e2eDir, baseUrl: "https://dev.example.com", contextMap: MAP as never, prChangedFiles: ["src/orders/list.ts"], mirrorDir: e2eDir },
    {
      loadContextMap: () => MAP as never,
      contextPackDeps: packDeps,
      buildContextPack,
      exploreBrief: async () => ({ builtForSha: "abc1234", objective: "o", blastRadius: [{ symbol: "fn", file: "a.ts", role: "route" }], risks: ["Stale cache"], feBe: [{ route: "/orders", operationId: "listOrders" }] }),
      ...(opts.trace === false ? {} : { trace: telemetryGroundingTrace(telemetry) }),
    },
  );
  return { adapter, e2eDir, dispose: () => rmSync(e2eDir, { recursive: true, force: true }) };
}

test("grounding names the context map, the brief, the route ranking and the pack by their items", async () => {
  const h = traceHarness();
  const g = groundingFixture(h.telemetry);
  try {
    mkdirSync(join(g.e2eDir, "flows"), { recursive: true });
    await inPhase(h, () => g.adapter.ground(g.e2eDir, undefined, DIFF, { sha: "abc1234", runId: "r" }));
    assert.deepEqual(contextSpan(h, "context-map").attributes["qayaba.context.item_ids"], ["route:/orders", "route:/b", "op:listOrders", "link:/orders→listOrders", "flow:checkout"]);
    const brief = contextSpan(h, "explorer-brief").attributes["qayaba.context.item_ids"] as string[];
    assert.equal(brief.length, 3);
    assert.ok(brief.every((id) => /^brief:[a-z-]+:[0-9a-f]{8}$/.test(id)));
    assert.deepEqual(contextSpan(h, "route-ranking").attributes["qayaba.context.item_ids"], ["route:/orders", "route:/b"]);
    const pack = contextSpan(h, "context-pack");
    assert.deepEqual(pack.attributes["qayaba.context.item_ids"], ["fact:/orders#save-btn:present", "op:listOrders"]);
    assert.ok((pack.attributes["qayaba.context.bytes"] as number) > 0);
    for (const source of ["context-map", "explorer-brief", "route-ranking", "context-pack"]) {
      assert.equal(contextSpan(h, source).parentSpanContext?.spanId, h.only("qayaba.phase.ground").spanContext().spanId, source);
    }
  } finally {
    g.dispose();
  }
});

test("a test id the change added that no captured page shows is an absent fact", async () => {
  const h = traceHarness();
  const g = groundingFixture(h.telemetry);
  try {
    const gone = DIFF.replace("save-btn", "missing-btn");
    await inPhase(h, () => g.adapter.ground(g.e2eDir, undefined, gone, { sha: "abc1234", runId: "r" }));
    assert.deepEqual(contextSpan(h, "context-pack").attributes["qayaba.context.item_ids"], ["fact:*#missing-btn:absent", "op:listOrders"]);
  } finally {
    g.dispose();
  }
});

test("what grounding returns is the same with the trace, without it, and with a telemetry that throws", async () => {
  const outcomes: unknown[] = [];
  for (const telemetry of [traceHarness().telemetry, new ThrowingTelemetry()]) {
    const g = groundingFixture(telemetry);
    try {
      outcomes.push(await g.adapter.ground(g.e2eDir, undefined, DIFF, { sha: "abc1234", runId: "r" }));
    } finally {
      g.dispose();
    }
  }
  const plain = groundingFixture(traceHarness().telemetry, { trace: false });
  try {
    const untraced = await plain.adapter.ground(plain.e2eDir, undefined, DIFF, { sha: "abc1234", runId: "r" });
    for (const traced of outcomes) assert.deepEqual(traced, untraced);
  } finally {
    plain.dispose();
  }
});

/* ---- the DOM capture ---- */

async function withStandInNode<T>(script: string, body: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "stand-in-node-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(root, "capture.cjs"), script);
  writeFileSync(join(bin, "node"), `#!/bin/sh\nexec "${process.execPath}" "${join(root, "capture.cjs")}" "$@"\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    return await body(root);
  } finally {
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
}

const CAPTURE_OUTPUT = [
  {
    route: "/home",
    yaml: '- button "Save"\n- link "Help"',
    rawAttrs: [{ key: "button: Save", testId: "save-btn" }],
    testIdRawList: ["save-btn"],
    testIdAttr: "data-testid",
    settled: true,
  },
];

/* A run scope that can start the stand-in child, with the open phase as the parent of what it makes. */
async function inCaptureScope<T>(h: ReturnType<typeof traceHarness>, fn: () => Promise<T>): Promise<T> {
  const sandbox = testExecSandbox();
  const phase = h.telemetry.startSpan("qayaba.phase.ground");
  sandbox.scope.telemetry = { parent: () => phase.context() };
  try {
    return await withExecScope(sandbox.scope, fn);
  } finally {
    phase.end();
    sandbox.dispose();
  }
}

test("a DOM capture is a context span whose ids are test ids, and roles with a hash of the name for elements without one", { timeout: 30_000 }, async () => {
  const h = traceHarness();
  await withStandInNode(`process.stdout.write(${JSON.stringify(JSON.stringify(CAPTURE_OUTPUT))});`, async (root) => {
    const sandbox = testExecSandbox();
    try {
      const deps = createCaptureDomDeps(sandbox.exec, undefined, domCaptureObserver(h.telemetry));
      const snaps = await inCaptureScope(h, () => deps.render(root, "http://localhost", ["/home"]));
      assert.equal(snaps.length, 1);
      const span = contextSpan(h, "dom-capture");
      const ids = span.attributes["qayaba.context.item_ids"] as string[];
      assert.equal(ids[0], "dom:/home#save-btn");
      assert.match(ids[1]!, /^dom:\/home#role:link:[0-9a-f]{8}$/);
      assert.equal(span.parentSpanContext?.spanId, h.only("qayaba.phase.ground").spanContext().spanId);
      assert.ok((span.attributes["qayaba.context.bytes"] as number) > 0);
    } finally {
      sandbox.dispose();
    }
  });
});

test("each route of a capture is an event with its state, what it showed and how long the script took", { timeout: 30_000 }, async () => {
  const h = traceHarness();
  const output = [
    { ...CAPTURE_OUTPUT[0], ms: 1234, runtimeErrors: [{ type: "console", text: "boom" }] },
    { route: "/gone", error: "net::ERR_ABORTED", ms: 15, runtimeErrors: [] },
    { route: "/old", yaml: '- heading "Sign in"', finalUrl: "http://localhost/login", testIdRawList: [], settled: false, ms: 77 },
    { route: "/empty", yaml: "", ms: 5 },
    { route: "/no-time", yaml: '- link "x"', ms: "soon" },
  ];
  await withStandInNode(`process.stdout.write(${JSON.stringify(JSON.stringify(output))});`, async (root) => {
    const sandbox = testExecSandbox();
    try {
      await inCaptureScope(h, () => createCaptureDomDeps(sandbox.exec, undefined, domCaptureObserver(h.telemetry)).render(root, "http://localhost", ["/home", "/gone", "/old", "/empty", "/no-time"]));
    } finally {
      sandbox.dispose();
    }
  });
  const events = contextSpan(h, "dom-capture").events.filter((e) => e.name === "route").map((e) => e.attributes ?? {});
  assert.equal(events.length, 5);
  assert.deepEqual(events[0], { "qayaba.route.path": "/home", "qayaba.route.status": "captured", "qayaba.route.settled": true, "qayaba.route.nodes": 2, "qayaba.route.test_ids": 1, "qayaba.route.runtime_errors": 1, "qayaba.route.ms": 1234 });
  assert.deepEqual(events[1], { "qayaba.route.path": "/gone", "qayaba.route.status": "degraded", "qayaba.route.degrade_reason": "capture-failed", "qayaba.route.settled": false, "qayaba.route.nodes": 0, "qayaba.route.test_ids": 0, "qayaba.route.runtime_errors": 0, "qayaba.route.ms": 15 });
  assert.equal(events[2]!["qayaba.route.degrade_reason"], "redirected");
  assert.equal(events[2]!["qayaba.route.settled"], false);
  assert.equal(events[3]!["qayaba.route.degrade_reason"], "empty-render");
  assert.equal("qayaba.route.ms" in events[4]!, false);
});

test("a DOM capture returns the same snapshots with and without the observer, and with one that throws", { timeout: 30_000 }, async () => {
  const h = traceHarness();
  await withStandInNode(`process.stdout.write(${JSON.stringify(JSON.stringify(CAPTURE_OUTPUT))});`, async (root) => {
    const sandbox = testExecSandbox();
    try {
      const run = (observer?: Parameters<typeof createCaptureDomDeps>[2]) => inCaptureScope(h, () => createCaptureDomDeps(sandbox.exec, undefined, observer).render(root, "http://localhost", ["/home"]));
      const plain = await run();
      const observed = await run(() => { throw new Error("observer exploded"); });
      const traced = await run(domCaptureObserver(new ThrowingTelemetry()));
      assert.deepEqual(observed, plain);
      assert.deepEqual(traced, plain);
    } finally {
      sandbox.dispose();
    }
  });
});
