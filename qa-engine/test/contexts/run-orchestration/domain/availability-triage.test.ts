/* The fix loop reads a failure that ended where its route sends the run's client against the route's availability fact: the fact's class decides, never a re-read. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FixLoop, type FixLoopExecuteInput, type FixLoopGenerateInput, type FixLoopInput } from "@contexts/run-orchestration/domain/fix-loop.aggregate.ts";
import { routesOpenedBy } from "@contexts/run-orchestration/domain/availability-triage.ts";
import type { RouteAvailabilityFact, AvailabilityBasis } from "@kernel/route-availability.ts";
import { CycleBudget } from "@kernel/cycle-budget.ts";
import { WallClockBudget } from "@kernel/wall-clock-budget.ts";
import type { QaCase } from "@kernel/qa-case.ts";

const SPEC = `test("upload", async ({ page }) => {\n  await page.goto("/upload-menu/preview?x=1");\n  await expect(page.getByRole("heading", { name: "Preview" })).toBeVisible();\n});\n`;
const FAULT = "expect(locator).toBeVisible() failed\n\nLocator: getByRole('heading', { name: 'Preview' })\nError: element(s) not found";

const fact = (basis: AvailabilityBasis, route = "/upload-menu/preview"): RouteAvailabilityFact => ({ route, outcome: { kind: "redirected", to: "/home", mechanism: "client" }, sessionAttached: true, basis });
const failing = (over: Partial<QaCase> = {}): QaCase => ({ name: "upload", status: "fail", file: "flows/upload.spec.ts", detail: FAULT, finalUrl: "https://dev.example/home", ...over });

function harness() {
  const rec = { executes: [] as FixLoopExecuteInput[], generates: [] as FixLoopGenerateInput[] };
  const loop = new FixLoop({
    execution: {
      execute: async (i) => {
        rec.executes.push(i);
        return { verdict: "fail", cases: [failing()] };
      },
    },
    regeneration: {
      regenerate: async (i) => {
        rec.generates.push(i);
        return { specs: [] };
      },
    },
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set<string>(), anyVerifiedPresent: false, anyNonExtractable: false, anyUnverifiable: false }) },
  });
  return { loop, rec };
}

function input(facts: readonly RouteAvailabilityFact[], cases: QaCase[] = [failing()]): FixLoopInput {
  const cycleBudget = CycleBudget.derive({ maxRetries: 1 });
  const wallClockBudget = WallClockBudget.derive({ cycleBudget, agentTimeoutMs: 60_000 });
  return {
    initialRun: { verdict: "fail", cases },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/app.routes.ts"],
    maxRetries: 1,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "run",
    routeAvailability: { facts, specOpens: async (file) => (file === "flows/upload.spec.ts" ? routesOpenedBy(SPEC) : []) },
  };
}

test("a failure on a route this change sends away is a test to correct: the regeneration is told where the route ends and why, with no re-read", async () => {
  const { loop, rec } = harness();
  const result = await loop.run(input([fact({ class: "change-introduced", via: "route-guard", at: "src/app.routes.ts:102" })]));
  assert.equal(rec.executes.length, 0);
  assert.equal(rec.generates.length, 1);
  const detail = rec.generates[0]!.fixCases[0]!.detail ?? "";
  assert.ok(detail.startsWith(FAULT));
  assert.ok(detail.includes("/upload-menu/preview") && detail.includes("/home") && detail.includes("src/app.routes.ts:102"));
  assert.deepEqual(result.triage, { trigger: "availability", outcome: "corrected", files: 1 });
  assert.equal(result.preconditionFailed, false);
});

test("a failure on a route this change did not cause is corrected the same way, and says the change did not cause it", async () => {
  const { loop, rec } = harness();
  await loop.run(input([fact({ class: "pre-existing", why: "unchanged", at: "src/app.routes.ts:8" })]));
  assert.match(rec.generates[0]!.fixCases[0]!.detail ?? "", /not caused by this change/);
});

test("every failure on a route the environment sends away ends the run as a precondition, with no repair and no re-read", async () => {
  const { loop, rec } = harness();
  const result = await loop.run(input([fact({ class: "environment", why: "login-without-session" })]));
  assert.deepEqual([rec.executes.length, rec.generates.length], [0, 0]);
  assert.equal(result.run.verdict, "infra-error");
  assert.equal(result.preconditionFailed, true);
  assert.equal(result.lastAdjudicatorVerdict?.class, "dev_not_rendered");
  assert.deepEqual(result.triage, { trigger: "availability", outcome: "precondition", files: 1 });
});

test("a failure on a route the change governs that also raised a runtime error goes to a human, never repaired, never called a defect found", async () => {
  const { loop, rec } = harness();
  const result = await loop.run(input([fact({ class: "regression-candidate", reach: "governs", runtimeError: true })]));
  assert.equal(rec.generates.length, 0);
  assert.equal(result.lastAdjudicatorVerdict?.action, "break-needs-human");
  assert.equal(result.realBugDetected, false);
  assert.equal(result.preconditionFailed, false);
});

test("an unexplained fact, a failure elsewhere than where the route ends, or a spec that never opens the route leaves the loop as it was", async () => {
  for (const [facts, cases] of [
    [[fact({ class: "unexplained", missing: ["declaration"] })], [failing()]],
    [[fact({ class: "environment", why: "login-without-session" })], [failing({ finalUrl: "https://dev.example/upload-menu/preview" })]],
    [[fact({ class: "environment", why: "login-without-session" }, "/orders")], [failing()]],
  ] as const) {
    const { loop, rec } = harness();
    const result = await loop.run(input(facts, [...cases]));
    assert.equal(rec.generates.length, 1, "the repair is asked for as before");
    assert.equal(rec.generates[0]!.fixCases[0]!.detail, FAULT);
    assert.equal(result.triage, undefined);
    assert.equal(result.preconditionFailed, false);
  }
});

test("a precondition needs every failure on an environment route: one failure elsewhere keeps the repair", async () => {
  const { loop, rec } = harness();
  const result = await loop.run(input([fact({ class: "environment", why: "data-missing" })], [failing(), failing({ name: "other", file: "flows/other.spec.ts" })]));
  assert.equal(rec.generates.length, 1);
  assert.equal(result.preconditionFailed, false);
});

test("a spec's opened routes are its goto pathnames, once each, without origin, query or trailing slash", () => {
  assert.deepEqual(routesOpenedBy(`await page.goto('https://dev.example/a/?q=1'); await page.goto("/a"); await page.goto(\`/b#x\`);`), ["/a", "/b"]);
});
