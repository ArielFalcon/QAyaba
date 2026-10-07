/* The scope guard counts the grounding the prompt supplies. A structural signal that names symbols is an explored blast radius, so the symbol-by-symbol lookup is dropped and a regeneration may say the blast radius was explored. A signal of co-change files alone is no blast radius: it keeps the lookup, claims nothing explored and satisfies no reference to one, on a first pass and on a regeneration. Asserted on claims, providers, the exported reference pattern and lint findings, never on prompt wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPromptAssembled,
  setExplorationBriefCollaborators,
  type AssembledPrompt,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import { ARTIFACT_REFERENCES } from "@contexts/generation/domain/prompt-artifact-references.ts";
import { lintCell, type FactId, type LintSection, type PromptClaim } from "@contexts/generation/domain/prompt-contract-lint.ts";
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
