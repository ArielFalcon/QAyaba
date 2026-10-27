/* The change a flow's brief carries: the flow's slice of the change map, every owned hunk preloaded in rank order while the brief fits the author's window, the rest named by file and range. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { briefChangeFor, fitBriefChange, MAX_PROOF_STEPS, type BriefChange } from "@contexts/coordination/application/brief-change.ts";
import { createDelegationBrief } from "@contexts/coordination/application/delegation-brief.ts";
import { renderSidekickBrief } from "@contexts/coordination/application/sidekick-prompt.ts";
import { readDelegationResult } from "@contexts/coordination/application/delegation-reading.ts";
import { FILE_SEED_SYMBOL, type UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { ContextFit } from "@kernel/context-budget.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { pageCandidate } from "../../../support/use-case-candidate.ts";

const redaction = new PatternRedactionAdapter();
const SECRET = `sk-ant-api03-${"a".repeat(40)}`;

const section = (path: string, hunks: Array<{ start: number; lines: string[] }>): string[] => [
  `diff --git a/${path} b/${path}`,
  `--- a/${path}`,
  `+++ b/${path}`,
  ...hunks.flatMap(({ start, lines }) => [`@@ -${start},1 +${start},${lines.length} @@`, ...lines]),
];

/* A template the map links to the page, before the code in diff order; the page's own code in two hunks; a hub's code; another page's code. */
const DIFF = [
  ...section("src/cart.html", [{ start: 1, lines: ["+<p>{{ total }}</p>"] }]),
  ...section("src/cart.ts", [{ start: 2, lines: [" keep", `+const key = "${SECRET}";`] }, { start: 40, lines: [" keep", "+return total;"] }]),
  ...section("src/util/money.ts", [{ start: 5, lines: [" keep", "+export const fmt = 1;"] }]),
  ...section("src/orders.ts", [{ start: 1, lines: ["+orders"] }]),
].join("\n");

const cart = (over: Partial<UseCaseCandidate> = {}): UseCaseCandidate =>
  pageCandidate("/cart", ["src/cart.ts::total", "page /cart"], {
    seeds: [
      { file: "src/cart.ts", symbol: "total", range: { start: 1, end: 60 } },
      { file: "src/cart.html", symbol: FILE_SEED_SYMBOL },
    ],
    sharedSeeds: [{ file: "src/util/money.ts", symbol: "fmt", range: { start: 5, end: 8 }, pages: 4 }],
    ...over,
  });
const orders = pageCandidate("/orders", ["page /orders"], { seeds: [{ file: "src/orders.ts", symbol: "orders", range: { start: 1, end: 3 } }] });

const flow = { routes: ["/cart"], candidates: ["uc-/cart"] };

test("a flow's change names each of its files with kind, added lines and origin, and no file of another flow", () => {
  const { change } = briefChangeFor(flow, [cart(), orders], { diffs: [DIFF] });
  const files = Object.fromEntries(change!.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(files).sort(), ["src/cart.html", "src/cart.ts", "src/util/money.ts"]);
  assert.deepEqual([files["src/cart.ts"]!.kind, files["src/cart.ts"]!.added, files["src/cart.ts"]!.origins], ["typescript", 2, ["graph"]]);
  assert.deepEqual([files["src/cart.html"]!.kind, files["src/cart.html"]!.origins], ["other", ["map-link"]]);
  assert.deepEqual(files["src/util/money.ts"]!.origins, ["shared"]);
});

test("a flow's candidates carry their symbols with ranges, and their changed code is the slice's owned hunks, code first and then diff order", () => {
  const { candidates, change } = briefChangeFor(flow, [cart(), orders], { diffs: [DIFF], subject: "feat(cart): show the total" });
  assert.deepEqual(candidates.map((c) => c.id), ["uc-/cart"]);
  assert.ok(candidates[0]!.symbols.some((s) => s.includes("total") && s.includes("src/cart.ts:1-60")));
  assert.ok(candidates[0]!.symbols.some((s) => s.includes("fmt") && s.includes("src/util/money.ts:5-8")));
  assert.deepEqual(candidates[0]!.expectedFrom.map((s) => s.kind), ["commit-message", "diff"]);
  assert.deepEqual(change!.hunks.map((h) => h.path), ["src/cart.ts", "src/cart.ts", "src/util/money.ts", "src/cart.html"]);
  assert.deepEqual(change!.hunks.map((h) => h.candidateIds), [["uc-/cart"], ["uc-/cart"], ["uc-/cart"], ["uc-/cart"]]);
});

test("every owned hunk is preloaded whole, however many and however long", () => {
  const long = section("src/cart.ts", Array.from({ length: 6 }, (_, i) => ({ start: 1 + i * 100, lines: Array.from({ length: 60 }, (_, j) => `+line ${i}-${j}`) }))).join("\n");
  const { change } = briefChangeFor(flow, [cart({ seeds: [{ file: "src/cart.ts", symbol: "total", range: { start: 1, end: 1000 } }], sharedSeeds: [] })], { diffs: [long] });
  assert.equal(change!.hunks.length, 6);
  assert.ok(change!.hunks[5]!.text.includes("+line 5-59"));
});

test("a flow cites its candidates and the ones its routes name, with no cap on their number", () => {
  const all = Array.from({ length: 7 }, (_, i) => pageCandidate(`/p${i}`));
  const { candidates } = briefChangeFor({ routes: all.map((c) => (c.entry as { route: string }).route), candidates: [] }, all, { diffs: [] });
  assert.equal(candidates.length, 7);
  assert.deepEqual(briefChangeFor({ routes: ["/nowhere"], candidates: ["uc-unknown"] }, all, { diffs: [] }).candidates, []);
});

test("a reach path longer than the bound keeps the change and the page and says how many steps it left out", () => {
  const long = pageCandidate("/orders", [...Array.from({ length: MAX_PROOF_STEPS + 3 }, (_, i) => `f${i}.ts::s${i}`), "page /orders"]);
  const [candidate] = briefChangeFor({ routes: ["/orders"], candidates: [] }, [long], { diffs: [] }).candidates;
  assert.equal(candidate!.evidence.length, MAX_PROOF_STEPS);
  assert.equal(candidate!.evidence.at(-1), "page /orders");
  assert.match(candidate!.evidence.join(" "), /\(\d+ more\)/);
});

const fitAt = (maxHunks: number) => (change: BriefChange): ContextFit => ({ outcome: change.hunks.length <= maxHunks ? "fits" : "over", promptTokens: change.hunks.length, windowTokens: maxHunks });

test("a brief over the window references its owned non-code hunks first, then its lowest-ranked code, each by file and range", () => {
  const { change } = briefChangeFor(flow, [cart(), orders], { diffs: [DIFF] });
  const fitted = fitBriefChange(change!, fitAt(2));
  assert.equal(fitted.fit.outcome, "fits");
  assert.deepEqual(fitted.change.hunks.map((h) => h.path), ["src/cart.ts", "src/cart.ts"]);
  const notPreloaded = fitted.change.references.filter((r) => /src\/cart\.html|src\/util\/money\.ts/.test(r));
  assert.equal(notPreloaded.length, 2);
  assert.match(notPreloaded[0]!, /^src\/cart\.html:1-1\b/);
  assert.match(notPreloaded[1]!, /^src\/util\/money\.ts:5-6\b/);
  assert.equal(fitted.referenced, 2);
});

test("an unknown window preloads every owned hunk and says the window was unknown", () => {
  const { change } = briefChangeFor(flow, [cart(), orders], { diffs: [DIFF] });
  const fitted = fitBriefChange(change!, () => ({ outcome: "unknown", promptTokens: 1 }));
  assert.equal(fitted.fit.outcome, "unknown");
  assert.equal(fitted.change.hunks.length, 4);
  assert.equal(fitted.referenced, 0);
});

const briefOf = (extra: Partial<Parameters<typeof createDelegationBrief>[0]> = {}) =>
  createDelegationBrief({ redaction, delegationId: "d", runId: "r", objective: "o", task: "t", scope: { readablePaths: ["."], writablePaths: ["e2e/flows/cart.spec.ts"], allowedCommands: [] }, ...extra });

test("the author's brief states the change in one section, never a second proofs section, and no secret of the diff reaches it", () => {
  const derived = briefChangeFor(flow, [cart(), orders], { diffs: [DIFF] });
  const { text, sectionSizes } = renderSidekickBrief(redaction, briefOf({ candidates: derived.candidates, change: derived.change! }));
  assert.ok(sectionSizes.change! > 0);
  assert.equal("proofs" in sectionSizes, false);
  assert.ok(text.includes("+return total;") && text.includes("src/cart.ts:40-41"));
  assert.ok(!text.includes("sk-ant-api03-aaaa"));
  assert.ok(!text.includes("src/orders.ts"), "another flow's code is not this flow's");
});

test("the author's brief renders no section that has nothing to state, and its return contract asks only for what is read", () => {
  const { text, sectionSizes } = renderSidekickBrief(redaction, briefOf());
  for (const empty of ["acceptance", "facts", "artifacts", "validation", "change"]) assert.equal(empty in sectionSizes, false, empty);
  assert.ok(!text.includes("(none)\n") && !text.includes("Validation plan"));
  for (const field of ['"evidence"', '"validation"', '"assumptions"']) assert.ok(!text.includes(field), field);
});

test("a known fact says where it was read", () => {
  const { text } = renderSidekickBrief(redaction, briefOf({ knownFacts: [{ id: "pack-data:/cart", kind: "grounding", source: "ContextPack", summary: "the page read 3 results", confidence: "deterministic", dataRef: "/cart" }] }));
  assert.match(text, /the page read 3 results[^\n]*ContextPack/);
});

test("an author's answer is read without evidence, validation or assumptions of its own", () => {
  const answer = JSON.stringify({ delegationId: "d", runId: "r", status: "completed", summary: "s", filesChanged: [], evidence: [{ id: "x", summary: "mine" }], validation: [{ id: "v", ok: false }], assumptions: ["a"], acceptance: [], concerns: [], unresolvedQuestions: [], recommendation: "accept" });
  const result = readDelegationResult(answer, briefOf(), redaction) as unknown as Record<string, unknown>;
  assert.equal(result.status, "completed");
  assert.equal("validation" in result, false);
  assert.equal("assumptions" in result, false);
  assert.equal(result.evidence, undefined, "evidence holds only the orchestrator's own facts");
});
