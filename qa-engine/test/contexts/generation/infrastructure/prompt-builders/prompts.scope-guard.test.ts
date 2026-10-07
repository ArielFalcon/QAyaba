/* The scope guard counts the grounding the prompt supplies. A structural signal that names symbols is an explored blast radius, so the symbol-by-symbol lookup is dropped and a regeneration may say the blast radius was explored. A signal of co-change files alone is no blast radius: it keeps the lookup, claims nothing explored and satisfies no reference to one, on a first pass and on a regeneration. A listing of the existing suite supplies the suite, so the read of it is dropped. A diff first pass states the effort its size asks for as a ceiling that admits the no-op, and leaves the navigation of a live page to the working rules. Asserted on claims, providers, the declared effort data, the exported reference pattern and lint findings, never on prompt wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EFFORT_BY_TIER,
  EFFORT_NO_OP_CLAUSE,
  buildPromptAssembled,
  setExplorationBriefCollaborators,
  type AssembledPrompt,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import { ARTIFACT_REFERENCES } from "@contexts/generation/domain/prompt-artifact-references.ts";
import { DIFF_TIER_NAMES, DIFF_TIERS, type DiffTier } from "@contexts/generation/domain/diff-stat.ts";
import { PACK_HEADINGS } from "@contexts/generation/infrastructure/context-pack.ts";
import {
  countDirectives,
  hasTrustLanguage,
  lintCell,
  type ClaimAction,
  type FactId,
  type LintSection,
  type PromptClaim,
} from "@contexts/generation/domain/prompt-contract-lint.ts";
import { hasSymbolBlocks, renderBlastRadiusSignal } from "@contexts/qa-run-orchestration/infrastructure/bridges/blast-radius-signal.ts";
import type { OpencodeRunInput, ExplorationBrief } from "@contexts/generation/application/ports/generation-ports.ts";

setExplorationBriefCollaborators({
  parseExplorationBrief: () => null,
  coerceExplorationBrief: () => null,
  renderExplorationBrief: (brief: ExplorationBrief) => `## ${PROMPT_HEADINGS.explorationBrief}\nObjective: ${brief.objective}`,
});

/* A tiny diff: one file, one line. */
function mkInput(overrides: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/app",
    sha: "abc1234",
    diff: "diff --git a/src/app/cart/cart.service.ts b/src/app/cart/cart.service.ts\n+export function total() {}\n",
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234",
    needsReview: false,
    target: "e2e",
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
const BRIEF: ExplorationBrief = {
  builtForSha: "abc1234",
  objective: "the total shows",
  blastRadius: [{ symbol: "CartService.total", file: "src/app/cart/cart.service.ts", role: "computes the total" }],
};

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

test("the same prompt without a signal, or with a brief that distilled no blast radius, still sends the agent to look the blast radius up", () => {
  assert.equal(sendsToLookUpBlastRadius(buildPromptAssembled(mkInput())), true, "nothing supplied");
  assert.equal(sendsToLookUpBlastRadius(buildPromptAssembled(mkInput({ contextBrief: { ...BRIEF, blastRadius: [] } }))), true, "an empty brief supplies none");
  assert.equal(sendsToLookUpBlastRadius(buildPromptAssembled(mkInput({ contextBrief: BRIEF }))), false, "a brief with one supplies it");
});

test("the lookup leaves the task's text as well as its claims: only a prompt that carries an explored blast radius has the shorter task", () => {
  const taskSize = (input: Partial<OpencodeRunInput>): number => buildPromptAssembled(mkInput(input)).sectionSizes["task"] ?? 0;
  const nothing = taskSize({});
  assert.ok(nothing > 0, "setup: the task is assembled");
  assert.equal(taskSize(signalOf(CO_CHANGE)), nothing, "co-change files change nothing in the task: the lookup stays");
  assert.ok(taskSize(signalOf(SYMBOLS)) < nothing, "a signal that names symbols drops the lookup from the text");
  assert.equal(taskSize(signalOf(SYMBOLS)), taskSize({ contextBrief: BRIEF }), "a brief with a blast radius drops exactly the same text");
  assert.equal(taskSize({ contextBrief: { ...BRIEF, blastRadius: [] } }), nothing, "a brief with none drops nothing");
});

test("a structural signal with symbol blocks lets a regeneration say the blast radius was explored, and the signal is what backs the statement", () => {
  for (const [label, base] of [["e2e", {}], ["code", { target: "code" as const }]] as const) {
    const a = buildPromptAssembled(mkInput({ ...base, ...FIX, ...signalOf(SYMBOLS) }));
    assert.equal(claimsExploredBlastRadius(a), true, `${label}: the regeneration section speaks of an explored blast radius`);
    assert.deepEqual(providersOf(a, "structural-signal"), ["static-signal"], label);
    assert.deepEqual(findingsOf(a, true), [], `${label}: the statement has its provider`);
  }
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
  for (const [label, base] of [["e2e", {}], ["code", { target: "code" as const }]] as const) {
    const a = buildPromptAssembled(mkInput({ ...base, ...FIX, ...signalOf(CO_CHANGE) }));
    assert.equal(claimsExploredBlastRadius(a), false, `${label}: no statement that the blast radius was explored`);
    assert.deepEqual(providersOf(a, "co-change"), ["static-signal"], label);
    assert.deepEqual(findingsOf(a, true), [], label);
  }
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

test("a brief that carries a blast radius still owns it: the signal is not rendered, and a regeneration is grounded by the brief alone", () => {
  const first = buildPromptAssembled(mkInput({ contextBrief: BRIEF, ...signalOf(SYMBOLS) }));
  assert.equal(first.sectionSizes["static-signal"], undefined);
  assert.deepEqual(providersOf(first, "structural-signal"), []);
  const regen = buildPromptAssembled(mkInput({ contextBrief: BRIEF, ...FIX, ...signalOf(SYMBOLS) }));
  assert.equal(claimsExploredBlastRadius(regen), true);
  assert.deepEqual(findingsOf(regen, true), []);
});

test("with nothing supplied the lookup and the navigation directives are both present on a diff first pass", () => {
  const a = buildPromptAssembled(mkInput());
  assert.equal(sendsToLookUpBlastRadius(a), true, "the lookup");
  assert.ok(claimsOf(a).some((c) => c.kind === "directs" && c.action === "use-runtime-signals"), "the navigation of the live page");
  assert.deepEqual(findingsOf(a, false), []);
});

test("the structural signal changes only the lookup of a diff first pass, never a complete, exhaustive or manual one", () => {
  for (const mode of ["complete", "exhaustive", "manual"] as const) {
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

const { tiny: TINY_LIMITS, focused: FOCUSED_LIMITS } = DIFF_TIERS;

/* Sizes at and around each limit, and the tier each belongs to. */
const SIZES: ReadonlyArray<[label: string, tier: DiffTier, change: Partial<OpencodeRunInput>]> = [
  ["an empty diff", "tiny", changeOf(0, 0)],
  ["a diff at both tiny limits", "tiny", changeOf(TINY_LIMITS.maxFiles, TINY_LIMITS.maxLines)],
  ["one file past the tiny limit", "focused", changeOf(TINY_LIMITS.maxFiles + 1, 1)],
  ["one line past the tiny limit", "focused", changeOf(1, TINY_LIMITS.maxLines + 1)],
  ["a diff at both focused limits", "focused", changeOf(FOCUSED_LIMITS.maxFiles, FOCUSED_LIMITS.maxLines)],
  ["one file past the focused limit", "broad", changeOf(FOCUSED_LIMITS.maxFiles + 1, 1)],
  ["one line past the focused limit", "broad", changeOf(1, FOCUSED_LIMITS.maxLines + 1)],
];

const taskOf = (a: AssembledPrompt): string => sectionText(a, "task");
const taskSizeOf = (input: Partial<OpencodeRunInput>): number => buildPromptAssembled(mkInput(input)).sectionSizes["task"] ?? 0;

const sectionsDirecting = (a: AssembledPrompt, action: ClaimAction): string[] =>
  Object.entries(a.claims)
    .filter(([, claims]) => claims.some((c) => c.kind === "directs" && c.action === action))
    .map(([id]) => id)
    .sort();

/* A minimum, in the words a text uses to state one. */
const FLOOR_WORDS = /\b(?:at least|minimum|no fewer|no less|not fewer|not less)\b/i;

test("every tier declares its effort as a ceiling that admits the reasoned no-op, in a text with no figure, no directive word and no trust word", () => {
  assert.ok(DIFF_TIER_NAMES.length > 0, "setup: the tiers are declared");
  for (const tier of DIFF_TIER_NAMES) {
    const effort = EFFORT_BY_TIER[tier];
    assert.ok(Number.isInteger(effort.upperBound.specs) && effort.upperBound.specs > 0, `${tier}: an upper bound`);
    assert.equal(effort.admitsNoOp, true, `${tier}: deciding that nothing is worth a test is within the bound`);
    assert.ok(effort.text.includes(EFFORT_NO_OP_CLAUSE), `${tier}: the text says what the data declares, that doing nothing is within the bound`);
    assert.doesNotMatch(effort.text, FLOOR_WORDS, `${tier}: the text states no minimum`);
    assert.equal(countDirectives(effort.text), 0, `${tier}: no directive word`);
    assert.equal(hasTrustLanguage(effort.text), false, `${tier}: no trust word`);
    assert.doesNotMatch(effort.text, /\d/, `${tier}: no figure`);
  }
  assert.equal(new Set(DIFF_TIER_NAMES.map((tier) => EFFORT_BY_TIER[tier].text)).size, DIFF_TIER_NAMES.length, "each tier says something of its own");
});

test("a diff's task carries the effort of its own tier at, below and above each limit, and no other tier's, and every cell is clean", () => {
  for (const [label, tier, change] of SIZES) {
    const a = buildPromptAssembled(mkInput(change));
    const task = taskOf(a);
    for (const other of DIFF_TIER_NAMES) {
      assert.equal(task.includes(EFFORT_BY_TIER[other].text), other === tier, `${label}: the ${other} effort is ${other === tier ? "" : "not "}carried`);
    }
    assert.deepEqual(findingsOf(a, false), [], `${label}: the lint reports nothing`);
  }
});

test("the tier follows the files the run reports as changed, and the diff's own file headers when it reports none", () => {
  const oneHeader = changeOf(1, 1);
  const reported = Array.from({ length: TINY_LIMITS.maxFiles + 1 }, (_, i) => `src/app/cart/part${i}.ts`);
  const moreReportedThanShown = buildPromptAssembled(mkInput({ ...oneHeader, intent: { type: "feat", breaking: false, message: "feat(cart): show the total", changedFiles: reported } }));
  assert.ok(taskOf(moreReportedThanShown).includes(EFFORT_BY_TIER.focused.text), "the reported files decide, not the one header the diff shows");

  const headersOnly = changeOf(TINY_LIMITS.maxFiles + 1, 1);
  for (const intent of [undefined, { type: "feat" as const, breaking: false, message: "feat(cart): show the total", changedFiles: [] }]) {
    const a = buildPromptAssembled(mkInput({ ...headersOnly, intent }));
    assert.ok(taskOf(a).includes(EFFORT_BY_TIER.focused.text), `${intent === undefined ? "no intent" : "no files reported"}: the headers of the diff decide`);
  }
});

test("an empty diff is stated as a tiny change whose effort admits doing nothing: no spec is asked for", () => {
  const task = taskOf(buildPromptAssembled(mkInput(changeOf(0, 0))));
  assert.ok(task.includes(EFFORT_BY_TIER.tiny.text));
  assert.equal(EFFORT_BY_TIER.tiny.admitsNoOp, true);
});

test("the effort line adds no claim and no directive word: the task declares and counts the same for every tier", () => {
  const tinyTask = buildPromptAssembled(mkInput(changeOf(1, 1)));
  assert.ok((tinyTask.claims["task"] ?? []).length > 0, "setup: the task declares claims");
  for (const [label, , change] of SIZES) {
    const a = buildPromptAssembled(mkInput(change));
    assert.deepEqual(a.claims["task"], tinyTask.claims["task"], `${label}: the same claims`);
    assert.equal(countDirectives(taskOf(a)), countDirectives(taskOf(tinyTask)), `${label}: the same directive count`);
  }
});

test("a complete, exhaustive, manual or context run, a code run and a regeneration state no effort tier, however large the diff", () => {
  const texts = DIFF_TIER_NAMES.map((tier) => EFFORT_BY_TIER[tier].text);
  const others: ReadonlyArray<[string, Partial<OpencodeRunInput>]> = [
    ["complete", { mode: "complete" }],
    ["exhaustive", { mode: "exhaustive" }],
    ["manual", { mode: "manual", guidance: "cover the cart" }],
    ["context", { mode: "context" }],
    ["code first pass", { target: "code" }],
    ["code regeneration", { target: "code", ...FIX }],
    ["e2e regeneration", FIX],
  ];
  for (const [sizeLabel, , change] of [SIZES[1]!, SIZES[6]!]) {
    assert.ok(
      texts.some((text) => buildPromptAssembled(mkInput(change)).text.includes(text)),
      `${sizeLabel}: the diff first pass carries one`,
    );
    for (const [label, shape] of others) {
      const a = buildPromptAssembled(mkInput({ ...change, ...shape }));
      for (const text of texts) assert.equal(a.text.includes(text), false, `${label} with ${sizeLabel}`);
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
    assert.match(sectionText(a, "working-rules"), /Playwright\s+MCP/, `${label}: the working rules keep the way out for a route the grounding does not cover`);
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

test("an empty listing supplies no suite: a diff first pass still reads the existing specs, and a code run never declares that read", () => {
  const empty = buildPromptAssembled(mkInput({ existingSpecFiles: [] }));
  assert.equal(directsRead(empty, "existing-suite"), true);
  assert.equal(taskSizeOf({ existingSpecFiles: [] }), taskSizeOf({}));
  assert.equal(directsRead(buildPromptAssembled(mkInput({ target: "code" })), "existing-suite"), false);
});

test("no regeneration and no other mode gains a read of the existing specs from the diff first pass's scope budget", () => {
  for (const [label, extra] of [["e2e regeneration", FIX], ["complete", { mode: "complete" as const }], ["exhaustive", { mode: "exhaustive" as const }]] as const) {
    assert.equal(directsRead(buildPromptAssembled(mkInput(extra)), "existing-suite"), false, label);
  }
});
