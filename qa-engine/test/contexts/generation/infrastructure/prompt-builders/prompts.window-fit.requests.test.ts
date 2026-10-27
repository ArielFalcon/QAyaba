/*
 * The requests the pack recorded for its pages reach a prompt whole while the prompt fits its role's window; over it they give way after the
 * pages and the availability facts, last fact first, as a line that counts what they leave out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptAssembled } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import { REQUESTS_SECTION_INTRO, requestsSectionLines } from "@contexts/generation/domain/pack-requests.ts";
import { PACK_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import { WINDOW_FIT_REASON } from "@kernel/prompt-sections.ts";
import type { PromptFit } from "@contexts/generation/infrastructure/prompt-builders/generator-context.ts";

const windowOf = (bytes: number): PromptFit => ({ bytes: size }) => (size <= bytes ? "fits" : "over");
const roomy = windowOf(10_000_000);
const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

const REQUESTS = Array.from({ length: 30 }, (_, i) => ({ method: "GET", url: `https://api.example/v${i}/resource`, count: 1 }));
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

test("the author receives every recorded request while its window holds the pack", () => {
  const prompt = buildPromptAssembled(generator({ contextPack: pack }), { fit: roomy });
  for (const request of REQUESTS) assert.ok(prompt.text.includes(`- /cart: GET ${request.url}`), request.url);
  assert.doesNotMatch(prompt.text, /more request\(s\) are not shown here/);
});

test("over the author's window the requests give way after the page, last fact first, and the prompt counts what it left out", () => {
  const whole = buildPromptAssembled(generator({ contextPack: pack }), { fit: roomy });
  const prompt = buildPromptAssembled(generator({ contextPack: pack }), { fit: windowOf(bytesOf(whole.text) - 1_700) });
  assert.match(prompt.text, /route \/cart:\n {2}\(this page's 40 line\(s\) are not shown here, to fit the window\)/, "the page gave way first");
  assert.ok(prompt.text.includes("- /cart: GET https://api.example/v0/resource"), "the first fact stays");
  assert.equal(prompt.text.includes("https://api.example/v29/resource"), false, "the last fact gave way");
  assert.match(prompt.text, /\(\d+ more request\(s\) are not shown here, to fit the window\)/);
  assert.ok(prompt.text.includes("getCart"), "the contracts outlast the requests");
  assert.ok(prompt.sectionItems["context-pack"]?.omissions.some((o) => o.reason === WINDOW_FIT_REASON));
});
