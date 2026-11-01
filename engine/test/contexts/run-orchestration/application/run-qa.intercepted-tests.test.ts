/* A run that delivers a test which intercepts requests is a failing run whatever the report says: the engine refuses the test like a skipped one, and the author is told it as a failing case. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PublicationPort } from "@contexts/workspace-and-publication/application/index.ts";
import { RIG_SPEC, dispose, newRig, observe, type Rig } from "./run-flow/run-end-rig.ts";

const LIVE = `import { test, expect } from "./fixtures";
test("lists the cuisines", async ({ page }) => { await page.goto("/restaurants"); await expect(page.getByRole("list")).toBeVisible(); });
`;

const STUBBED = `
test("disables every chip", async ({ page }) => {
  await page.route("**/geo/**", (route) => route.fulfill({ json: { items: [] } }));
  await page.goto("/restaurants");
  await expect(page.getByRole("button", { name: "Pizza" })).toBeDisabled();
});
`;

async function runWith(spec: string, setup: (rig: Rig) => void = () => {}) {
  const rig = newRig();
  try {
    const published: Array<Parameters<PublicationPort["publish"]>[0]> = [];
    rig.ws.write(RIG_SPEC, spec);
    rig.execute = async () => ({
      verdict: "pass",
      cases: [
        { name: `${RIG_SPEC} › lists the cuisines`, status: "pass", file: RIG_SPEC },
        { name: `${RIG_SPEC} › disables every chip`, status: "pass", file: RIG_SPEC },
      ],
      logs: "",
    });
    rig.publish = async (input) => { published.push(input); return { outcome: "issue" }; };
    setup(rig);
    const observed = await observe(rig, "intercepted-tests");
    return { observed, published };
  } finally {
    dispose(rig);
  }
}

test("a delivered test that intercepts requests fails the run and opens an Issue naming it, even though the report says it passed", async () => {
  const { observed, published } = await runWith(`${LIVE}${STUBBED}`);
  assert.equal(observed.result?.decision.verdict, "fail");
  assert.equal(observed.result?.decision.sideEffect, "issue");
  const saved = observed.saved.at(-1)!;
  const refused = (saved.cases ?? []).filter((c) => c.refused === true);
  assert.deepEqual(refused.map((c) => c.name), [`${RIG_SPEC} › disables every chip`]);
  assert.match(refused[0]!.detail ?? "", /intercepts requests/);
  assert.match(published[0]!.cases.map((c) => c.detail ?? "").join("\n"), /intercepts requests/);
});

test("a run whose delivered specs read DEV only passes as before", async () => {
  const { observed } = await runWith(LIVE);
  assert.equal(observed.result?.decision.verdict, "pass");
  assert.equal((observed.saved.at(-1)!.cases ?? []).some((c) => c.refused === true), false);
});
