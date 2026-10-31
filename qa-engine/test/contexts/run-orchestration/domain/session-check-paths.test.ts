/* The pages a check of the session opens are those the failing tests asked for, as written: a templated or parameterised route names no page. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionCheckPaths } from "@contexts/run-orchestration/domain/session-check-paths.ts";

test("each literal page a spec opens, once, in the order the specs open them", () => {
  const a = 'await page.goto("/orders");\nawait page.goto(`/shops/${id}`);\nawait page.goto("/orders?tab=2");';
  const b = "await page.goto('/map');\nawait page.goto('/users/:id');";
  assert.deepEqual(sessionCheckPaths([a, b]), ["/orders", "/map"]);
});

test("a spec that opens no page gives none", () => {
  assert.deepEqual(sessionCheckPaths(["test('x', async () => {});"]), []);
});
