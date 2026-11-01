/* The task text of a flow author's brief states the time the flow's timer is armed with. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { authorTask } from "@contexts/coordination/application/author-task.ts";
import type { AdmittedFlow } from "@contexts/coordination/application/lead-plan.ts";

const flow = (budgetMs: number): AdmittedFlow => ({
  id: "cart",
  kind: "author",
  objective: "the cart lists the items",
  acceptance: [],
  routes: [],
  candidates: [],
  specFile: "flows/cart.spec.ts",
  writablePaths: ["e2e/flows/cart.spec.ts"],
  budgetMs,
  runSpecCalls: 0,
  runSpecDevWrites: 0,
  browserCalls: 0,
});

test("the task states the flow's budget, and a flow with another budget states another time", () => {
  const short = authorTask(flow(240_000), undefined, undefined, undefined);
  const long = authorTask(flow(480_000), undefined, undefined, undefined);
  assert.ok(short.includes("240 seconds"));
  assert.ok(long.includes("480 seconds"));
  assert.ok(!long.includes("240 seconds"));
});
