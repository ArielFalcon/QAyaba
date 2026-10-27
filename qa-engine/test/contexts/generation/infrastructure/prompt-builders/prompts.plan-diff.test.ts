/* The lead's planning turn sees the change through its change map and the ranked hunks that fit the lead's own window; what does not fit is named as a reference, never cut blind. Asserted on the data the `## Commit diff` section carries (paths, counts, candidate ids, hunk bodies, ranges), never on its wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptAssembled, type AssembledPrompt } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { COMMIT_DIFF_HEADING } from "@contexts/generation/infrastructure/prompt-builders/prompt-text.ts";
import { MAX_PROMPT_DIFF_CHARS } from "@contexts/generation/infrastructure/prompt-cap.ts";
import { fileKindOf } from "@kernel/change-map.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
import { pageCandidate } from "../../../../support/use-case-candidate.ts";
import { PromptRenderingAdapter } from "@contexts/generation/infrastructure/prompt-rendering.adapter.ts";
import { buildReviewerPromptAssembled } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { ContextBudget, tokensOfBytes } from "@kernel/context-budget.ts";

const PLANNING = { maxFlows: 5, maxParallel: 2, budgetMs: 240_000 };

/* One file's diff section with one hunk per entry: each hunk adds its own lines at its own new-side start. */
function fileDiff(path: string, hunks: Array<{ start: number; added: string[] }>): string {
  const body = hunks.map(({ start, added }) => `@@ -${start},0 +${start},${added.length} @@\n${added.map((line) => `+${line}`).join("\n")}\n`).join("");
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`;
}

const input = (diff: string, over: Partial<OpencodeRunInput> = {}): OpencodeRunInput => ({
  repo: "org/app",
  sha: "abc1234",
  diff,
  mirrorDir: "/mirrors/org__app",
  e2eRelDir: "e2e",
  namespace: "qa-bot-abc1234",
  target: "e2e",
  mode: "diff",
  appName: "shop",
  baseUrl: "http://localhost:3000",
  intent: { type: "feat", breaking: false, message: "feat(cart): show the total", changedFiles: [] },
  planning: PLANNING,
  ...over,
});

/* The text of the diff section, from the heading to the end of the section. */
function diffSection(assembled: AssembledPrompt): string {
  const bytes = Buffer.from(assembled.text, "utf8");
  let offset = 0;
  for (const [id, size] of Object.entries(assembled.sectionSizes)) {
    if (id === "diff") return bytes.subarray(offset, offset + size).toString("utf8");
    offset += size + 1;
  }
  return "";
}

/* The fenced diff of the section: what the judges read back. */
const fenced = (section: string): string => /```diff\n([\s\S]*?)\n```/.exec(section)?.[1] ?? "";

const lineNaming = (section: string, path: string): string | undefined => section.split("\n").find((line) => line.includes(path) && /\+\d+ -\d+/.test(line) && !line.includes(":"));

test("the plan prompt maps every changed file once with its kind, added and removed lines and the use cases it seeds", () => {
  const diff =
    fileDiff("src/cart/cart.service.ts", [{ start: 10, added: ["export const total = 3;", "export const tax = 1;"] }]) +
    fileDiff("src/cart/cart.css", [{ start: 1, added: [".total { color: red; }"] }]) +
    fileDiff("src/cart/cart.service.spec.ts", [{ start: 1, added: ["it('totals', () => {});"] }]);
  const cart = pageCandidate("/cart", undefined, { seeds: [{ file: "src/cart/cart.service.ts", symbol: "total", range: { start: 10, end: 11 } }] });

  const section = diffSection(buildPromptAssembled(input(diff, { planning: { ...PLANNING, candidates: [cart] } })));

  assert.ok(section.startsWith(COMMIT_DIFF_HEADING), "the heading the judges read back stays");
  const code = lineNaming(section, "src/cart/cart.service.ts");
  assert.ok(code, "the code file has a map line");
  assert.ok(code.includes("+2 -0") && code.includes(fileKindOf("src/cart/cart.service.ts")) && code.includes(cart.id));
  assert.ok(lineNaming(section, "src/cart/cart.css")?.includes("+1 -0"));
  const testFile = lineNaming(section, "src/cart/cart.service.spec.ts");
  assert.ok(testFile, "the app's test file is mapped too");
  assert.ok(!testFile.includes(cart.id));
});

test("a plan prompt with no known window shows every readable hunk whole, past the old 50 KB cut, and references the test file's hunk instead of showing it", () => {
  const big = Array.from({ length: 1_200 }, (_, i) => `export const value${i} = "the catalog lists item ${i} in a row of its own, with its price";`);
  const diff =
    fileDiff("src/catalog/catalog.ts", [{ start: 1, added: big }]) +
    fileDiff("src/cart/cart.ts", [{ start: 40, added: ["export const lastLine = 1;"] }]) +
    fileDiff("src/cart/cart.spec.ts", [{ start: 5, added: ["it('totals the cart', () => {});"] }]);
  assert.ok(diff.length > MAX_PROMPT_DIFF_CHARS, "the fixture is over the cut the plan path no longer applies");

  const section = diffSection(buildPromptAssembled(input(diff)));

  const shown = fenced(section);
  assert.ok(shown.includes(big[big.length - 1]!), "the last line of the large file is there");
  assert.ok(shown.includes("export const lastLine = 1;"), "the file after it is there");
  assert.ok(!section.includes("it('totals the cart'"), "the test file's body is not shown");
  assert.ok(section.includes("src/cart/cart.spec.ts:5-5"), "the test file's hunk is named by its range");
});

test("code hunks come before style hunks, whatever order the diff lists them in", () => {
  const diff = fileDiff("src/cart/cart.css", [{ start: 1, added: [".total { color: red; }"] }]) + fileDiff("src/cart/cart.ts", [{ start: 1, added: ["export const total = 3;"] }]);

  const shown = fenced(diffSection(buildPromptAssembled(input(diff))));

  assert.ok(shown.indexOf("export const total = 3;") >= 0 && shown.indexOf("export const total = 3;") < shown.indexOf(".total { color: red; }"));
});

test("a lead window that cannot hold every hunk keeps the highest-ranked hunks that fit and names the rest by file and range", () => {
  const hunk = (i: number): string[] => Array.from({ length: 40 }, (_, j) => `export const h${i}_${j} = "the cart shows line ${j} of part ${i}";`);
  const diff = fileDiff("src/cart/cart.ts", Array.from({ length: 10 }, (_, i) => ({ start: 1 + i * 100, added: hunk(i) })));
  const roles: AgentRole[] = [];
  let limit = 0;
  const fit = ({ bytes, role }: { bytes: number; role: AgentRole }): "fits" | "over" => {
    roles.push(role);
    return bytes <= limit ? "fits" : "over";
  };
  const whole = buildPromptAssembled(input(diff)).text.length;
  /* Room for seven hunks: three hunks less than the whole, give or take the lines that name them. */
  limit = whole - 3 * hunk(0).join("\n").length + 500;

  const assembled = buildPromptAssembled(input(diff), { fit });
  const section = diffSection(assembled);

  assert.ok(Buffer.byteLength(assembled.text, "utf8") <= limit, "the prompt fits the window it was fitted to");
  assert.ok(roles.length > 0 && roles.every((role) => role === "lead"), "the plan prompt is fitted to the lead's window");
  const shown = fenced(section);
  assert.ok(shown.includes("h0_0") && shown.includes("h6_39"), "the first hunks in rank order are shown");
  assert.ok(!shown.includes("h9_0"), "the last hunk does not fit");
  for (const i of [7, 8, 9]) assert.ok(section.includes(`src/cart/cart.ts:${1 + i * 100}-${40 + i * 100}`), `hunk ${i} is named by its range`);
  assert.ok(!section.includes("diff truncated"), "nothing is cut blind");
});

test("a lead window that holds no hunk still carries the whole change map and every hunk as a reference", () => {
  const diff = fileDiff("src/cart/cart.ts", [{ start: 3, added: ["export const total = 3;"] }]) + fileDiff("src/cart/cart.css", [{ start: 7, added: [".total {}"] }]);

  const section = diffSection(buildPromptAssembled(input(diff), { fit: () => "over" }));

  assert.equal(fenced(section), "");
  assert.ok(lineNaming(section, "src/cart/cart.ts") && lineNaming(section, "src/cart/cart.css"));
  assert.ok(section.includes("src/cart/cart.ts:3-3") && section.includes("src/cart/cart.css:7-7"));
});

test("an authoring turn's diff is not the plan's: it shows the test file's body as before", () => {
  const diff = fileDiff("src/cart/cart.ts", [{ start: 1, added: ["export const total = 3;"] }]) + fileDiff("src/cart/cart.spec.ts", [{ start: 1, added: ["it('totals the cart', () => {});"] }]);

  const { planning: _planning, ...authoring } = input(diff);

  assert.ok(buildPromptAssembled(authoring).text.includes("it('totals the cart'"));
});

test("the rendering adapter fits the plan prompt with the run's context budget: prompt plus the lead's working room within the lead's window", () => {
  const hunk = (i: number): string[] => Array.from({ length: 40 }, (_, j) => `export const h${i}_${j} = "the cart shows line ${j} of part ${i}";`);
  const diff = fileDiff("src/cart/cart.ts", Array.from({ length: 6 }, (_, i) => ({ start: 1 + i * 100, added: hunk(i) })));
  const room = { growthTokensPerStep: 1_000, steps: 10, basis: "cold-start" as const, samples: 0 };
  const whole = Buffer.byteLength(buildPromptAssembled(input(diff)).text, "utf8");
  const leadWindow = tokensOfBytes(whole) + 10_000 - tokensOfBytes(2 * hunk(0).join("\n").length);
  const rendering = new PromptRenderingAdapter(
    { buildPromptAssembled, buildReviewerPromptAssembled, specFileForFlow: (flow) => flow },
    new ContextBudget({ windowTokens: (role) => (role === "lead" ? leadWindow : undefined) }, { forRole: () => room }),
  );

  const plan = rendering.renderMain(input(diff));

  assert.equal(plan.contextFit?.outcome, "fits");
  assert.ok(plan.text.includes("h0_0"), "the first hunk is shown");
  assert.ok(plan.text.includes("src/cart/cart.ts:501-540"), "the last hunk is named by its range");
});
