import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSuiteListing, LISTING_MAX_DO_NOT_REWRITE, type SuiteListing, type SuiteListingInput } from "@contexts/generation/domain/suite-listing.ts";
import { leftOutLine, renderSuiteListing, PLAIN_LISTING_NOTE } from "@contexts/generation/domain/suite-listing-render.ts";
import { PROMPT_HEADINGS, SUITE_LISTING_LABELS } from "@contexts/generation/domain/prompt-headings.ts";

/* How a listing is written into a prompt: the lines of the entries it hands out under the labels of the turn's work, and nothing of what produced them. */

const keep = (text: string): string => text;
const listing = (input: SuiteListingInput): SuiteListing => buildSuiteListing(input, { sanitize: keep });
const lines = (text: string): string[] => text.split("\n");
const bullet = (text: string): string => `- ${text}`;

const A = { file: "flows/a.spec.ts", flow: "a flow", objective: "a objective" };
const B = { file: "flows/b.spec.ts", flow: "b flow", objective: "b objective" };
const C_LINE = "flows/c.spec.ts — flow: c flow, objective: c objective";
const failing = (file: string) => ({ name: "a failing test", status: "fail" as const, file });

test("a listing of nothing renders nothing: there is no section to write", () => {
  assert.equal(renderSuiteListing(listing({})), "");
});

test("a turn with nothing editable keeps the plain list of the suite: the title with its note, then every entry as a bullet, in order", () => {
  const result = listing({ existing: [C_LINE, "d.spec.ts"], delivered: [A] });
  assert.deepEqual(lines(renderSuiteListing(result)), [
    `## ${PROMPT_HEADINGS.existingSuiteManifest} (3 spec file(s)${PLAIN_LISTING_NOTE})`,
    ...result.entries.map((entry) => bullet(entry.text)),
  ]);
});

/* The one place where the wording is the contract: a first pass writes its list of the suite as every run has always sent it, byte for byte, and the recorded budgets only notice growth. */
test("the plain list is written byte for byte as a first pass has always written it", () => {
  const lines = ["flows/cart.spec.ts", "flows/login.spec.ts — flow: login, objective: the user signs in"];
  assert.equal(
    renderSuiteListing(listing({ existing: lines })),
    [
      "## existing-suite-manifest (2 spec file(s) — do NOT rewrite flows already covered here)",
      "- flows/cart.spec.ts",
      "- flows/login.spec.ts — flow: login, objective: the user signs in",
    ].join("\n"),
  );
});

test("the plain list is never capped: a suite longer than the cap of the do-not-rewrite entries is written whole", () => {
  const existing = Array.from({ length: LISTING_MAX_DO_NOT_REWRITE + 7 }, (_, index) => `suite/s${String(index).padStart(3, "0")}.spec.ts`);
  const text = renderSuiteListing(listing({ existing }));
  assert.equal(lines(text).length, 1 + existing.length);
  assert.ok(!text.includes(leftOutLine(1)), "nothing is counted as left out");
});

test("a turn with editable entries writes the title, the editable label and every editable entry, then the do-not-rewrite label and its entries", () => {
  const result = listing({ existing: [C_LINE, "d.spec.ts"], delivered: [A, B], fixCases: [failing("flows/a.spec.ts"), failing("flows/c.spec.ts")] });
  assert.deepEqual(lines(renderSuiteListing(result)), [
    `## ${PROMPT_HEADINGS.existingSuiteManifest} (4 spec file(s))`,
    SUITE_LISTING_LABELS.editable,
    ...result.editable.map((entry) => bullet(entry.text)),
    SUITE_LISTING_LABELS.doNotRewrite,
    ...result.doNotRewrite.map((entry) => bullet(entry.text)),
  ]);
  assert.equal(result.editable.length, 2);
  assert.equal(result.doNotRewrite.length, 2);
});

test("the count in the title is every spec the listing holds, the ones the cap leaves out included", () => {
  const existing = Array.from({ length: LISTING_MAX_DO_NOT_REWRITE + 5 }, (_, index) => `suite/s${String(index).padStart(3, "0")}.spec.ts`);
  const result = listing({ existing, delivered: [A], fixCases: [failing("flows/a.spec.ts")] });
  assert.equal(lines(renderSuiteListing(result))[0], `## ${PROMPT_HEADINGS.existingSuiteManifest} (${existing.length + 1} spec file(s))`);
});

test("the do-not-rewrite entries end with the count of those the cap leaves out, and every editable entry is written however many there are", () => {
  const existing = Array.from({ length: LISTING_MAX_DO_NOT_REWRITE + 5 }, (_, index) => `suite/s${String(index).padStart(3, "0")}.spec.ts`);
  const delivered = Array.from({ length: LISTING_MAX_DO_NOT_REWRITE + 3 }, (_, index) => ({ file: `mine/m${String(index).padStart(3, "0")}.spec.ts` }));
  const result = listing({ existing, delivered, coverageGap: "src/cart.ts: lines 10-14" });
  const written = lines(renderSuiteListing(result));
  assert.equal(result.editable.length, delivered.length);
  assert.equal(result.leftOut, 5);
  assert.equal(written.at(-1), leftOutLine(result.leftOut));
  const doNotRewriteAt = written.indexOf(SUITE_LISTING_LABELS.doNotRewrite);
  assert.equal(written.slice(1, doNotRewriteAt).filter((line) => line.startsWith("- ")).length, delivered.length, "every editable entry is written");
  assert.equal(written.slice(doNotRewriteAt + 1, -1).length, LISTING_MAX_DO_NOT_REWRITE, "the do-not-rewrite entries are the cap's worth");
});

test("nothing is counted as left out when the cap leaves nothing out", () => {
  const result = listing({ existing: [C_LINE], delivered: [A], fixCases: [failing("flows/a.spec.ts")] });
  assert.equal(result.leftOut, 0);
  const text = renderSuiteListing(result);
  assert.ok(!lines(text).some((line) => line === leftOutLine(0) || line.startsWith("(+")), "no line counts what the cap left out");
});

test("a turn whose every spec is editable writes no do-not-rewrite label", () => {
  const result = listing({ delivered: [A, B], coverageGap: "src/cart.ts: lines 10-14" });
  assert.equal(result.doNotRewrite.length, 0);
  const written = lines(renderSuiteListing(result));
  assert.deepEqual(written, [
    `## ${PROMPT_HEADINGS.existingSuiteManifest} (2 spec file(s))`,
    SUITE_LISTING_LABELS.editable,
    ...result.editable.map((entry) => bullet(entry.text)),
  ]);
});

test("the labels and the title are each written once, so each can be told from the entries under it", () => {
  const result = listing({ existing: [C_LINE], delivered: [A, B], fixCases: [failing("flows/a.spec.ts")] });
  const text = renderSuiteListing(result);
  for (const label of [SUITE_LISTING_LABELS.editable, SUITE_LISTING_LABELS.doNotRewrite, `## ${PROMPT_HEADINGS.existingSuiteManifest}`]) {
    assert.equal(text.split(label).length - 1, 1, label);
  }
});

test("only the text of an entry reaches the prompt: what produced the listing leaves no trace in what is written", () => {
  const secret = "hunter2";
  const result = buildSuiteListing(
    { existing: [`flows/${secret}.spec.ts — flow: login, objective: use ${secret}`], delivered: [{ file: `flows/${secret}-new.spec.ts`, objective: secret }], coverageGap: "src/cart.ts: lines 10-14" },
    { sanitize: (text) => text.replaceAll(secret, "[REDACTED]") },
  );
  assert.ok(!renderSuiteListing(result).includes(secret));
});

test("the left-out line states the count it is given", () => {
  assert.notEqual(leftOutLine(3), leftOutLine(4));
  assert.ok(leftOutLine(12).includes("12"));
});
