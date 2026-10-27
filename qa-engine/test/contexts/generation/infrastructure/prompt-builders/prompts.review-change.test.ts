/* The reviewer of a planned run judges the change by flow: each flow's slice, every changed file, and in full what no flow under review holds. When the prompt does not fit the reviewer's window, owned non-code and then the lowest-ranked code become references, and the review is never split. Asserted on section ids and the change's own data, never on prompt wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChangeMap } from "@kernel/change-map.ts";
import { sliceFor, unassignedOf } from "@kernel/change-slice.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import { REVIEWER_MISSING_CASES_SECTION_ID, buildReviewerPromptAssembled, type AssembledPrompt } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import {
  REVIEWER_CHANGED_FILES_SECTION_ID,
  REVIEWER_FLOW_SLICES_SECTION_ID,
  REVIEWER_UNASSIGNED_CHANGE_SECTION_ID,
} from "@contexts/generation/infrastructure/prompt-builders/reviewer-change-sections.ts";
import { COMMIT_DIFF_HEADING } from "@contexts/generation/infrastructure/prompt-builders/prompt-text.ts";
import type { ReviewInput } from "@contexts/generation/domain/generation-input.ts";
import type { ReviewChangeView } from "@contexts/generation/domain/review-change-view.ts";
import { ARTIFACT_REFERENCES } from "@contexts/generation/domain/prompt-artifact-references.ts";
import { lintCell, type LintSection } from "@contexts/generation/domain/prompt-contract-lint.ts";

function fileDiff(path: string, hunks: ReadonlyArray<{ start: number; added: number }>): string {
  const body = hunks.map((h) => [`@@ -${h.start},1 +${h.start},${h.added + 1} @@`, " ctx", ...Array.from({ length: h.added }, (_, i) => `+new ${path} ${h.start + i}`)].join("\n"));
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...body, ""].join("\n");
}

/* Hunks of a realistic size, so that showing one as a reference saves more than the line that names it. */
const DIFF = fileDiff("src/cart.ts", [{ start: 3, added: 20 }, { start: 40, added: 20 }]) + fileDiff("src/cart.css", [{ start: 1, added: 20 }]) + fileDiff("src/other.ts", [{ start: 7, added: 20 }]) + fileDiff("src/cart.test.ts", [{ start: 1, added: 3 }]);

const candidate = { id: "uc-cart", seeds: [{ file: "src/cart.ts", symbol: "total", range: { start: 1, end: 6 } }, { file: "src/cart.ts", symbol: "far", range: { start: 40, end: 60 } }, { file: "src/cart.css", symbol: "*" }] } as unknown as UseCaseCandidate;

function view(): ReviewChangeView {
  const map = buildChangeMap({ diff: DIFF, candidates: [candidate] });
  const slice = sliceFor(map, DIFF, ["uc-cart"]);
  return {
    files: map.files,
    flows: [{ specFile: "flows/cart.spec.ts", candidateIds: ["uc-cart"], owned: slice.owned }],
    unassigned: unassignedOf(map, DIFF, [slice]),
    hunkless: [],
    referenced: slice.references.filter((r) => r.why === "test-file"),
  };
}

function mkReview(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return { diff: DIFF, specs: ["flows/cart.spec.ts"], mirrorDir: "/mirrors/org__app", e2eRelDir: "e2e", appName: "shop", mode: "diff", target: "e2e", ...overrides };
}

function sectionText(a: AssembledPrompt, id: string): string {
  const bytes = Buffer.from(a.text, "utf8");
  let offset = 0;
  for (const [sectionId, size] of Object.entries(a.sectionSizes)) {
    if (sectionId === id) return bytes.subarray(offset, offset + size).toString("utf8");
    offset += size + 1;
  }
  return "";
}

const OWNED_CODE = "+new src/cart.ts 3";
const OWNED_LOW_RANK_CODE = "+new src/cart.ts 40";
const OWNED_STYLE = "+new src/cart.css 1";
const UNASSIGNED = "+new src/other.ts 7";

test("a planned review carries each flow's slice, every changed file and, in full, what no flow under review holds, instead of the whole diff", () => {
  const a = buildReviewerPromptAssembled(mkReview({ changeView: view() }));
  assert.equal(a.text.includes(`${COMMIT_DIFF_HEADING}\n`), false, "the whole diff is not the objective");
  const slices = sectionText(a, REVIEWER_FLOW_SLICES_SECTION_ID);
  assert.ok(slices.includes("flows/cart.spec.ts") && slices.includes("uc-cart"), "the flow is named with its use cases");
  for (const line of [OWNED_CODE, OWNED_LOW_RANK_CODE, OWNED_STYLE]) assert.ok(slices.includes(line), line);
  assert.equal(slices.includes(UNASSIGNED), false);
  const files = sectionText(a, REVIEWER_CHANGED_FILES_SECTION_ID);
  for (const path of ["src/cart.ts", "src/cart.css", "src/other.ts", "src/cart.test.ts"]) assert.ok(files.includes(path), path);
  assert.ok(files.includes("(+40 -0)"), "each file states its added and removed lines");
  const unassigned = sectionText(a, REVIEWER_UNASSIGNED_CHANGE_SECTION_ID);
  assert.ok(unassigned.includes(UNASSIGNED), "the unassigned hunk is given in full");
  assert.ok(unassigned.includes("src/cart.test.ts:1-4"), "an app test file is named as a reference");
});

test("a review with no change view keeps the whole commit diff and has none of the slice sections", () => {
  const a = buildReviewerPromptAssembled(mkReview());
  assert.ok(a.text.includes(`${COMMIT_DIFF_HEADING}\n`));
  assert.ok(a.text.includes(UNASSIGNED) && a.text.includes(OWNED_CODE));
  for (const id of [REVIEWER_FLOW_SLICES_SECTION_ID, REVIEWER_CHANGED_FILES_SECTION_ID, REVIEWER_UNASSIGNED_CHANGE_SECTION_ID]) assert.equal(id in a.sectionSizes, false, id);
});

test("over the reviewer's window, owned non-code goes to references first, then the unassigned code, then owned code from the lowest rank, and every section stays", () => {
  const full = Buffer.byteLength(buildReviewerPromptAssembled(mkReview({ changeView: view() })).text, "utf8");
  /* The order things leave in, first to last; a later one is only gone once every earlier one is. */
  const order = [OWNED_STYLE, UNASSIGNED, OWNED_LOW_RANK_CODE, OWNED_CODE];
  const seen = new Set<string>();
  for (let limit = full; limit > full - 3_000; limit -= 16) {
    const a = buildReviewerPromptAssembled(mkReview({ changeView: view() }), { fits: (_role, bytes) => (bytes <= limit ? "fits" : "over") });
    const present = order.map((line) => a.text.includes(line));
    for (let i = 1; i < order.length; i++) if (!present[i]) assert.equal(present[i - 1], false, `${order[i]} left before ${order[i - 1]} at ${limit}`);
    if (present.some(Boolean)) assert.ok(Buffer.byteLength(a.text, "utf8") <= limit, `the prompt fits at ${limit}`);
    seen.add(present.map((p) => (p ? "1" : "0")).join(""));
    for (const id of [REVIEWER_FLOW_SLICES_SECTION_ID, REVIEWER_CHANGED_FILES_SECTION_ID, REVIEWER_UNASSIGNED_CHANGE_SECTION_ID]) assert.ok(id in a.sectionSizes, id);
  }
  assert.deepEqual([...seen].sort(), ["0000", "0001", "0011", "0111", "1111"], "every step of the order was reached");
  const tight = buildReviewerPromptAssembled(mkReview({ changeView: view() }), { fits: () => "over" });
  for (const ref of ["src/cart.css:1-21", "src/other.ts:7-27", "src/cart.ts:40-60", "src/cart.ts:3-23"]) assert.ok(tight.text.includes(ref), `${ref} is referenced by file and range`);
});

test("an unknown fit preloads every owned and unassigned hunk", () => {
  const a = buildReviewerPromptAssembled(mkReview({ changeView: view() }), { fits: () => "unknown" });
  for (const line of [OWNED_CODE, OWNED_LOW_RANK_CODE, OWNED_STYLE, UNASSIGNED]) assert.ok(a.text.includes(line), line);
});

test("the arms no test ran still reach a planned review", () => {
  const a = buildReviewerPromptAssembled(mkReview({ changeView: view(), untakenArms: [{ file: "src/cart.ts", line: 4, kind: "if", arm: "else" }] }));
  assert.ok(sectionText(a, REVIEWER_MISSING_CASES_SECTION_ID).includes("src/cart.ts:4 if: else"));
});

function lintSectionsOf(assembled: AssembledPrompt): LintSection[] {
  const bytes = Buffer.from(assembled.text, "utf8");
  let offset = 0;
  return Object.entries(assembled.sectionSizes).map(([id, size]) => {
    const text = bytes.subarray(offset, offset + size).toString("utf8");
    offset += size + 1;
    return { id, layer: "assembled" as const, text, claims: assembled.claims[id] ?? [] };
  });
}

const findingsOf = (a: AssembledPrompt): string[] => lintCell({ name: "reviewer", regen: false, sections: lintSectionsOf(a) }, { artifactReferences: ARTIFACT_REFERENCES }).map((f) => f.rule).sort();

test("a planned review, whole or with every part referenced, raises no prompt-contract finding the whole-diff review does not", () => {
  const whole = findingsOf(buildReviewerPromptAssembled(mkReview()));
  assert.deepEqual(findingsOf(buildReviewerPromptAssembled(mkReview({ changeView: view() }))), whole);
  assert.deepEqual(findingsOf(buildReviewerPromptAssembled(mkReview({ changeView: view() }), { fits: () => "over" })), whole);
});
