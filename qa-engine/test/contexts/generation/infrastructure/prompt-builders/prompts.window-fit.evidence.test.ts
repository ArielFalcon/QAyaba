/*
 * The runtime evidence and the cross-service facts a prompt carries reach it whole, however many, while the prompt fits its role's
 * window; over it they give way in steps that say what they leave out. A bound that remains protects the prompt from text the
 * orchestrator does not control, and says so when it bites.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptAssembled, buildReviewerPromptAssembled } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { renderExecutionResult } from "@contexts/generation/infrastructure/prompt-builders/review-render.ts";
import { EVIDENCE_SAFETY_BOUND_REASON, EVIDENCE_TEXT_SAFETY_BOUND } from "@contexts/generation/infrastructure/prompt-cap.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import { promptFactsOpts, type ReviewInput } from "@contexts/generation/application/index.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { itemId } from "@kernel/context-item-ids.ts";
import { WINDOW_FIT_REASON } from "@kernel/prompt-sections.ts";
import type { PromptFit } from "@contexts/generation/infrastructure/prompt-builders/generator-context.ts";
import { buildContextPack } from "@contexts/generation/infrastructure/context-pack.ts";
import type { ArchitectureContext } from "@contexts/generation/domain/generation-input.ts";
import type { CaptureDomDeps } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import { packDeliveredItemIds, type ContextPackDeps } from "@contexts/generation/infrastructure/context-pack.ts";

const windowOf = (bytes: number): PromptFit => ({ bytes: size }) => (size <= bytes ? "fits" : "over");
const roomy = windowOf(10_000_000);
const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

function mkInput(overrides: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/app",
    sha: "abc1234",
    diff: "diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() {}\n",
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234",
    target: "e2e",
    mode: "diff",
    appName: "testapp",
    baseUrl: "http://localhost:3000",
    ...overrides,
  };
}

/* The size of one section of an assembled prompt. */
const sizeOf = (assembled: { sectionSizes: Record<string, number> }, id: string): number => assembled.sectionSizes[id] ?? 0;

/* ------------------------------------------------------------------ cross-service links and drift */

const links = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    from: { repo: "org/front", file: "src/api.ts", symbol: `sym${i}` },
    to: { repo: "org/orders", file: "src/routes.ts", symbol: `route${i}` },
    transport: "http" as const,
    confidence: 0.5,
    source: "openapi",
  }));
const drift = (count: number) => Array.from({ length: count }, (_, i) => ({ from: { repo: "org/front", file: "src/api.ts", symbol: `drift${i}` }, verb: "GET", path: `/path${i}` }));

test("every service link and every drift entry reaches the prompt, however many, and each link is an item", () => {
  for (const opts of [{}, { fit: roomy }]) {
    const assembled = buildPromptAssembled(mkInput({ serviceLinks: links(45), contractDrift: drift(25) }), opts);
    for (const i of [0, 39, 40, 44]) assert.ok(assembled.text.includes(`sym${i}\``), `link ${i}`);
    for (const i of [0, 19, 20, 24]) assert.ok(assembled.text.includes(`/path${i} `), `drift ${i}`);
    assert.equal(assembled.sectionItems["service-links"]?.itemIds.length, 45);
    assert.deepEqual(assembled.sectionItems["service-links"]?.omissions, []);
  }
});

test("service links over the author's window keep the links the change reaches, count the rest, then count them all, then count the drift", () => {
  const all = links(45);
  const impacted = all[44]!;
  const input = mkInput({ serviceLinks: all, contractDrift: drift(25), crossRepoImpact: { impactedLinks: [{ link: impacted, tier: "contract-file" }] } });
  const whole = buildPromptAssembled(input, { fit: roomy });
  const section = sizeOf(whole, "service-links");

  const impactedOnly = buildPromptAssembled(input, { fit: windowOf(bytesOf(whole.text) - section / 4) });
  assert.ok(impactedOnly.text.includes("sym44`"), "the link the change reaches stays whole");
  assert.equal(impactedOnly.text.includes("sym3`"), false, "the others gave way");
  assert.match(impactedOnly.text, /44 link\(s\) are not shown here, to fit the window/);
  assert.ok(impactedOnly.text.includes("/path24 "), "the drift is whole at this step");
  assert.deepEqual(impactedOnly.sectionItems["service-links"]?.itemIds, [itemId.svcLink(impacted)]);
  assert.deepEqual(impactedOnly.sectionItems["service-links"]?.omissions, [{ class: "truncation", reason: WINDOW_FIT_REASON, count: 44 }]);

  const counted = buildPromptAssembled(input, { fit: windowOf(bytesOf(whole.text) - section + 1_500) });
  assert.equal(counted.text.includes("sym44`"), false, "every link is counted");
  assert.match(counted.text, /45 link\(s\) are not shown here, to fit the window/);
  assert.deepEqual(counted.sectionItems["service-links"]?.itemIds, []);
});

/* ------------------------------------------------------------------ contract feedback */

const violation = (i: number, after = "total === 0") => ({ rule: "weakened-assertion", file: "e2e/flows/cart.spec.ts", clauseId: `assertion-${i}`, before: "total === 10", after });
const CORRECTIONS = ["[wrong-objective] assert the discount"];

test("every contract violation reaches the prompt, with its clause whole up to the safety bound", () => {
  const many = Array.from({ length: 20 }, (_, i) => violation(i));
  const text = buildPromptAssembled(mkInput({ reviewCorrections: CORRECTIONS, contractFeedback: many })).text;
  for (const v of many) assert.ok(text.includes(v.clauseId), v.clauseId);
  assert.doesNotMatch(text, /more not shown/);

  const longClause = "clause word ".repeat(130);
  const long = buildPromptAssembled(mkInput({ reviewCorrections: CORRECTIONS, contractFeedback: [violation(0, longClause)] })).text;
  assert.ok(long.includes(longClause), "a clause past the old 200 characters is whole");

  const huge = "clause word ".repeat(Math.ceil((EVIDENCE_TEXT_SAFETY_BOUND + 500) / 12));
  const bounded = buildPromptAssembled(mkInput({ reviewCorrections: CORRECTIONS, contractFeedback: [violation(0, huge)] }));
  assert.equal(bounded.text.includes(huge), false, "a clause past the safety bound is cut");
  assert.deepEqual(bounded.sectionItems["contract-feedback"]?.omissions, [{ class: "truncation", reason: EVIDENCE_SAFETY_BOUND_REASON, count: 1 }]);
});

test("contract violations over the window lose their before and after first, then are counted", () => {
  const many = Array.from({ length: 20 }, (_, i) => violation(i, `after-${i}-${"zed word ".repeat(50)}`));
  const input = mkInput({ reviewCorrections: CORRECTIONS, contractFeedback: many });
  const whole = buildPromptAssembled(input, { fit: roomy });
  const section = sizeOf(whole, "contract-feedback");

  const named = buildPromptAssembled(input, { fit: windowOf(bytesOf(whole.text) - section / 2) });
  assert.ok(named.text.includes("assertion-19"), "each violation is still named");
  assert.equal(named.text.includes("zed word zed word"), false, "what the contract held is not shown");
  assert.ok(named.sectionItems["contract-feedback"]?.omissions.some((o) => o.reason === WINDOW_FIT_REASON));

  const counted = buildPromptAssembled(input, { fit: windowOf(bytesOf(whole.text) - section + 300) });
  assert.equal(counted.text.includes("assertion-19"), false);
  assert.match(counted.text, /20 violation\(s\) are not shown here, to fit the window/);
});

/* ------------------------------------------------------------------ failing cases */

const failing = (over: Partial<QaCase> = {}): QaCase => ({
  name: "cart total",
  status: "fail",
  detail: `Error: expect(received).toBe(expected)\n${"detail line ".repeat(120)}`,
  networkErrors: Array.from({ length: 5 }, (_, i) => ({ url: `https://api.example.test/orders/${i}`, status: 500 })),
  runtimeErrors: Array.from({ length: 5 }, (_, i) => ({ type: "error", text: `Uncaught TypeError number ${i} ${"trace word ".repeat(25)}` })),
  ...over,
});

test("a failing case reaches the prompt with its whole error and every network and runtime error", () => {
  const c = failing();
  const text = buildPromptAssembled(mkInput({ fixCases: [c] })).text;
  assert.ok(text.includes(c.detail!), "the error is whole, past the old 500 characters");
  for (let i = 0; i < 5; i++) {
    assert.ok(text.includes(`orders/${i}`), `network error ${i}`);
    assert.ok(text.includes(`TypeError number ${i} ${"trace word ".repeat(25)}`), `runtime error ${i}, whole`);
  }
});

test("a failing case's text past the safety bound is cut, and the omission says so", () => {
  const huge = "hint word ".repeat(Math.ceil((EVIDENCE_TEXT_SAFETY_BOUND + 700) / 10));
  const assembled = buildPromptAssembled(mkInput({ fixCases: [failing({ detail: huge })] }));
  assert.equal(assembled.text.includes(huge), false);
  assert.ok(assembled.sectionItems["fix-cases"]?.omissions.some((o) => o.reason === EVIDENCE_SAFETY_BOUND_REASON && o.count === 1));
});

test("failing cases over the window lose their evidence lines first, then all but the first line of the error, and keep their names", () => {
  const cases = Array.from({ length: 6 }, (_, i) => failing({ name: `cart total ${i}` }));
  const input = mkInput({ fixCases: cases });
  const whole = buildPromptAssembled(input, { fit: roomy });
  const section = sizeOf(whole, "fix-cases");

  const noEvidence = buildPromptAssembled(input, { fit: windowOf(bytesOf(whole.text) - section / 10) });
  assert.equal(noEvidence.text.includes("TypeError number 0"), false, "the evidence lines gave way");
  assert.ok(noEvidence.text.includes("detail line detail line"), "the error is still whole");

  const firstLine = buildPromptAssembled(input, { fit: windowOf(bytesOf(noEvidence.text) - 500) });
  assert.equal(firstLine.text.includes("detail line detail line"), false);
  assert.ok(firstLine.text.includes("Error: expect(received).toBe(expected)"));
  for (let i = 0; i < 6; i++) assert.ok(firstLine.text.includes(`cart total ${i}`), "every case is still named");
  assert.ok(firstLine.sectionItems["fix-cases"]?.omissions.some((o) => o.reason === WINDOW_FIT_REASON));
});

/* ------------------------------------------------------------------ the reviewer's execution result */

const review = (executionResult: string): ReviewInput => ({
  diff: "diff --git a/src/cart.ts b/src/cart.ts\n+export function total() {}\n",
  specs: [],
  mirrorDir: "/mirrors/org__app",
  e2eRelDir: "e2e",
  appName: "shop",
  mode: "diff",
  target: "e2e",
  executionResult,
});
const executed = (count: number, detail: string) =>
  renderExecutionResult({ verdict: "fail", cases: Array.from({ length: count }, (_, i) => ({ name: `case ${i}`, httpStatus: 500, finalUrl: `https://dev.example.test/p${i}`, detail })) });

test("the execution result lists every case with its whole detail, up to the safety bound", () => {
  const detail = "detail word ".repeat(110);
  const text = executed(40, detail);
  assert.ok(text.includes("case 39"), "no total cap");
  assert.equal(text.split(detail).length - 1, 40, "the detail is whole, past the old 500 characters");

  const huge = "query word ".repeat(Math.ceil((EVIDENCE_TEXT_SAFETY_BOUND + 900) / 11));
  assert.equal(executed(1, huge).includes(huge), false, "a detail past the safety bound is cut");
});

test("an execution result over the reviewer's window loses its details first, then its urls, keeping each case and its status", () => {
  const result = executed(40, "detail word ".repeat(110));
  const whole = buildReviewerPromptAssembled(review(result), { fit: roomy });
  const section = sizeOf(whole, "reviewer-execution-result");

  const noDetail = buildReviewerPromptAssembled(review(result), { fit: windowOf(bytesOf(whole.text) - section / 2) });
  assert.equal(noDetail.text.includes("detail word detail word"), false, "the details gave way");
  assert.ok(noDetail.text.includes("case 39") && noDetail.text.includes("httpStatus: 500"), "each case keeps its name and status");
  assert.ok(noDetail.sectionItems["reviewer-execution-result"]?.omissions.some((o) => o.reason === WINDOW_FIT_REASON));
});

/* ------------------------------------------------------------------ the Context Pack's contracts */

function stubContextPackDeps(domResult: string): ContextPackDeps {
  const domDeps: CaptureDomDeps = { render: async () => [{ route: "/test", nodes: domResult.split("\n").filter(Boolean) }] };
  return { captureDomForRoutes: async () => domResult, domDeps, log: () => {} };
}

const MAP_WITH_MANY_OPS: ArchitectureContext = {
  builtAtSha: "abc1234",
  routes: [{ path: "/checkout" }],
  api: Array.from({ length: 60 }, (_, i) => ({ operationId: `op${i}`, method: "GET", path: `/orders/${i}` })),
  feBe: Array.from({ length: 60 }, (_, i) => ({ route: "/checkout", operationId: `op${i}`, via: "OrderClient.create" })),
};

test("the Context Pack carries every relevant API contract, however many", async () => {
  const result = await buildContextPack(
    { contextMap: MAP_WITH_MANY_OPS, prChangedFiles: ["src/checkout/order-client.ts"], baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    stubContextPackDeps("button: Submit"),
  );
  for (const i of [0, 49, 50, 59]) assert.ok((result.text ?? "").includes(`\`op${i}\``), `op${i}`);
});

test("contracts over the author's window give way last-listed first, after the pages and the availability facts, and are counted", async () => {
  const result = await buildContextPack(
    { contextMap: MAP_WITH_MANY_OPS, prChangedFiles: ["src/checkout/order-client.ts"], baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    stubContextPackDeps("button: Submit"),
  );
  const input = mkInput({ contextPack: result.text, contextPackItemIds: packDeliveredItemIds(result).ids });
  const whole = buildPromptAssembled(input, { fit: roomy });
  const prompt = buildPromptAssembled(input, { fit: windowOf(bytesOf(whole.text) - 600) });
  assert.ok(prompt.text.includes("`op0`"), "the first-listed contract stays");
  assert.equal(prompt.text.includes("`op59`"), false, "the last-listed contract gave way");
  assert.match(prompt.text, /\(\d+ more contract\(s\) are not shown here, to fit the window\)/);
  assert.equal(prompt.sectionItems["context-pack"]?.itemIds.includes(itemId.op("op59")), false);
  assert.ok(prompt.sectionItems["context-pack"]?.omissions.some((o) => o.reason === WINDOW_FIT_REASON));
});

/* ------------------------------------------------------------------ the turn span's count of degraded sections */

test("a prompt's facts count the sections the window fit rule gave a smaller render, and none when no window was applied", () => {
  const input = mkInput({ serviceLinks: links(45), contractDrift: drift(25) });
  const whole = buildPromptAssembled(input, { fit: roomy });
  assert.equal(promptFactsOpts(whole).sectionsDegraded, 0, "a window that holds the prompt degrades nothing");
  const degraded = buildPromptAssembled(input, { fit: windowOf(bytesOf(whole.text) - sizeOf(whole, "service-links") / 2) });
  assert.equal(promptFactsOpts(degraded).sectionsDegraded, degraded.windowFit?.degraded.length);
  assert.ok((promptFactsOpts(degraded).sectionsDegraded ?? 0) >= 1);
  assert.equal("sectionsDegraded" in promptFactsOpts(buildPromptAssembled(input)), false, "no window, no count");
});
