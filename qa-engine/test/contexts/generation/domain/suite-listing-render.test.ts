import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSuiteListing, LISTING_MAX_DO_NOT_REWRITE, LISTING_MAX_UNNAMED_EDITABLE, type SuiteListing, type SuiteListingInput } from "@contexts/generation/domain/suite-listing.ts";
import { everyDeliveredLine, leftOutLine, renderSuiteListing, suiteListingHead, PLAIN_LISTING_NOTE } from "@contexts/generation/domain/suite-listing-render.ts";
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

test("the do-not-rewrite entries end with the count of those the cap leaves out, and every editable entry a signal names is written however many there are", () => {
  const existing = Array.from({ length: LISTING_MAX_DO_NOT_REWRITE + 5 }, (_, index) => `suite/s${String(index).padStart(3, "0")}.spec.ts`);
  const delivered = Array.from({ length: LISTING_MAX_DO_NOT_REWRITE + 3 }, (_, index) => ({ file: `mine/m${String(index).padStart(3, "0")}.spec.ts` }));
  const result = listing({ existing, delivered, fixCases: delivered.map((spec) => failing(spec.file)) });
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
  const result = listing({ delivered: [A, B], fixCases: [failing("flows/a.spec.ts"), failing("flows/b.spec.ts")] });
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

/* ── the specs only the fallback made editable ── */

const COVERAGE = { coverageGap: "src/cart.ts: lines 10-14" };
const UNNAMED_CORRECTION = ["the checkout flow asserts nothing at all"];
const deliveredOf = (count: number) => Array.from({ length: count }, (_, index) => ({ file: `mine/m${String(index).padStart(3, "0")}.spec.ts` }));
const suiteOf = (count: number) => Array.from({ length: count }, (_, index) => `suite/s${String(index).padStart(3, "0")}.spec.ts`);

test("the count of the summary line is the count it is given", () => {
  assert.notEqual(everyDeliveredLine(3), everyDeliveredLine(4));
  assert.ok(everyDeliveredLine(12).includes("12"));
});

test("a turn that could not say which spec to change states once that every spec this run delivered is editable, then lists them", () => {
  const result = listing({ existing: [C_LINE], delivered: [A, B], reviewCorrections: UNNAMED_CORRECTION });
  assert.deepEqual(lines(renderSuiteListing(result)), [
    `## ${PROMPT_HEADINGS.existingSuiteManifest} (3 spec file(s))`,
    SUITE_LISTING_LABELS.editable,
    everyDeliveredLine(2),
    ...result.unnamed.map((entry) => bullet(entry.text)),
    SUITE_LISTING_LABELS.doNotRewrite,
    ...result.doNotRewrite.map((entry) => bullet(entry.text)),
  ]);
  assert.equal(result.unnamed.length, 2);
  assert.equal(result.doNotRewrite.length, 1);
});

test("the specs a signal names come first and in full, and the summary of the others follows them", () => {
  const result = listing({ existing: [C_LINE], delivered: [A, B], reviewCorrections: ["flows/c.spec.ts: weak assertion", ...UNNAMED_CORRECTION] });
  assert.deepEqual(lines(renderSuiteListing(result)), [
    `## ${PROMPT_HEADINGS.existingSuiteManifest} (3 spec file(s))`,
    SUITE_LISTING_LABELS.editable,
    bullet(C_LINE),
    everyDeliveredLine(2),
    ...result.unnamed.map((entry) => bullet(entry.text)),
  ]);
});

test("the specs only the fallback added are listed up to the cap and the rest are counted, ahead of the do-not-rewrite group, which is capped on its own", () => {
  const delivered = deliveredOf(LISTING_MAX_UNNAMED_EDITABLE + 7);
  const result = listing({ existing: suiteOf(LISTING_MAX_DO_NOT_REWRITE + 4), delivered, reviewCorrections: UNNAMED_CORRECTION });
  assert.equal(result.unnamedLeftOut, 7);
  assert.equal(result.leftOut, 4);
  const written = lines(renderSuiteListing(result));
  const summaryAt = written.indexOf(everyDeliveredLine(delivered.length));
  const doNotRewriteAt = written.indexOf(SUITE_LISTING_LABELS.doNotRewrite);
  assert.ok(summaryAt > 0 && summaryAt < doNotRewriteAt, "the summary is in the editable group");
  assert.deepEqual(written.slice(summaryAt + 1, doNotRewriteAt), [...result.unnamed.map((entry) => bullet(entry.text)), leftOutLine(7)]);
  assert.equal(result.unnamed.length, LISTING_MAX_UNNAMED_EDITABLE);
  assert.deepEqual(written.slice(doNotRewriteAt + 1), [...result.doNotRewrite.map((entry) => bullet(entry.text)), leftOutLine(4)]);
});

test("nothing is counted as left out of the unnamed group when the cap leaves nothing out of it", () => {
  const result = listing({ delivered: deliveredOf(LISTING_MAX_UNNAMED_EDITABLE), reviewCorrections: UNNAMED_CORRECTION });
  assert.equal(result.unnamedLeftOut, 0);
  assert.ok(!lines(renderSuiteListing(result)).some((line) => line.startsWith("(+")));
});

test("the summary counts the files under it, those it lists and those it leaves out, and not the ones a signal named above", () => {
  const delivered = deliveredOf(LISTING_MAX_UNNAMED_EDITABLE + 10);
  const result = listing({ delivered, reviewCorrections: [`${delivered.at(-1)!.file}: weak assertion`, ...UNNAMED_CORRECTION] });
  const written = lines(renderSuiteListing(result));
  assert.ok(written.includes(everyDeliveredLine(delivered.length - 1)));
  assert.ok(written.includes(leftOutLine(10 - 1)));
  assert.equal(written.filter((line) => line.includes(delivered.at(-1)!.file)).length, 1, "the named spec is written once, among the named");
});

test("a coverage turn states once that it may add a spec of its own, between the editable group and the do-not-rewrite group", () => {
  const result = listing({ existing: [C_LINE, "d.spec.ts"], delivered: [A, B], ...COVERAGE });
  assert.equal(result.mayAddSpec, true);
  assert.deepEqual(lines(renderSuiteListing(result)), [
    `## ${PROMPT_HEADINGS.existingSuiteManifest} (4 spec file(s))`,
    SUITE_LISTING_LABELS.editable,
    everyDeliveredLine(2),
    ...result.unnamed.map((entry) => bullet(entry.text)),
    SUITE_LISTING_LABELS.newSpec,
    SUITE_LISTING_LABELS.doNotRewrite,
    ...result.doNotRewrite.map((entry) => bullet(entry.text)),
  ]);
});

test("a coverage turn with a capped unnamed group states the new-spec allowance after the count left out", () => {
  const result = listing({ existing: suiteOf(3), delivered: deliveredOf(LISTING_MAX_UNNAMED_EDITABLE + 2), ...COVERAGE });
  const written = lines(renderSuiteListing(result));
  const allowanceAt = written.indexOf(SUITE_LISTING_LABELS.newSpec);
  assert.equal(written[allowanceAt - 1], leftOutLine(2));
  assert.equal(written[allowanceAt + 1], SUITE_LISTING_LABELS.doNotRewrite);
});

test("a coverage turn whose every spec is editable writes the allowance last, with no do-not-rewrite label", () => {
  const result = listing({ delivered: [A, B], ...COVERAGE });
  assert.equal(result.doNotRewrite.length, 0);
  assert.equal(lines(renderSuiteListing(result)).at(-1), SUITE_LISTING_LABELS.newSpec);
});

test("no turn but a coverage turn writes that it may add a spec", () => {
  const turns: Record<string, SuiteListingInput> = {
    "a FixLoop turn": { fixCases: [failing("flows/a.spec.ts")] },
    "a reviewer correction naming a spec": { reviewCorrections: ["flows/a.spec.ts: weak assertion"] },
    "a reviewer correction naming none": { reviewCorrections: UNNAMED_CORRECTION },
    "a selector contradiction attributed to a spec": { selectorContradictions: ["a selector the page does not have"], attributedSpecFiles: ["flows/a.spec.ts"] },
    "a selector contradiction attributed to none": { selectorContradictions: ["a selector the page does not have"] },
    "a fix beside a coverage gap": { fixCases: [failing("flows/a.spec.ts")], ...COVERAGE },
  };
  for (const [what, signal] of Object.entries(turns)) {
    assert.ok(!lines(renderSuiteListing(listing({ existing: [C_LINE], delivered: [A, B], ...signal }))).includes(SUITE_LISTING_LABELS.newSpec), what);
  }
});

test("a coverage turn that delivered nothing keeps the plain list: the allowance belongs to the groups, which that turn does not have", () => {
  const existing = [C_LINE, "d.spec.ts"];
  const result = listing({ existing, ...COVERAGE });
  assert.equal(result.mayAddSpec, true);
  assert.equal(renderSuiteListing(result), renderSuiteListing(listing({ existing })));
});

test("however many specs there are, the section lists at most the cap's worth of each group the fallback and the do-not-rewrite entries make", () => {
  const result = listing({ existing: suiteOf(3 * LISTING_MAX_DO_NOT_REWRITE), delivered: deliveredOf(3 * LISTING_MAX_UNNAMED_EDITABLE), ...COVERAGE });
  const written = lines(renderSuiteListing(result));
  assert.equal(written.filter((line) => line.startsWith("- ")).length, LISTING_MAX_UNNAMED_EDITABLE + LISTING_MAX_DO_NOT_REWRITE);
  assert.equal(written.filter((line) => line.startsWith("(+")).length, 2);
  assert.equal(written.length, 1 + 1 + 1 + LISTING_MAX_UNNAMED_EDITABLE + 1 + 1 + 1 + LISTING_MAX_DO_NOT_REWRITE + 1, "the title, the label, the summary, the entries, the count, the allowance, the label, the entries, the count");
});

test("the label of each group and the summary and the allowance are each written once, so each can be told from the entries under it", () => {
  const text = renderSuiteListing(listing({ existing: [C_LINE], delivered: [A, B], ...COVERAGE }));
  for (const line of [SUITE_LISTING_LABELS.editable, SUITE_LISTING_LABELS.doNotRewrite, SUITE_LISTING_LABELS.newSpec, everyDeliveredLine(2)]) {
    assert.equal(text.split(line).length - 1, 1, line);
  }
});

test("the head of the section is what a cut from its end must leave standing: the title, the label, the named entries and the summary", () => {
  const unnamed = listing({ existing: [C_LINE], delivered: [A, B], ...COVERAGE });
  assert.equal(
    suiteListingHead(unnamed),
    [`## ${PROMPT_HEADINGS.existingSuiteManifest} (3 spec file(s))`, SUITE_LISTING_LABELS.editable, everyDeliveredLine(2)].join("\n"),
  );
  const named = listing({ existing: [C_LINE], delivered: [A, B], fixCases: [failing("flows/a.spec.ts"), failing("flows/c.spec.ts")] });
  assert.equal(
    suiteListingHead(named),
    [`## ${PROMPT_HEADINGS.existingSuiteManifest} (3 spec file(s))`, SUITE_LISTING_LABELS.editable, ...named.named.map((entry) => bullet(entry.text))].join("\n"),
  );
  const mixed = listing({ existing: [C_LINE], delivered: [A, B], reviewCorrections: ["flows/c.spec.ts: weak assertion", ...UNNAMED_CORRECTION] });
  assert.deepEqual(lines(suiteListingHead(mixed)), [
    `## ${PROMPT_HEADINGS.existingSuiteManifest} (3 spec file(s))`,
    SUITE_LISTING_LABELS.editable,
    bullet(C_LINE),
    everyDeliveredLine(2),
  ]);
});

test("the head is the start of the section in every shape, and the plain list and the empty listing have the heads they have", () => {
  const shapes: SuiteListingInput[] = [
    { existing: [C_LINE], delivered: [A, B], ...COVERAGE },
    { existing: [C_LINE], delivered: [A, B], fixCases: [failing("flows/a.spec.ts")] },
    { existing: [C_LINE, "d.spec.ts"], delivered: [A, B], reviewCorrections: ["flows/c.spec.ts: weak assertion", ...UNNAMED_CORRECTION] },
    { existing: suiteOf(LISTING_MAX_DO_NOT_REWRITE + 3), delivered: deliveredOf(LISTING_MAX_UNNAMED_EDITABLE + 3), ...COVERAGE },
    { existing: [C_LINE, "d.spec.ts"], delivered: [A] },
    { existing: [C_LINE], ...COVERAGE },
  ];
  for (const shape of shapes) {
    const result = listing(shape);
    assert.ok(renderSuiteListing(result).startsWith(suiteListingHead(result)), JSON.stringify(Object.keys(shape)));
    assert.ok(suiteListingHead(result).length > 0);
  }
  const plain = listing({ existing: [C_LINE, "d.spec.ts"] });
  assert.equal(suiteListingHead(plain), `## ${PROMPT_HEADINGS.existingSuiteManifest} (2 spec file(s)${PLAIN_LISTING_NOTE})`, "the title and its note: the plain list is one thing");
  assert.equal(suiteListingHead(listing({})), "");
});

test("a cut of the section from its end takes the do-not-rewrite group first, then the unnamed entries, and leaves the label and the summary for last", () => {
  const result = listing({ existing: suiteOf(LISTING_MAX_DO_NOT_REWRITE), delivered: deliveredOf(LISTING_MAX_UNNAMED_EDITABLE), ...COVERAGE });
  const written = lines(renderSuiteListing(result));
  const at = (line: string): number => written.indexOf(line);
  assert.ok(at(SUITE_LISTING_LABELS.editable) < at(everyDeliveredLine(LISTING_MAX_UNNAMED_EDITABLE)));
  assert.ok(at(everyDeliveredLine(LISTING_MAX_UNNAMED_EDITABLE)) < at(`- ${result.unnamed[0]!.text}`));
  assert.ok(at(`- ${result.unnamed.at(-1)!.text}`) < at(SUITE_LISTING_LABELS.newSpec));
  assert.ok(at(SUITE_LISTING_LABELS.newSpec) < at(SUITE_LISTING_LABELS.doNotRewrite));
  assert.ok(at(SUITE_LISTING_LABELS.doNotRewrite) < at(`- ${result.doNotRewrite[0]!.text}`));
});
