/*
 * No fixed line or character count cuts a flow author's brief: the suite listing and the pages of its flow are whole while the brief
 * fits the author's window, and over it give way as references (the suite by file, then by directory; the pages one at a time, the
 * last first). The executor renders the brief with the fit rule the lead measured it by.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDelegationBrief } from "@contexts/coordination/application/delegation-brief.ts";
import { assembleSidekickBrief, renderSidekickBrief } from "@contexts/coordination/application/sidekick-prompt.ts";
import { SidekickExecutor } from "@contexts/coordination/application/sidekick-executor.ts";
import { PACK_HEADINGS } from "@contexts/generation/application/index.ts";
import { WINDOW_FIT_REASON, type WindowFitOutcome } from "@kernel/prompt-sections.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const redaction = new PatternRedactionAdapter();
const windowOf = (bytes: number) => (size: number): WindowFitOutcome => (size <= bytes ? "fits" : "over");
const roomy = windowOf(10_000_000);
const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");
const base = { redaction, delegationId: "d1", runId: "r1", objective: "o", task: "t", scope: { readablePaths: ["."], writablePaths: [], allowedCommands: [] } };

/* More lines than the 30 a brief used to list, each longer than the 300 characters it used to keep. */
const SUITE = Array.from({ length: 80 }, (_, i) => `flows/area-${i % 4}/flow-${i}.spec.ts — flow: area-${i}, objective: ${"checks that the page behaves as the change says it must ".repeat(8)}end-${i}`);

test("the suite listing reaches the brief whole, however many specs and however long, while the window is unknown or holds it", () => {
  const brief = createDelegationBrief({ ...base, suite: SUITE });
  for (const text of [renderSidekickBrief(redaction, brief).text, assembleSidekickBrief(redaction, brief, roomy).text]) {
    for (let i = 0; i < SUITE.length; i++) assert.ok(text.includes(`end-${i}`), `spec ${i}`);
    assert.doesNotMatch(text, /\(\+\d+ more\)/);
  }
});

test("the suite listing over the author's window names the specs by file first, then counts them by directory, and records it", () => {
  const brief = createDelegationBrief({ ...base, suite: SUITE });
  const whole = assembleSidekickBrief(redaction, brief, roomy);
  const section = whole.sectionSizes["suite"]!;

  const files = assembleSidekickBrief(redaction, brief, windowOf(bytesOf(whole.text) - section / 2));
  assert.ok(files.text.includes("flows/area-3/flow-79.spec.ts"), "each spec is still named");
  assert.equal(files.text.includes("end-79"), false, "what each checks is not shown");
  assert.deepEqual(files.sectionItems["suite"]?.omissions, [{ class: "truncation", reason: WINDOW_FIT_REASON, count: SUITE.length }]);

  const counted = assembleSidekickBrief(redaction, brief, windowOf(bytesOf(whole.text) - section + 300));
  assert.match(counted.text, /flows\/area-0\/: 20 file\(s\)/);
  assert.equal(counted.text.includes("flow-79.spec.ts"), false);
});

const page = (route: string, count: number): string[] => [`route ${route}:`, ...Array.from({ length: count }, (_, i) => `  button: ${route.slice(1)} action ${i}`)];
const PAGES = [`### ${PACK_HEADINGS.liveDom} (a11y tree — GROUND TRUTH for selectors)`, ...page("/cart", 300), ...page("/checkout", 300)].join("\n");

test("the pages of the flow reach the brief whole while the window holds them, and over it the last page is a reference to its route", () => {
  const brief = createDelegationBrief({ ...base, pages: PAGES });
  const whole = assembleSidekickBrief(redaction, brief, roomy);
  assert.ok(whole.text.includes("button: checkout action 299"));

  const over = assembleSidekickBrief(redaction, brief, windowOf(bytesOf(whole.text) - 4_000));
  assert.ok(over.text.includes("button: cart action 299"), "the first page stays whole");
  assert.match(over.text, /route \/checkout:\n {2}\(this page's 300 line\(s\) are not shown here, to fit the window\)/);
  assert.ok(over.sectionItems["context-pack"]?.omissions.some((o) => o.reason === WINDOW_FIT_REASON && o.route === "/checkout"));
});

test("a brief that fits is byte-identical whatever the window knows", () => {
  const brief = createDelegationBrief({ ...base, suite: SUITE.slice(0, 3), pages: PAGES });
  assert.equal(assembleSidekickBrief(redaction, brief).text, assembleSidekickBrief(redaction, brief, roomy).text);
});

test("the executor sends the brief rendered with the fit rule it is given", async () => {
  const brief = createDelegationBrief({ ...base, objective: "the cart total", suite: SUITE });
  const whole = assembleSidekickBrief(redaction, brief, roomy);
  const sent: string[] = [];
  const result = JSON.stringify({ delegationId: "d1", runId: "r1", status: "completed", summary: "done", filesChanged: [], evidence: [], acceptance: [], concerns: [], unresolvedQuestions: [], recommendation: "accept" });
  const sidekick = new SidekickExecutor({ redaction, runtime: { openSession: async () => ({ prompt: async (text: string) => { sent.push(text); return { output: result }; }, dispose: async () => {} }) } });

  await sidekick.execute(brief, { cwd: "/w", kind: "author" });
  assert.ok(sent[0]!.includes("end-79"), "no fit rule, nothing degraded");
  await sidekick.execute(brief, { cwd: "/w", kind: "author", fit: windowOf(bytesOf(whole.text) - 20_000) });
  assert.equal(sent[1]!.includes("end-79"), false, "over the window the listing gave way");
});

const REQUEST_FACTS = Array.from({ length: 40 }, (_, i) => `- /cart: GET https://api.example/v${i}/resource`);
const PAGES_WITH_REQUESTS = [PAGES, "", `### ${PACK_HEADINGS.requests} (data requests)`, ...REQUEST_FACTS].join("\n");

test("the requests of the flow's pages reach the brief whole while the window holds them, and over it give way after the pages, last fact first, as a count", () => {
  const brief = createDelegationBrief({ ...base, pages: PAGES_WITH_REQUESTS });
  const whole = assembleSidekickBrief(redaction, brief, roomy);
  assert.ok(whole.text.includes("https://api.example/v39/resource"));

  const over = assembleSidekickBrief(redaction, brief, windowOf(bytesOf(whole.text) - 16_500));
  assert.match(over.text, /route \/checkout:\n {2}\(this page's 300 line\(s\) are not shown here, to fit the window\)/, "the pages gave way first");
  assert.match(over.text, /route \/cart:\n {2}\(this page's 300 line\(s\) are not shown here, to fit the window\)/, "every page gave way before a request did");
  assert.ok(over.text.includes("https://api.example/v0/resource"), "the first fact stays");
  assert.equal(over.text.includes("https://api.example/v39/resource"), false, "the last fact gave way");
  assert.match(over.text, /\(\d+ more request\(s\) are not shown here, to fit the window\)/);
  assert.ok(over.sectionItems["context-pack"]?.omissions.some((o) => o.reason === WINDOW_FIT_REASON && o.route === undefined));
});

const CONTRADICTION_FACTS = Array.from({ length: 3 }, (_, i) => `- /cart: GET https://api.example/v${i}/by-region returned 3 items, none with "key${i}", while GET https://api.example/v${i}/all returned 9 items of the same kind with it`);
const PAGES_WITH_CONTRADICTIONS = [PAGES_WITH_REQUESTS, "", `### ${PACK_HEADINGS.contradictions} (two sources disagree)`, ...CONTRADICTION_FACTS].join("\n");

test("the data contradictions of the flow's pages reach the brief, and over the window they outlast the pages and the requests", () => {
  const brief = createDelegationBrief({ ...base, pages: PAGES_WITH_CONTRADICTIONS });
  const whole = assembleSidekickBrief(redaction, brief, roomy);
  for (let i = 0; i < CONTRADICTION_FACTS.length; i++) assert.ok(whole.text.includes(`none with "key${i}"`), `fact ${i}`);

  const over = assembleSidekickBrief(redaction, brief, windowOf(bytesOf(whole.text) - 16_500));
  assert.match(over.text, /\(\d+ more request\(s\) are not shown here, to fit the window\)/, "requests gave way");
  for (let i = 0; i < CONTRADICTION_FACTS.length; i++) assert.ok(over.text.includes(`none with "key${i}"`), `fact ${i} stayed`);
});
