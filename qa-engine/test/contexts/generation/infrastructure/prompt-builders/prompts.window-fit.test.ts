/*
 * No fixed byte, line or node count cuts a prompt section: a section is kept whole while the prompt fits its role's window with the
 * working room its turn needs, and only a prompt over its window shows parts of it as references that name what they leave out,
 * recorded as `window-fit` omissions. An unknown window fails open.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPromptAssembled, buildReviewerPromptAssembled, REVIEWER_MISSING_CASES_SECTION_ID } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import type { ReviewInput } from "@contexts/generation/application/index.ts";
import { PACK_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import { WINDOW_FIT_REASON } from "@kernel/prompt-sections.ts";
import type { PromptFit } from "@contexts/generation/infrastructure/prompt-builders/generator-context.ts";

/* A role window of `bytes`, the way the run's ContextBudget answers the fit rule. */
const windowOf = (bytes: number): PromptFit => ({ bytes: size }) => (size <= bytes ? "fits" : "over");
const roomy = windowOf(10_000_000);

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

const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

/* The arms of a change as large as the one in the run whose missing-cases section was cut to 4,000 of its 8,778 bytes. */
const ARMS = Array.from({ length: 120 }, (_, i) => ({ file: `src/app/feature-${i % 6}/feature.component.ts`, line: 10 + i, kind: "if", arm: `else of the condition number ${i}` }));

test("the reviewer's missing cases reach its prompt whole, however many, while the prompt fits the reviewer's window", () => {
  for (const opts of [{}, { fit: roomy }]) {
    const prompt = buildReviewerPromptAssembled(review({ untakenArms: ARMS }), opts);
    assert.ok((prompt.sectionSizes[REVIEWER_MISSING_CASES_SECTION_ID] ?? 0) > 8_000);
    for (const arm of ARMS) assert.ok(prompt.text.includes(`${arm.file}:${arm.line} if: ${arm.arm}`));
    assert.doesNotMatch(prompt.text, /capped at/);
  }
});

test("missing cases over the reviewer's window are named as file:line references first, then counted by file", () => {
  const whole = buildReviewerPromptAssembled(review({ untakenArms: ARMS }), { fit: roomy });
  const section = whole.sectionSizes[REVIEWER_MISSING_CASES_SECTION_ID]!;

  const refs = buildReviewerPromptAssembled(review({ untakenArms: ARMS }), { fit: windowOf(bytesOf(whole.text) - section / 3) });
  assert.ok(refs.text.includes("src/app/feature-0/feature.component.ts:10,"), "the arms of a file are named by line");
  assert.doesNotMatch(refs.text, /else of the condition number 0\b/);
  assert.deepEqual(refs.sectionItems[REVIEWER_MISSING_CASES_SECTION_ID]?.omissions, [{ class: "truncation", reason: WINDOW_FIT_REASON, count: ARMS.length }]);

  const counted = buildReviewerPromptAssembled(review({ untakenArms: ARMS }), { fit: windowOf(bytesOf(whole.text) - section + 600) });
  assert.match(counted.text, /src\/app\/feature-5\/feature\.component\.ts: 20 arm\(s\)/);
  assert.doesNotMatch(counted.text, /feature\.component\.ts:10,/);
});

const page = (route: string, count: number): string[] => [`route ${route}:`, ...Array.from({ length: count }, (_, i) => `  button: ${route.slice(1)} action ${i}`)];

test("the reviewer's live DOM reaches its prompt whole past the size the old section cap kept, while it fits", () => {
  const dom = [...page("/cart", 400), ...page("/checkout", 400)].join("\n");
  const prompt = buildReviewerPromptAssembled(review({ domSnapshot: dom }), { fit: roomy });
  assert.ok(bytesOf(dom) > 20_000);
  assert.ok(prompt.text.includes("button: checkout action 399"));
  assert.doesNotMatch(prompt.text, /capped at/);
});

test("the reviewer's live DOM over its window shows its last page as a reference first", () => {
  const dom = [...page("/cart", 400), ...page("/checkout", 400)].join("\n");
  const whole = buildReviewerPromptAssembled(review({ domSnapshot: dom }), { fit: roomy });
  const prompt = buildReviewerPromptAssembled(review({ domSnapshot: dom }), { fit: windowOf(bytesOf(whole.text) - 5_000) });
  assert.ok(prompt.text.includes("button: cart action 399"));
  assert.match(prompt.text, /route \/checkout:\n {2}\(this page's 400 line\(s\) are not shown here, to fit the window\)/);
});

test("the existing suite, the prior corrections and the spec change reach the reviewer whole past the sizes their old caps kept", () => {
  const existing = Array.from({ length: 400 }, (_, i) => `flows/area-${i % 9}/flow-${i}.spec.ts`);
  const prior = Array.from({ length: 120 }, (_, i) => `[fragile-selector] flows/a.spec.ts: correction number ${i} with enough words to be long`);
  const change = Array.from({ length: 200 }, (_, i) => `+  await expect(page.getByRole("button", { name: "Action ${i}" })).toBeVisible();`).join("\n");
  const prompt = buildReviewerPromptAssembled(review({ existingSpecFiles: existing, priorCorrections: prior, specChanges: change }), { fit: roomy });
  assert.ok(prompt.text.includes("flows/area-3/flow-399.spec.ts"));
  assert.ok(prompt.text.includes("correction number 119"));
  assert.ok(prompt.text.includes('name: "Action 199"'));
  assert.doesNotMatch(prompt.text, /truncated|capped at/);
});

test("the specs under review are inlined past the size the old inline cap kept, and over the window are named to be read", () => {
  const mirrorDir = mkdtempSync(join(tmpdir(), "qa-window-fit-"));
  mkdirSync(join(mirrorDir, "e2e", "flows"), { recursive: true });
  const specs = ["flows/a.spec.ts", "flows/b.spec.ts", "flows/c.spec.ts"];
  for (const spec of specs) writeFileSync(join(mirrorDir, "e2e", spec), `test("x", async () => {\n${"  await page.goto('/');\n".repeat(700)}});\n`);
  const input = review({ mirrorDir, specs });

  const whole = buildReviewerPromptAssembled(input, { fit: roomy });
  assert.ok((whole.sectionSizes["reviewer-specs"] ?? 0) > 40_000);
  assert.match(whole.text, /contents provided inline/);

  const tight = buildReviewerPromptAssembled(input, { fit: windowOf(bytesOf(whole.text) / 2) });
  assert.match(tight.text, /1\. e2e\/flows\/a\.spec\.ts/);
  assert.match(tight.text, /not shown here, to fit the window/);
  assert.doesNotMatch(tight.text, /contents provided inline/);
});

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

const PACK = [
  `## ${PACK_HEADINGS.pack} (pushed by the orchestrator before the first write)`,
  "",
  `### ${PACK_HEADINGS.liveDom} (a11y tree — GROUND TRUTH for selectors)`,
  ...page("/cart", 300),
  ...page("/checkout", 300),
  ...page("/orders", 300),
].join("\n");
const PACK_IDS = ["dom:/cart#role:button:x", "dom:/checkout#role:button:y", "dom:/orders#role:button:z", "op:getCart"];

test("the Context Pack over the author's window shows its lowest-ranked pages as references, and records each page it left out", () => {
  const input = generator({ contextPack: PACK, contextPackItemIds: PACK_IDS });
  const whole = buildPromptAssembled(input, { fit: roomy });
  assert.ok(whole.text.includes("button: orders action 299"));

  const prompt = buildPromptAssembled(input, { fit: windowOf(bytesOf(whole.text) - 9_000) });
  assert.ok(prompt.text.includes("button: cart action 299"), "the first-ranked page stays whole");
  assert.match(prompt.text, /route \/orders:\n {2}\(this page's 300 line\(s\) are not shown here, to fit the window\)/);
  const meta = prompt.sectionItems["context-pack"]!;
  assert.ok(meta.omissions.some((o) => o.reason === WINDOW_FIT_REASON && o.route === "/orders" && o.count === 300));
  assert.ok(!meta.omissions.some((o) => o.route === "/cart"));
  assert.ok(!meta.itemIds.includes("dom:/orders#role:button:z"), "a page left out supplies none of its elements");
  assert.ok(meta.itemIds.includes("dom:/cart#role:button:x"));
  assert.ok(meta.itemIds.includes("op:getCart"));
  assert.equal(prompt.windowFit?.outcome, "fits");
});

test("a generator prompt that fits, or whose window is unknown, is the prompt it was without the rule", () => {
  const input = generator({ contextPack: PACK, contextPackItemIds: PACK_IDS });
  const plain = buildPromptAssembled(input);
  for (const fit of [roomy, (() => "unknown") as PromptFit]) {
    const prompt = buildPromptAssembled(input, { fit });
    assert.equal(prompt.text, plain.text);
    assert.deepEqual(prompt.sectionItems, plain.sectionItems);
  }
});
