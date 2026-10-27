/* A run that delivers tests which fulfil a stated response records them apart from the live ones: the gate signal, a span, and the publication input carry them, and none of it changes the verdict. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PublicationPort } from "@contexts/workspace-and-publication/application/index.ts";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry.ts";
import type { SpanHandle, StartSpanOptions } from "@kernel/telemetry/telemetry.port.ts";
import { RIG_SPEC, dispose, newRig, observe, type Rig } from "./run-flow/run-end-rig.ts";

const LIVE = `import { test, expect } from "./fixtures";
test("lists the cuisines", async ({ page }) => { await page.goto("/restaurants"); await expect(page.getByRole("list")).toBeVisible(); });
`;

const STUBBED = `
test("[stubbed: geo response without the cuisine field] disables every chip", async ({ page }) => {
  await page.route("**/geo/**", (route) => (route.request().method() === "GET" ? route.fulfill({ json: { items: [] } }) : route.continue()));
  await page.goto("/restaurants");
  await expect(page.getByRole("button", { name: "Pizza" })).toBeDisabled();
});
`;

class SpanLog extends NoopTelemetry {
  readonly spans: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  override startSpan(name: string, opts?: StartSpanOptions): SpanHandle {
    const record = { name, attrs: { ...(opts?.attrs ?? {}) } };
    this.spans.push(record);
    return {
      setAttrs: (attrs) => { Object.assign(record.attrs, attrs); },
      addEvent: () => {},
      recordError: () => {},
      end: () => {},
      context: () => ({ traceId: "0".repeat(32), spanId: "0".repeat(16) }),
    };
  }
}

async function runWith(spec: string, setup: (rig: Rig) => void = () => {}) {
  const rig = newRig();
  try {
    const published: Array<Parameters<PublicationPort["publish"]>[0]> = [];
    const telemetry = new SpanLog();
    rig.ws.write(RIG_SPEC, spec);
    rig.execute = async () => ({ verdict: "pass", cases: [{ name: "a works", status: "pass", file: RIG_SPEC }], logs: "" });
    rig.publish = async (input) => { published.push(input); return { outcome: "pr" }; };
    rig.extra = { telemetry };
    setup(rig);
    const observed = await observe(rig, "stubbed-state");
    return { observed, published, telemetry };
  } finally {
    dispose(rig);
  }
}

test("a delivered stubbed test is recorded as a gate signal, a span and a publication input, and the verdict stays pass", async () => {
  const { observed, published, telemetry } = await runWith(`${LIVE}${STUBBED}`);
  assert.equal(observed.result?.decision.verdict, "pass");
  assert.equal(observed.result?.decision.sideEffect, "pr");
  const signal = observed.saved.at(-1)!.gateSignals.stubbedState;
  assert.equal(signal?.specFiles, 1);
  assert.equal(signal?.tests, 1);
  assert.equal(signal?.violations, undefined);
  assert.deepEqual(published[0]!.stubbedState?.tests.map((t) => t.response), ["geo response without the cuisine field"]);
  const span = telemetry.spans.find((s) => s.name === "qayaba.stubbed_state");
  assert.equal(span?.attrs["qayaba.stubbed.tests"], 1);
  assert.equal(span?.attrs["qayaba.stubbed.violations"], 0);
});

test("a broken guard is recorded with its kind and the file, and still decides nothing", async () => {
  const unguarded = `${LIVE}
test("fakes a write", async ({ page }) => {
  await page.route("**/orders", (route) => route.fulfill({ status: 201, json: {} }));
  await expect(page).toHaveURL("/");
});
`;
  const { observed, published } = await runWith(unguarded);
  assert.equal(observed.result?.decision.verdict, "pass");
  assert.deepEqual(observed.saved.at(-1)!.gateSignals.stubbedState?.violations, [{ file: RIG_SPEC, kind: "fulfil-without-get-guard" }]);
  assert.equal(published[0]!.stubbedState?.violations?.[0]?.test, "fakes a write");
});

test("a run whose specs are all live records no stubbed-state signal and publishes none", async () => {
  const { observed, published, telemetry } = await runWith(LIVE);
  assert.equal(observed.saved.at(-1)!.gateSignals.stubbedState, undefined);
  assert.equal(published[0]!.stubbedState, undefined);
  assert.equal(telemetry.spans.some((s) => s.name === "qayaba.stubbed_state"), false);
});
