/* The scope guard counts the grounding the prompt supplies. A structural signal that names symbols is an explored blast radius, so the symbol-by-symbol lookup is dropped and a regeneration may say the blast radius was explored. A signal of co-change files alone is no blast radius: it keeps the lookup, claims nothing explored and satisfies no reference to one, on a first pass and on a regeneration. A listing of the existing suite supplies the suite, so the read of it is dropped. A diff first pass states one effort, a ceiling of one spec file per affected flow that admits the no-op, and leaves the navigation of a live page to the working rules. Asserted on claims, providers, the declared effort text, the exported reference pattern and lint findings, never on prompt wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPromptAssembled,
  type AssembledPrompt,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import {
  EFFORT_TEXT,
  EFFORT_NO_OP_CLAUSE,
  EFFORT_PER_BEHAVIOUR,
} from "@contexts/generation/infrastructure/prompt-builders/task-builders.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import { ARTIFACT_REFERENCES } from "@contexts/generation/domain/prompt-artifact-references.ts";
import { PACK_HEADINGS } from "@contexts/generation/infrastructure/context-pack.ts";
import {
  claim,
  countDirectives,
  hasFloorLanguage,
  hasTrustLanguage,
  lintCell,
  type ClaimAction,
  type FactId,
  type LintSection,
  type PromptClaim,
} from "@contexts/generation/domain/prompt-contract-lint.ts";
import { hasSymbolBlocks, renderBlastRadiusSignal } from "@contexts/change-analysis/infrastructure/adapters/blast-radius-signal.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";

/* The roster is an input here: window budgets resolve from the roster fixture, never the deployable agents/opencode.json. */


/* A tiny diff: one file, one line. */
function mkInput(overrides: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/app",
    sha: "abc1234",
    diff: "diff --git a/src/app/cart/cart.service.ts b/src/app/cart/cart.service.ts\n+export function total() {}\n",
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234",
    mode: "diff",
    appName: "shop",
    baseUrl: "http://localhost:3000",
    intent: { type: "feat", breaking: false, message: "feat(cart): show the total", changedFiles: ["src/app/cart/cart.service.ts"] },
    ...overrides,
  };
}

/* The signals the real renderer draws, and the flag the real producer derives from the same input. */
const SYMBOLS = {
  impacted: [{ symbol: "CartService.total", file: "src/app/cart/cart.service.ts" }],
  callers: [{ symbol: "CartComponent.onTotal", file: "src/app/cart/cart.component.ts" }],
  coupled: [],
};
const CO_CHANGE = { impacted: [], callers: [], coupled: [{ file: "src/app/cart/cart.model.ts", couplingScore: 0.82, coChanges: 14 }] };

/* The enrichment the run attaches for a signal: the block, and the flag only when it is true. */
function signalOf(shape: typeof SYMBOLS | typeof CO_CHANGE): Partial<OpencodeRunInput> {
  return { staticSignal: renderBlastRadiusSignal(shape), ...(hasSymbolBlocks(shape) ? { staticSignalHasSymbols: true } : {}) };
}

const FIX = { fixCases: [{ name: "cart total", status: "fail" as const, detail: "boom" }] };

const claimsOf = (a: AssembledPrompt): PromptClaim[] => Object.values(a.claims).flat();

/* A section directs an orientation or a read towards the blast radius. */
const sendsToLookUpBlastRadius = (a: AssembledPrompt): boolean =>
  claimsOf(a).some((c) => c.kind === "directs" && (c.action === "orient" || c.action === "read") && c.target === "blast-radius");

/* A section directs a read of the fact. */
const directsRead = (a: AssembledPrompt, target: FactId): boolean =>
  claimsOf(a).some((c) => c.kind === "directs" && c.action === "read" && c.target === target);

const providersOf = (a: AssembledPrompt, fact: FactId): string[] =>
  Object.entries(a.claims)
    .filter(([, claims]) => claims.some((c) => c.kind === "provides" && c.fact === fact))
    .map(([id]) => id)
    .sort();

/* The words a prompt uses to say the blast radius was already explored, as the lint declares them. */
const EXPLORED_BLAST_RADIUS = ARTIFACT_REFERENCES.find((r) => r.artifact === "blast-radius")!.pattern;
const claimsExploredBlastRadius = (a: AssembledPrompt): boolean => EXPLORED_BLAST_RADIUS.test(a.text);

function sectionText(a: AssembledPrompt, id: string): string {
  const bytes = Buffer.from(a.text, "utf8");
  let offset = 0;
  for (const [sectionId, size] of Object.entries(a.sectionSizes)) {
    if (sectionId === id) return bytes.subarray(offset, offset + size).toString("utf8");
    offset += size + 1;
  }
  return "";
}

const lintSectionsOf = (a: AssembledPrompt): LintSection[] =>
  Object.keys(a.sectionSizes).map((id) => ({
    id,
    layer: "assembled" as const,
    text: sectionText(a, id),
    claims: a.claims[id] ?? [],
    ...(id === "diff" ? { verbatim: true } : {}),
  }));

const findingsOf = (a: AssembledPrompt, regen: boolean) =>
  lintCell({ name: "seeded", regen, sections: lintSectionsOf(a) }, { artifactReferences: ARTIFACT_REFERENCES });

test("a structural signal with symbol blocks stands for the blast radius on a first pass: nothing sends the agent to look it up, and the cell is clean", () => {
  const a = buildPromptAssembled(mkInput(signalOf(SYMBOLS)));
  assert.deepEqual(providersOf(a, "structural-signal"), ["static-signal"]);
  assert.deepEqual(providersOf(a, "co-change"), []);
  assert.equal(sendsToLookUpBlastRadius(a), false);
  assert.deepEqual(findingsOf(a, false), []);
});

test("the same prompt without a signal still sends the agent to look the blast radius up", () => {
  assert.equal(sendsToLookUpBlastRadius(buildPromptAssembled(mkInput())), true, "nothing supplied");
});

test("the lookup leaves the task's text as well as its claims: only a prompt that carries an explored blast radius has the shorter task", () => {
  const taskSize = (input: Partial<OpencodeRunInput>): number => buildPromptAssembled(mkInput(input)).sectionSizes["task"] ?? 0;
  const nothing = taskSize({});
  assert.ok(nothing > 0, "setup: the task is assembled");
  assert.equal(taskSize(signalOf(CO_CHANGE)), nothing, "co-change files change nothing in the task: the lookup stays");
  assert.ok(taskSize(signalOf(SYMBOLS)) < nothing, "a signal that names symbols drops the lookup from the text");
});

test("a structural signal with symbol blocks lets a regeneration say the blast radius was explored, and the signal is what backs the statement", () => {
  const a = buildPromptAssembled(mkInput({ ...FIX, ...signalOf(SYMBOLS) }));
  assert.equal(claimsExploredBlastRadius(a), true, "the regeneration section speaks of an explored blast radius");
  assert.deepEqual(providersOf(a, "structural-signal"), ["static-signal"]);
  assert.deepEqual(findingsOf(a, true), [], "the statement has its provider");
});

test("a co-change-only signal on a first pass keeps the lookup, provides co-change and claims no explored blast radius", () => {
  const a = buildPromptAssembled(mkInput(signalOf(CO_CHANGE)));
  assert.equal("staticSignalHasSymbols" in signalOf(CO_CHANGE), false, "setup: the producer sends no flag for co-change files alone");
  assert.equal(sendsToLookUpBlastRadius(a), true, "co-change files are no blast radius: the lookup stays");
  assert.deepEqual(providersOf(a, "co-change"), ["static-signal"]);
  assert.deepEqual(providersOf(a, "structural-signal"), [], "and it is not the structural signal");
  assert.equal(claimsExploredBlastRadius(a), false);
  assert.deepEqual(findingsOf(a, false), []);
});

test("a co-change-only signal on a regeneration claims no explored blast radius, and the cell is clean", () => {
  const a = buildPromptAssembled(mkInput({ ...FIX, ...signalOf(CO_CHANGE) }));
  assert.equal(claimsExploredBlastRadius(a), false, "no statement that the blast radius was explored");
  assert.deepEqual(providersOf(a, "co-change"), ["static-signal"]);
  assert.deepEqual(findingsOf(a, true), []);
});

test("a prompt that keeps the lookup does not title its co-change signal as a blast radius, so the words and the claims say the same thing", () => {
  const symbolsTitle = renderBlastRadiusSignal(SYMBOLS).split("\n")[0] ?? "";
  assert.ok(symbolsTitle.length > 0, "setup: the structural title");
  const symbols = buildPromptAssembled(mkInput(signalOf(SYMBOLS)));
  assert.equal(symbols.text.includes(symbolsTitle), true, "control: a signal that names symbols carries the structural title");
  assert.equal(sendsToLookUpBlastRadius(symbols), false);

  const coChange = buildPromptAssembled(mkInput(signalOf(CO_CHANGE)));
  assert.equal(coChange.text.includes(symbolsTitle), false, "a signal of co-change files alone does not");
  assert.equal(sendsToLookUpBlastRadius(coChange), true, "and the lookup stays");
  const regen = buildPromptAssembled(mkInput({ ...FIX, ...signalOf(CO_CHANGE) }));
  assert.equal(regen.text.includes(symbolsTitle), false, "on a regeneration as well");
});

test("a signal that arrives without the flag is read as co-change files alone: it never claims a blast radius it cannot prove", () => {
  const unflagged = mkInput({ staticSignal: renderBlastRadiusSignal(SYMBOLS) });
  const first = buildPromptAssembled(unflagged);
  assert.deepEqual(providersOf(first, "co-change"), ["static-signal"]);
  assert.deepEqual(providersOf(first, "structural-signal"), []);
  assert.equal(sendsToLookUpBlastRadius(first), true);
  assert.equal(claimsExploredBlastRadius(buildPromptAssembled({ ...unflagged, ...FIX })), false);
});

test("a flag with no signal behind it changes nothing: the prompt is the one without either", () => {
  const bare = buildPromptAssembled(mkInput());
  const flagged = buildPromptAssembled(mkInput({ staticSignalHasSymbols: true }));
  assert.equal(flagged.text, bare.text);
  assert.equal(sendsToLookUpBlastRadius(flagged), true);
});

test("with nothing supplied the lookup and the navigation directives are both present on a diff first pass", () => {
  const a = buildPromptAssembled(mkInput());
  assert.equal(sendsToLookUpBlastRadius(a), true, "the lookup");
  assert.ok(claimsOf(a).some((c) => c.kind === "directs" && c.action === "use-runtime-signals"), "the navigation of the live page");
  assert.deepEqual(findingsOf(a, false), []);
});

test("the structural signal changes only the lookup of a diff first pass, never a manual one", () => {
  for (const mode of ["manual"] as const) {
    const withSymbols = buildPromptAssembled(mkInput({ mode, guidance: "cover the cart", ...signalOf(SYMBOLS) }));
    const without = buildPromptAssembled(mkInput({ mode, guidance: "cover the cart" }));
    assert.equal(sendsToLookUpBlastRadius(withSymbols), sendsToLookUpBlastRadius(without), mode);
    assert.deepEqual(findingsOf(withSymbols, false), [], mode);
  }
});

/* ── the effort a diff's size asks for ── */

/* A diff of the given size: that many files with the lines on the first, and the changed files that go with it. */
function changeOf(files: number, lines: number): Partial<OpencodeRunInput> {
  const paths = Array.from({ length: files }, (_, i) => `src/app/cart/part${i}.ts`);
  const blocks = paths.map((path, i) =>
    [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1 +1 @@",
      ...(i === 0 ? Array.from({ length: lines }, (_, n) => `+const line${n} = ${n};`) : []),
    ].join("\n"),
  );
  return {
    diff: blocks.length > 0 ? `${blocks.join("\n")}\n` : "",
    intent: { type: "feat", breaking: false, message: "feat(cart): show the total", changedFiles: paths },
  };
}

/* Sizes from an empty diff to a wide one: the effort is the same for each. */
const SIZES: ReadonlyArray<[label: string, change: Partial<OpencodeRunInput>]> = [
  ["an empty diff", changeOf(0, 0)],
  ["one file, three lines", changeOf(1, 3)],
  ["two files, forty lines", changeOf(2, 40)],
  ["two files, forty-one lines", changeOf(2, 41)],
  ["nine files, one line", changeOf(9, 1)],
  ["twelve files, nine hundred lines", changeOf(12, 900)],
];

const taskOf = (a: AssembledPrompt): string => sectionText(a, "task");
const taskSizeOf = (input: Partial<OpencodeRunInput>): number => buildPromptAssembled(mkInput(input)).sectionSizes["task"] ?? 0;
/* The effort sentence of a task: the line the scope budget ends with. */
const effortLineOf = (a: AssembledPrompt): string => taskOf(a).split("\n").find((line) => line.startsWith("Expected effort")) ?? "";

const sectionsDirecting = (a: AssembledPrompt, action: ClaimAction): string[] =>
  Object.entries(a.claims)
    .filter(([, claims]) => claims.some((c) => c.kind === "directs" && c.action === action))
    .map(([id]) => id)
    .sort();

test("a diff's scope budget ends with one effort sentence, the same for a one-file change and a twelve-file one, and it names no tier", () => {
  const small = effortLineOf(buildPromptAssembled(mkInput(changeOf(1, 3))));
  const wide = effortLineOf(buildPromptAssembled(mkInput(changeOf(12, 900))));
  assert.notEqual(small, "", "setup: the task carries an effort sentence");
  assert.equal(small, wide);
  assert.doesNotMatch(small, /\b(?:tiny|focused|broad)\b/i);
});

test("the effort sentence bounds spec files by the affected flows, asks within each for a test per behaviour the change decides, and is a ceiling that admits the reasoned no-op with no figure, directive or trust word", () => {
  const text = effortLineOf(buildPromptAssembled(mkInput()));
  assert.match(text, /\bone spec file per affected flow\b/, "the bound counts spec files per flow, not tests and not a size");
  assert.ok(text.includes(EFFORT_PER_BEHAVIOUR), "a test per behaviour inside each spec");
  assert.ok(text.includes(EFFORT_NO_OP_CLAUSE), "the text says what the data declares, that doing nothing is within the bound");
  assert.equal(hasFloorLanguage(text), false, "the text states no minimum");
  assert.equal(countDirectives(text), 0, "no directive word");
  assert.equal(hasTrustLanguage(text), false, "no trust word");
  assert.doesNotMatch(text, /\d/, "no figure");
});

test("every size of diff carries the one effort sentence, with the same claims and directive count, and every cell is clean", () => {
  const reference = buildPromptAssembled(mkInput(changeOf(1, 1)));
  assert.ok((reference.claims["task"] ?? []).length > 0, "setup: the task declares claims");
  for (const [label, change] of SIZES) {
    const a = buildPromptAssembled(mkInput(change));
    assert.equal(effortLineOf(a), EFFORT_TEXT, `${label}: the one effort`);
    assert.deepEqual(a.claims["task"], reference.claims["task"], `${label}: the same claims`);
    assert.equal(countDirectives(taskOf(a)), countDirectives(taskOf(reference)), `${label}: the same directive count`);
    assert.deepEqual(findingsOf(a, false), [], `${label}: the lint reports nothing`);
  }
});

test("the files the run reports as changed and the diff's own file headers change the size sentence and leave the effort sentence alone", () => {
  const reported = Array.from({ length: 12 }, (_, i) => `src/app/cart/part${i}.ts`);
  const moreReportedThanShown = buildPromptAssembled(mkInput({ ...changeOf(1, 1), intent: { type: "feat", breaking: false, message: "feat(cart): show the total", changedFiles: reported } }));
  assert.ok(taskOf(moreReportedThanShown).includes("touches 12 files"), "the reported files decide the size sentence");
  const headersOnly = buildPromptAssembled(mkInput({ ...changeOf(9, 1), intent: undefined }));
  assert.ok(taskOf(headersOnly).includes("touches 9 files"), "the headers of the diff decide when none are reported");
  for (const a of [moreReportedThanShown, headersOnly]) assert.equal(effortLineOf(a), EFFORT_TEXT);
});

test("an empty diff carries the effort that admits doing nothing: no spec is asked for", () => {
  assert.ok(effortLineOf(buildPromptAssembled(mkInput(changeOf(0, 0)))).includes(EFFORT_NO_OP_CLAUSE));
});

test("a manual or context run and a regeneration state no effort sentence, however large the diff", () => {
  const others: ReadonlyArray<[string, Partial<OpencodeRunInput>]> = [
    ["manual", { mode: "manual", guidance: "cover the cart" }],
    ["context", { mode: "context" }],
    ["e2e regeneration", FIX],
  ];
  for (const [sizeLabel, change] of [SIZES[1]!, SIZES[5]!]) {
    assert.ok(buildPromptAssembled(mkInput(change)).text.includes(EFFORT_TEXT), `${sizeLabel}: the diff first pass carries it`);
    for (const [label, shape] of others) {
      assert.equal(buildPromptAssembled(mkInput({ ...change, ...shape })).text.includes(EFFORT_TEXT), false, `${label} with ${sizeLabel}`);
    }
  }
});

/* ── where the live page is navigated ── */

test("with no pack DOM and no tree, the working rules alone direct the agent to navigate and snapshot the live page, and the task never does", () => {
  const a = buildPromptAssembled(mkInput());
  assert.deepEqual(sectionsDirecting(a, "use-runtime-signals"), ["working-rules"]);
  const rules = sectionText(a, "working-rules");
  for (const tool of ["browser_navigate", "browser_snapshot"]) {
    assert.ok(rules.includes(tool), `the working rules name ${tool}`);
    assert.equal(taskOf(a).includes(tool), false, `the task does not name ${tool}`);
  }
  assert.deepEqual(findingsOf(a, false), []);
});

test("with a pack DOM or a captured tree, a diff directs no navigation of the live page, keeps its task, and the cell is clean", () => {
  const withDom = { contextPack: `## ${PACK_HEADINGS.pack}\n\n### ${PACK_HEADINGS.liveDom} (x)\n  heading: Cart` };
  const withTree = { domSnapshot: "  heading: Cart\n  button: Apply" };
  const bare = taskSizeOf({});
  assert.ok(bare > 0, "setup: the task is assembled");
  for (const [label, extra] of [["a pack with a live DOM", withDom], ["a captured tree", withTree]] as const) {
    const a = buildPromptAssembled(mkInput(extra));
    assert.deepEqual(sectionsDirecting(a, "use-runtime-signals"), [], label);
    assert.deepEqual(findingsOf(a, false), [], label);
    assert.equal(taskSizeOf(extra), bare, `${label}: the scope bound is in the task of every diff cell, whatever grounding the prompt carries`);
    assert.deepEqual(a.claims["working-rules"], [claim.directs("use-browser-for-uncovered-route")], `${label}: the working rules keep the way out for a route the grounding does not cover`);
  }
});

/* ── the read of the existing suite ── */

const LISTING = ["flows/cart.spec.ts", "flows/login.spec.ts — flow: login, objective: the user signs in"];

test("a diff first pass sends the agent to the existing specs only when no listing supplies the suite, in its claims and in its text", () => {
  const unlisted = buildPromptAssembled(mkInput());
  assert.equal(directsRead(unlisted, "existing-suite"), true, "no listing: the task reads the existing specs");
  assert.deepEqual(providersOf(unlisted, "existing-suite"), []);
  assert.deepEqual(findingsOf(unlisted, false), []);

  for (const listing of [LISTING.slice(0, 1), LISTING]) {
    const listed = buildPromptAssembled(mkInput({ existingSpecFiles: listing }));
    assert.equal(directsRead(listed, "existing-suite"), false, `${listing.length} listed: the listing supplies the suite, so no read`);
    assert.deepEqual(providersOf(listed, "existing-suite"), ["existing-suite-manifest"]);
    assert.deepEqual(findingsOf(listed, false), [], `${listing.length} listed: nothing directs a read of a fact the prompt provides`);
    assert.ok((listed.sectionSizes["task"] ?? 0) < (unlisted.sectionSizes["task"] ?? 0), `${listing.length} listed: the read leaves the task's text with its claim`);
  }
  assert.equal(taskSizeOf({ existingSpecFiles: LISTING.slice(0, 1) }), taskSizeOf({ existingSpecFiles: LISTING }), "the task does not repeat what the listing carries");
});

test("an empty listing supplies no suite: a diff first pass still reads the existing specs", () => {
  const empty = buildPromptAssembled(mkInput({ existingSpecFiles: [] }));
  assert.equal(directsRead(empty, "existing-suite"), true);
  assert.equal(taskSizeOf({ existingSpecFiles: [] }), taskSizeOf({}));
});

test("no regeneration and no other mode gains a read of the existing specs from the diff first pass's scope budget", () => {
  for (const [label, extra] of [["e2e regeneration", FIX]] as const) {
    assert.equal(directsRead(buildPromptAssembled(mkInput(extra)), "existing-suite"), false, label);
  }
});
