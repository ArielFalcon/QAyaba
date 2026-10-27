/*
 * The data contradictions the pack recorded reach a prompt whole while the prompt fits its role's window; over it they are the last facts of
 * the pack to give way, after the pages, the requests and the contracts, and then a line counts what they leave out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptAssembled } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import { CONTRADICTIONS_SECTION_INTRO, contradictionsSectionLines } from "@contexts/generation/domain/pack-contradictions.ts";
import { REQUESTS_SECTION_INTRO, requestsSectionLines } from "@contexts/generation/domain/pack-requests.ts";
import { PACK_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import type { PromptFit } from "@contexts/generation/infrastructure/prompt-builders/generator-context.ts";

const windowOf = (bytes: number): PromptFit => ({ bytes: size }) => (size <= bytes ? "fits" : "over");
const roomy = windowOf(10_000_000);
const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

const REQUESTS = Array.from({ length: 30 }, (_, i) => ({ method: "GET", url: `https://api.example/v${i}/resource`, count: 1 }));
const FACTS = ["category", "zone"].map((key) => ({
  route: "/cart",
  key,
  carriedBy: { operation: "GET https://api.example/items", items: 9 },
  missingFrom: { operation: "GET https://api.example/items/by-region/ES", items: 3 },
  schemaBacked: false,
}));
const page = (route: string, count: number): string[] => [`route ${route}:`, ...Array.from({ length: count }, (_, i) => `  button: ${route.slice(1)} action ${i}`)];
const pack = [
  `## ${PACK_HEADINGS.pack} (pushed by the orchestrator before the first write)`,
  "",
  `### ${PACK_HEADINGS.liveDom} (a11y tree — GROUND TRUTH for selectors)`,
  ...page("/cart", 40),
  "",
  `### ${PACK_HEADINGS.requests} ${REQUESTS_SECTION_INTRO}`,
  ...requestsSectionLines([{ route: "/cart", requests: { listed: REQUESTS, omitted: 0 } }]),
  "",
  `### ${PACK_HEADINGS.contracts}`,
  "- `getCart`: GET /api/cart",
  "",
  `### ${PACK_HEADINGS.contradictions} ${CONTRADICTIONS_SECTION_INTRO}`,
  ...contradictionsSectionLines(FACTS),
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

test("the author receives every contradiction the pack recorded while its window holds the pack", () => {
  const prompt = buildPromptAssembled(generator({ contextPack: pack }), { fit: roomy });
  for (const fact of FACTS) assert.ok(prompt.text.includes(`none with "${fact.key}"`), fact.key);
  assert.doesNotMatch(prompt.text, /more contradiction\(s\) are not shown here/);
});

test("over the author's window the contradictions outlast the page, the requests and the contracts, and are counted when they give way", () => {
  const whole = buildPromptAssembled(generator({ contextPack: pack }), { fit: roomy });
  /* What the page, its requests and the contract weigh in the prompt: a window short of that much holds nothing else of the pack but the contradictions. */
  const pageBytes = bytesOf(page("/cart", 40).slice(1).join("\n"));
  const requestBytes = bytesOf(requestsSectionLines([{ route: "/cart", requests: { listed: REQUESTS, omitted: 0 } }]).join("\n"));
  const contractBytes = bytesOf("- `getCart`: GET /api/cart");
  const factBytes = bytesOf(contradictionsSectionLines(FACTS).join("\n"));

  const tight = buildPromptAssembled(generator({ contextPack: pack }), { fit: windowOf(bytesOf(whole.text) - (pageBytes + requestBytes + contractBytes - 400)) });
  assert.match(tight.text, /route \/cart:\n {2}\(this page's 40 line\(s\) are not shown here, to fit the window\)/, "the page gave way first");
  assert.match(tight.text, /\(\d+ more request\(s\) are not shown here, to fit the window\)/);
  assert.equal(tight.text.includes("getCart"), false, "the contracts gave way");
  assert.ok(tight.text.includes(`none with "${FACTS[0]!.key}"`), "the first contradiction stayed");

  const tightest = buildPromptAssembled(generator({ contextPack: pack }), { fit: windowOf(bytesOf(whole.text) - (pageBytes + requestBytes + contractBytes + factBytes)) });
  assert.match(tightest.text, /\(2 more contradiction\(s\) are not shown here, to fit the window\)/);
});
