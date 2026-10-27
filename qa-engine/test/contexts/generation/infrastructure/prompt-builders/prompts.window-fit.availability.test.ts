/*
 * The route availability facts reach a prompt whole, however many, while the prompt fits its role's window; over it they give way last
 * fact first as references that say what they leave out. Only the gate signal keeps a count bound (the persisted record).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptAssembled, buildReviewerPromptAssembled } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import type { ReviewInput } from "@contexts/generation/application/index.ts";
import { availabilitySectionLines } from "@contexts/generation/domain/route-availability-section.ts";
import { PACK_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import { MAX_AVAILABILITY_FACTS_RECORDED, routeAvailabilitySignal, type RouteAvailabilityFact } from "@kernel/route-availability.ts";
import { WINDOW_FIT_REASON } from "@kernel/prompt-sections.ts";
import type { PromptFit } from "@contexts/generation/infrastructure/prompt-builders/generator-context.ts";

const windowOf = (bytes: number): PromptFit => ({ bytes: size }) => (size <= bytes ? "fits" : "over");
const roomy = windowOf(10_000_000);
const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

/* More facts than the old bound of the gate signal, in the order the classes rank. */
const FACTS: RouteAvailabilityFact[] = Array.from({ length: MAX_AVAILABILITY_FACTS_RECORDED * 3 }, (_, i) => ({
  route: `/area-${i}/page`,
  outcome: { kind: "redirected" as const, to: "/home", mechanism: "client" as const },
  sessionAttached: true,
  basis: i < 20 ? { class: "change-introduced" as const, via: "route-guard" as const, at: `src/guards/guard-${i}.ts::canEnter` } : { class: "unexplained" as const, missing: ["declaration" as const] },
}));

const review = (over: Partial<ReviewInput> = {}): ReviewInput => ({
  diff: "diff --git a/src/cart.ts b/src/cart.ts\n+export function total() {}\n",
  specs: [],
  mirrorDir: "/mirrors/org__app",
  e2eRelDir: "e2e",
  appName: "shop",
  mode: "diff",
  target: "e2e",
  ...over,
});

test("the Context Pack's availability section lists every fact, however many, with no count bound", () => {
  const lines = availabilitySectionLines(FACTS);
  for (const fact of FACTS) assert.ok(lines.some((line) => line.startsWith(`- ${fact.route}:`)), fact.route);
  assert.equal(lines.some((line) => /more\)/.test(line)), false);
});

test("the reviewer receives every availability fact, whatever the window knows", () => {
  for (const opts of [{}, { fit: roomy }]) {
    const prompt = buildReviewerPromptAssembled(review({ routeAvailability: FACTS }), opts);
    for (const fact of FACTS) assert.ok(prompt.text.includes(`- ${fact.route}:`), fact.route);
    assert.doesNotMatch(prompt.text, /capped at/);
  }
});

test("availability facts over the reviewer's window are named by route and class first, then counted by class", () => {
  const whole = buildReviewerPromptAssembled(review({ routeAvailability: FACTS }), { fit: roomy });
  const section = whole.sectionSizes["reviewer-route-availability"]!;

  const routes = buildReviewerPromptAssembled(review({ routeAvailability: FACTS }), { fit: windowOf(bytesOf(whole.text) - section / 3) });
  assert.ok(routes.text.includes("/area-47/page"), "a citation still names the route");
  assert.doesNotMatch(routes.text, /src\/guards\/guard-3\.ts::canEnter/);
  assert.deepEqual(routes.sectionItems["reviewer-route-availability"]?.omissions, [{ class: "truncation", reason: WINDOW_FIT_REASON, count: FACTS.length }]);

  const counted = buildReviewerPromptAssembled(review({ routeAvailability: FACTS }), { fit: windowOf(bytesOf(whole.text) - section + 400) });
  assert.match(counted.text, /change-introduced: 20/);
  assert.doesNotMatch(counted.text, /\/area-47\/page/);
});

const page = (route: string, count: number): string[] => [`route ${route}:`, ...Array.from({ length: count }, (_, i) => `  button: ${route.slice(1)} action ${i}`)];
const packWith = (facts: readonly RouteAvailabilityFact[]): string =>
  [
    `## ${PACK_HEADINGS.pack} (pushed by the orchestrator before the first write)`,
    "",
    `### ${PACK_HEADINGS.liveDom} (a11y tree — GROUND TRUTH for selectors)`,
    ...page("/cart", 40),
    "",
    `### ${PACK_HEADINGS.availability}`,
    ...availabilitySectionLines(facts),
  ].join("\n");

const generator = (over: Partial<OpencodeRunInput> = {}): OpencodeRunInput => ({
  repo: "org/app",
  sha: "abc1234",
  diff: "diff --git a/src/cart.ts b/src/cart.ts\n+export function total() {}\n",
  mirrorDir: "/mirrors/org__app",
  e2eRelDir: "e2e",
  namespace: "qa-bot-abc1234",
  target: "e2e",
  mode: "diff",
  appName: "shop",
  baseUrl: "http://localhost:3000",
  intent: { type: "feat", breaking: false, message: "feat(cart): show the total", changedFiles: ["src/cart.ts"] },
  ...over,
});

test("the Context Pack over the author's window gives up its availability facts last fact first, after its pages, and counts what it left out", () => {
  const input = generator({ contextPack: packWith(FACTS) });
  const whole = buildPromptAssembled(input, { fit: roomy });
  for (const fact of FACTS) assert.ok(whole.text.includes(`- ${fact.route}:`));

  const prompt = buildPromptAssembled(input, { fit: windowOf(bytesOf(whole.text) - 2_000) });
  assert.match(prompt.text, /route \/cart:\n {2}\(this page's 40 line\(s\) are not shown here, to fit the window\)/, "the page gave way before any fact did");
  assert.ok(prompt.text.includes("- /area-0/page:"), "the first-ranked fact stays");
  assert.equal(prompt.text.includes("- /area-47/page:"), false, "the lowest-ranked fact gave way");
  assert.match(prompt.text, /\(\d+ more route\(s\) are not shown here, to fit the window\)/);
  assert.ok(prompt.sectionItems["context-pack"]?.omissions.some((o) => o.reason === WINDOW_FIT_REASON));
});

test("the gate signal still lists at most its recorded bound and counts the rest", () => {
  const signal = routeAvailabilitySignal(100, FACTS);
  assert.equal(signal.facts.length, MAX_AVAILABILITY_FACTS_RECORDED);
  assert.equal(signal.omitted, FACTS.length - MAX_AVAILABILITY_FACTS_RECORDED);
  assert.equal(signal.unavailable, FACTS.length);
});
