/* A passing case that checks a page only as DEV served it confirmed empty is a fact of the run: the reviewer may cite it, it is saved as a gate signal, recorded on a span and listed in the publication input, and none of it changes the verdict. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PublicationPort } from "@contexts/workspace-and-publication/application/index.ts";
import type { ReviewPort } from "@contexts/generation/application/index.ts";
import type { PageDataRead } from "@kernel/page-data-read.ts";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry.ts";
import type { SpanHandle, StartSpanOptions } from "@kernel/telemetry/telemetry.port.ts";
import { RIG_SPEC, dispose, newRig, observe } from "./run-flow/run-end-rig.ts";

const PAGE = "/listing";
const TITLE = "renders the empty listing";

const AS_LOADED = `import { test, expect } from "./fixtures";
test("${TITLE}", async ({ page }) => {
  await page.goto("${PAGE}");
  await expect(page.getByText("Nothing here yet")).toBeVisible();
});
`;

const AFTER_A_STEP = `import { test, expect } from "./fixtures";
test("${TITLE}", async ({ page }) => {
  await page.goto("${PAGE}");
  await page.getByRole("button", { name: "Only open now" }).click();
  await expect(page.getByText("Nothing here yet")).toBeVisible();
});
`;

const EMPTY_READ: PageDataRead = { scope: PAGE, grounded: true, dataState: true, unconfirmed: false, resultCount: 0, emptyConfirmed: true };

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

async function run(spec: string, reads: PageDataRead[] = [EMPTY_READ], packConfirmedDataRoutes?: Array<{ path: string; resultCount: number }>) {
  const rig = newRig();
  try {
    const published: Array<Parameters<PublicationPort["publish"]>[0]> = [];
    let enrichment: Parameters<ReviewPort["review"]>[3];
    const telemetry = new SpanLog();
    rig.ws.write(RIG_SPEC, spec);
    rig.extra = { telemetry, preGenerationGrounding: { ground: async () => ({ pageReads: reads, ...(packConfirmedDataRoutes ? { packConfirmedDataRoutes } : {}) }) } };
    rig.execute = async () => ({ verdict: "pass", cases: [{ name: `${RIG_SPEC} › ${TITLE}`, status: "pass", file: RIG_SPEC }], logs: "" });
    rig.review = async (...args) => {
      enrichment = args[3];
      return { approved: true, findings: [], blockingCount: 0, parsed: true };
    };
    rig.publish = async (input) => { published.push(input); return { outcome: "pr" }; };
    const observed = await observe(rig, "ambient-data-state");
    return { observed, published, enrichment, telemetry };
  } finally {
    dispose(rig);
  }
}

test("a passing case that asserts a confirmed empty page as it loaded reaches the reviewer, the saved gate signal, a span and the publication input, and the verdict stays pass", async () => {
  const { observed, published, enrichment, telemetry } = await run(AS_LOADED);
  assert.equal(observed.result?.decision.verdict, "pass");
  assert.equal(observed.result?.decision.sideEffect, "pr");
  assert.deepEqual(enrichment?.ambientDataPins?.map((p) => [p.file, p.test, p.pages]), [[RIG_SPEC, TITLE, [PAGE]]]);
  const signal = observed.saved.at(-1)!.gateSignals.ambientDataState;
  assert.equal(signal?.cases, 1);
  assert.deepEqual(signal?.pages, [PAGE]);
  assert.equal(signal?.arms, 0);
  assert.deepEqual(published[0]!.ambientDataState?.pins.map((p) => p.test), [TITLE]);
  const span = telemetry.spans.find((s) => s.name === "qayaba.ambient_data_state");
  assert.equal(span?.attrs["qayaba.ambient.cases"], 1);
});

test("an empty state the test produces, or a page the pack did not read empty, records no ambient signal and publishes none", async () => {
  for (const { observed, published, telemetry } of [await run(AFTER_A_STEP), await run(AS_LOADED, [{ ...EMPTY_READ, resultCount: 4, emptyConfirmed: undefined }])]) {
    assert.equal(observed.result?.decision.verdict, "pass");
    assert.equal(observed.saved.at(-1)!.gateSignals.ambientDataState, undefined);
    assert.equal(published[0]!.ambientDataState, undefined);
    assert.equal(telemetry.spans.some((s) => s.name === "qayaba.ambient_data_state"), false);
  }
});

test("the branch-cases regeneration carries the pinned case to its spec's author and names its page beside the arm DEV's data never took", async () => {
  const rig = newRig();
  try {
    const turns: string[] = [];
    const author = rig.author;
    rig.ws.write(RIG_SPEC, AS_LOADED);
    rig.extra = { preGenerationGrounding: { ground: async () => ({ pageReads: [EMPTY_READ] }) } };
    rig.config = { needsReview: false, coveragePolicyMode: "signal", coverageBranchCases: "regenerate" };
    rig.author = async (...args) => { turns.push(JSON.stringify(args)); return author(...args); };
    rig.execute = async () => ({ verdict: "pass", cases: [{ name: `${RIG_SPEC} › ${TITLE}`, status: "pass", file: RIG_SPEC }], logs: "" });
    rig.measure = async () => ({ status: "pass", ratio: 0.9, uncovered: [], untakenArms: [{ file: "src/listing.ts", line: 3, column: 0, kind: "if", arm: "then" }], measurement: { changedLines: 10, coveredChanged: 9, changedFiles: 1, mappedFiles: 1, changedBranches: 2, takenBranches: 1 } });
    await observe(rig, "ambient-gap");
    const regeneration = turns.find((turn) => turn.includes("src/listing.ts:3"));
    assert.ok(regeneration, "the arm reaches a regeneration");
    assert.ok(regeneration.includes(TITLE) && regeneration.includes(PAGE), "the pinned case and its page reach the same regeneration");
  } finally {
    dispose(rig);
  }
});

const COUNTED = `import { test, expect } from "./fixtures";
test("${TITLE}", async ({ page }) => {
  await page.goto("${PAGE}");
  await expect(page.getByText("4 resultados")).toBeVisible();
});
`;

test("a passing case that asserts the result count the pack read on a page as it loaded reaches the reviewer, the gate signal and the publication input, and the verdict stays pass", async () => {
  const { observed, published, enrichment } = await run(COUNTED, [{ ...EMPTY_READ, resultCount: 4, emptyConfirmed: undefined }], [{ path: PAGE, resultCount: 4 }]);
  assert.equal(observed.result?.decision.verdict, "pass");
  assert.deepEqual(enrichment?.ambientDataPins?.map((p) => [p.test, p.pages, p.counts]), [[TITLE, [], [{ page: PAGE, count: 4 }]]]);
  assert.deepEqual(observed.saved.at(-1)!.gateSignals.ambientDataState?.pages, [PAGE]);
  assert.deepEqual(published[0]!.ambientDataState?.pins.map((p) => p.counts), [[{ page: PAGE, count: 4 }]]);
});

test("the same assertion on a page the pack read no count for pins nothing", async () => {
  const { observed, published } = await run(COUNTED, [{ ...EMPTY_READ, resultCount: 4, emptyConfirmed: undefined }]);
  assert.equal(observed.saved.at(-1)!.gateSignals.ambientDataState, undefined);
  assert.equal(published[0]!.ambientDataState, undefined);
});
