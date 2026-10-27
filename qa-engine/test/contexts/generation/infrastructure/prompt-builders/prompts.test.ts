import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  buildPrompt,
  buildPromptAssembled,
  buildReviewerPrompt,
  buildReviewerPromptAssembled,
  PROMPT_HEADINGS,
  type AssembledPrompt,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { buildContextTask } from "@contexts/generation/infrastructure/prompt-builders/task-builders.ts";
import {
  BACKEND_TO_BACKEND_LABEL,
  CONTRACT_DRIFT_HEADING,
  HTTP_UNKNOWN_LABEL,
  IMPACTED_MARKER_PREFIX,
  SETTLE_LABELS,
  describeResultCount,
  describeSettle,
  impactedMarker,
  renderFixCase,
} from "@contexts/generation/infrastructure/prompt-builders/generator-renderers.ts";
import { renderReviewSpecs } from "@contexts/generation/infrastructure/prompt-builders/review-render.ts";
import { MAP_ITEMS_SAFETY_BOUND, renderArchitectureContextParts } from "@contexts/generation/infrastructure/prompt-builders/architecture-context.ts";
import { assemble as caAssemble, section as caSection } from "@contexts/generation/infrastructure/prompt-builders/context-assembler.ts";
import { assemblerBudgetBytes } from "@kernel/context-budget.ts";
import { PACK_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import {
  APP_LOGIN_SECTION_ID,
  claim,
  type ClaimAction,
  type FactId,
  type PromptClaim,
} from "@contexts/generation/domain/prompt-contract-lint.ts";
import {
  REVIEWER_PROMPT_VERSION,
  REVIEW_CORRECTIONS_MAX,
  REVIEW_CORRECTION_CLASSES,
  REVIEW_CORRECTION_MAX_CHARS,
  REVIEW_RATIONALE_MAX_CHARS,
} from "@contexts/generation/domain/review-output.ts";
import { SUITE_LISTING_SECTION_ID } from "@contexts/generation/infrastructure/prompt-builders/generator-sections.ts";
import { itemId } from "@kernel/context-item-ids.ts";
import { REDACTED } from "@kernel/ports/redaction.port.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import type { ReviewInput, ArchitectureContext } from "@contexts/generation/domain/generation-input.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { BUILT_IN_EXEMPLARS } from "@kernel/scenario-catalog.ts";

/* The roster is an input here: window budgets resolve from the roster fixture, never the deployable agents/opencode.json. */


/* Regeneration prompts must NOT command the agent to re-navigate / re-snapshot / re-activate
   serena when authoritative grounding (a Context Pack DOM excerpt or an injected a11y tree) is
   already in the prompt. They MUST keep commanding exploration when there is NO grounding (a
   blind regen still needs to see the page). "Grounding present" = a DOM tree is in the prompt: the
   pack's live DOM section or an injected tree. A pack of contracts alone is not a tree.
 */

const PACK_WITH_DOM = `## ${PACK_HEADINGS.pack}\n\n### ${PACK_HEADINGS.liveDom} (a11y tree)\nroute /owners:\n  button: Add Owner`;
const PACK_CONTRACTS_ONLY = `## ${PACK_HEADINGS.pack}\n\n### ${PACK_HEADINGS.contracts}\n- \`listOwners\`: GET /owners`;

function mkInput(overrides: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/app",
    sha: "abc1234",
    diff: "diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() {}\n",
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234",
    target: "e2e",
    mode: "diff",
    appName: "testapp",
    baseUrl: "http://localhost:3000",
    ...overrides,
  };
}

const failingCase: QaCase = { name: "owners list", status: "fail", detail: "locator not found" };

/* What a section declares to the prompt-contract lint: assertions on these survive any rewording of the prose. */
const claimsOf = (assembled: AssembledPrompt, id: string): readonly PromptClaim[] => assembled.claims[id] ?? [];
const provided = (assembled: AssembledPrompt, id: string): FactId[] =>
  claimsOf(assembled, id).flatMap((c) => (c.kind === "provides" ? [c.fact] : [])).sort();
const directs = (assembled: AssembledPrompt, id: string, action: ClaimAction, target?: FactId): boolean =>
  claimsOf(assembled, id).some((c) => isDeepStrictEqual(c, claim.directs(action, target)));

/* ── Code mode: the generator has no shell, so it is never told to compile or to run the repo's tests: the orchestrator's static gate and
   execution do both. A code task is the diff and nothing of the e2e exploration. ──
 */
test("code mode embeds the diff in its task, renders no separate diff section and directs no live exploration", () => {
  const assembled = buildPromptAssembled(mkInput({ target: "code" }));
  assert.equal(assembled.sectionSizes["diff"], undefined, "the e2e diff section is not rendered for code");
  assert.notEqual(assembled.sectionSizes["task"], undefined);
  assert.deepEqual(assembled.claims["task"], [claim.provides("diff"), claim.directs("consult", "diff")], "the code task carries the diff and none of the e2e task's directives");
  assert.deepEqual(assembled.claims["working-rules"], [claim.provides("orchestrator-validation")], "code mode directs no live-page exploration");
});

test("code mode working-rules: the generator is not told to compile or run anything, and is told the orchestrator does", () => {
  for (const isReGen of [false, true]) {
    const input = mkInput({ target: "code", ...(isReGen ? { fixCases: [failingCase] } : {}) });
    assert.doesNotMatch(buildPrompt(input), /test-compile|testClasses|go vet|cargo check|tsc --noEmit/, "no per-ecosystem compile command");
    assert.deepEqual(claimsOf(buildPromptAssembled(input), "working-rules"), [claim.provides("orchestrator-validation")], "the prompt says who validates what the agent writes");
  }
});

/* ── App login: a declared login whose stock auth.setup.ts did not sign in is a fact about the run,
   not grounding — it must reach the generator without pretending a live-DOM Context Pack exists. ── */

/* The body of a prompt's app-login section, up to the next blank line or heading. */
function appLoginSection(prompt: string): string | undefined {
  const heading = `## ${PROMPT_HEADINGS.appLogin}\n`;
  const start = prompt.indexOf(heading);
  if (start === -1) return undefined;
  const body = prompt.slice(start + heading.length);
  const end = body.search(/\n\n|\n#/);
  return end === -1 ? body : body.slice(0, end);
}

test("an unauthored stock auth seed renders the app-login section and names the suite's auth.setup.ts", () => {
  const assembled = buildPromptAssembled(mkInput({ e2eRelDir: "tests/e2e", authSeedUnauthored: true }));
  assert.notEqual(assembled.sectionSizes[APP_LOGIN_SECTION_ID], undefined);
  assert.ok(appLoginSection(assembled.text)?.includes("tests/e2e/auth.setup.ts"));
});

test("an unauthored stock auth seed sends the login rewrite to the live page, with or without a Context Pack in the prompt", () => {
  const pack = `## ${PACK_HEADINGS.pack}\n\n### ${PACK_HEADINGS.liveDom}\n/login: textbox Email`;
  for (const contextPack of [undefined, pack]) {
    const login = appLoginSection(buildPrompt(mkInput({ authSeedUnauthored: true, ...(contextPack ? { contextPack } : {}) })));
    assert.ok(login, "the login section is rendered");
    assert.doesNotMatch(login, new RegExp(`${PACK_HEADINGS.pack}|${PACK_HEADINGS.liveDom}`, "i"), "the section does not point at the pack, which may not hold the login page");
    assert.ok(login.includes("Playwright MCP"), "the rewrite reads the real login page");
  }
});

test("a seed that signed in renders no app-login section and no auth.setup.ts rewrite instruction", () => {
  const assembled = buildPromptAssembled(mkInput({}));
  assert.equal(assembled.sectionSizes[APP_LOGIN_SECTION_ID], undefined);
  assert.ok(!assembled.text.includes("auth.setup.ts"));
});

/* ── fixContent (the motivating bug: a backend-500 failure has no failure DOM, so failureSourced is
   false, but the Context Pack is still injected — the prompt must not order a re-navigation). ──
 */

test("fix-loop: with grounding present and no failure DOM, the fix prompt does NOT command browser_navigate", () => {
  const assembled = buildPromptAssembled(mkInput({ fixCases: [failingCase], contextPack: PACK_WITH_DOM }));
  assert.equal(directs(assembled, "fix-cases", "use-runtime-signals"), false, "grounded fix retry must not order a full re-navigation");
  assert.ok(directs(assembled, "fix-cases", "consult", "dom-live"), "grounded fix retry must tell the agent to fix from the injected grounding");
});

test("fix-loop: with NO grounding, the fix prompt STILL commands browser exploration (blind fix)", () => {
  const assembled = buildPromptAssembled(mkInput({ fixCases: [failingCase] }));
  assert.ok(directs(assembled, "fix-cases", "use-runtime-signals"), "a blind fix retry (no pack, no DOM) must still explore the live page");
  assert.equal(directs(assembled, "fix-cases", "consult", "dom-live"), false);
});

test("fix-loop: a pack of contracts alone grounds no selector, so the fix retry still explores the live page", () => {
  const assembled = buildPromptAssembled(mkInput({ fixCases: [failingCase], contextPack: PACK_CONTRACTS_ONLY }));
  assert.ok(directs(assembled, "fix-cases", "use-runtime-signals"));
});

test("fix-loop: a failureSourced retry grounds on the captured failure tree and directs the agent to consult only it", () => {
  const assembled = buildPromptAssembled(mkInput({ fixCases: [failingCase], domSnapshot: "button: Add Owner", failureSourced: true }));
  assert.ok(assembled.text.includes(PROMPT_HEADINGS.groundTruthAtFailure), "failure-sourced retry keeps the ground-truth heading");
  assert.deepEqual(provided(assembled, "dom-snapshot"), ["dom-failure"]);
  assert.ok(directs(assembled, "fix-cases", "consult", "dom-failure"), "the fix directs the agent to the failure tree");
  assert.equal(directs(assembled, "working-rules", "use-runtime-signals"), false, "a failure tree is the grounding: no live exploration is directed");
});

test("reviewer-corrections: with grounding present, do NOT command re-verify against the live page", () => {
  const assembled = buildPromptAssembled(mkInput({ reviewCorrections: ["scope the selector"], contextPack: PACK_WITH_DOM }));
  assert.equal(directs(assembled, "reviewer-corrections", "use-runtime-signals"), false, "grounded reviewer-corrections must not order a live re-verification");
  assert.ok(directs(assembled, "reviewer-corrections", "consult", "dom-live"), "grounded reviewer-corrections must point at the injected grounding");
});

test("reviewer-corrections: with NO grounding, keep the live re-verify instruction", () => {
  for (const contextPack of [undefined, PACK_CONTRACTS_ONLY]) {
    const assembled = buildPromptAssembled(mkInput({ reviewCorrections: ["scope the selector"], ...(contextPack ? { contextPack } : {}) }));
    assert.ok(directs(assembled, "reviewer-corrections", "use-runtime-signals"), "a blind reviewer-corrections turn must still re-verify against the live page");
  }
});

/* SECURITY CRITICAL: the reviewer agent has read/bash/glob on the ACTUAL repo files, not just the
   pre-sanitized diff the orchestrator assembles — a secret it reads and quotes in a rejection
   rationale must never reach a second model call unredacted. Every sibling field (diff, commit
   body, guidance, DOM snapshot, classificationReason) already runs through sanitizeText(..., "model");
   reviewCorrections was the one gap.
 */
const SECRET_IN_REVIEW_CORRECTION = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGH";

test("SECURITY: a secret quoted in a reviewCorrection is redacted before reaching the generation prompt", () => {
  const text = buildPrompt(mkInput({
    reviewCorrections: [`found ${SECRET_IN_REVIEW_CORRECTION} while reading .env, quoting it here for context`],
  }));
  assert.ok(!text.includes(SECRET_IN_REVIEW_CORRECTION), "a secret in a reviewer correction must never reach the model prompt unredacted");
  assert.ok(text.includes(REDACTED), "the redaction placeholder must appear in its place");
});

/* selectorContradictions/priorCorrections were all sanitized in "model" mode — the SAME mode used
   for the diff (deliberately narrowed to avoid over-redacting legitimate code shapes like
   `password: string`). But these three fields are SHORT AGENT PROSE (a rejection rationale, a
   selector-mismatch description), not diff code — model mode's narrowing means an ORDINARY,
   unquoted credential like `password: hunter2` sails through unredacted. Direct probe:
   sanitizeText("password: hunter2", "model") -> {redacted:false}. DECISION: these three fields move
   to the stricter default ("issue") mode — the same mode already used for the logs->Issue egress
   boundary — because the utility cost of over-redacting short agent prose is near zero, unlike a
   full code diff where model mode's narrowing genuinely protects legitimate type annotations.
 */
const ORDINARY_CREDENTIAL = "hunter2";

test("SECURITY: an ordinary unquoted credential in a reviewCorrection is redacted (stricter default mode, not model mode — prose is not code)", () => {
  const text = buildPrompt(mkInput({
    reviewCorrections: [`password: ${ORDINARY_CREDENTIAL} was hardcoded in the fixture, replace it`],
  }));
  assert.ok(!text.includes(ORDINARY_CREDENTIAL), "an ordinary credential in reviewer prose must be redacted, not just LLM-provider-key-shaped secrets");
  assert.ok(text.includes(REDACTED));
});

test("SECURITY: an ordinary unquoted credential in a selectorContradiction is redacted (stricter default mode)", () => {
  const text = buildPrompt(mkInput({
    mode: "diff",
    selectorContradictions: [`role:name button with name "password: ${ORDINARY_CREDENTIAL}" is NOT in the captured tree`],
  }));
  assert.ok(!text.includes(ORDINARY_CREDENTIAL), "an ordinary credential in a selector contradiction must be redacted");
  assert.ok(text.includes(REDACTED));
});

test("the reviewer judges the delivered specs and lists the existing suite as context only", () => {
  const reviewInput: ReviewInput = {
    diff: "diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() {}\n",
    specs: ["flows/restaurants.spec.ts"],
    existingSpecFiles: ["flows/auth.spec.ts", "cleanup.spec.ts"],
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    appName: "testapp",
    mode: "diff",
  };
  const assembled = buildReviewerPromptAssembled(reviewInput);
  assert.notEqual(assembled.sectionSizes["reviewer-specs"], undefined);
  assert.notEqual(assembled.sectionSizes["reviewer-existing-suite"], undefined);
  for (const spec of reviewInput.existingSpecFiles ?? []) assert.ok(assembled.text.includes(spec), `${spec} is listed`);
  assert.deepEqual(claimsOf(assembled, "reviewer-existing-suite"), [claim.provides("existing-suite"), claim.frames("existing-suite", "unverified")], "the listing is context, never a target of the review");
  assert.ok(assembled.text.includes(`reviewer-prompt-version: ${REVIEWER_PROMPT_VERSION}`));
});

test("SECURITY: an ordinary unquoted credential in a priorCorrection is redacted (stricter default mode)", () => {
  const reviewInput: ReviewInput = {
    diff: "diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() {}\n",
    specs: ["flows/checkout.spec.ts"],
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    appName: "testapp",
    mode: "diff",
    priorCorrections: [`password: ${ORDINARY_CREDENTIAL} was hardcoded in the fixture`],
  };
  const text = buildReviewerPrompt(reviewInput);
  assert.ok(!text.includes(ORDINARY_CREDENTIAL), "an ordinary credential in a prior-round correction must be redacted");
  assert.ok(text.includes(REDACTED));
});

/* selectorContradictions is
   built by checkSpecSelectors (run-orchestration/domain/helpers/selector-check.ts), which embeds
   `sel.name` extracted VERBATIM from the agent's own spec source — an agent can write
   `page.getByRole('button', { name: '<secret it read from a repo file>' })` (a locator guaranteed
   not to match) and that name is echoed unredacted into the NEXT regen prompt, right next to
   reviewCorrections (already fixed) but itself never sanitized.
 */
const SECRET_IN_SELECTOR_CONTRADICTION = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGH";

test("SECURITY: a secret embedded in a selectorContradiction (agent-authored locator name) is redacted before reaching the generation prompt", () => {
  const text = buildPrompt(mkInput({
    mode: "diff",
    selectorContradictions: [`role:name 'button' with name "${SECRET_IN_SELECTOR_CONTRADICTION}" is NOT in the captured tree; present roles: button:"Save"`],
  }));
  assert.ok(!text.includes(SECRET_IN_SELECTOR_CONTRADICTION), "a secret embedded in a selector contradiction must never reach the model prompt unredacted");
  assert.ok(text.includes(REDACTED), "the redaction placeholder must appear in its place");
});

/* ── workingRules: a DOM snapshot (no pack) is still grounding → suppress the explore-first mandate ── */

test("working-rules: an injected DOM tree without a pack is the grounding, so no live exploration is directed", () => {
  const assembled = buildPromptAssembled(mkInput({ domSnapshot: "button: Add Owner" }));
  assert.deepEqual(provided(assembled, "dom-snapshot"), ["dom-live"]);
  assert.equal(directs(assembled, "working-rules", "use-runtime-signals"), false);
});

test("working-rules: no pack AND no DOM directs the live exploration (blind run)", () => {
  const assembled = buildPromptAssembled(mkInput());
  assert.equal(assembled.sectionSizes["dom-snapshot"], undefined);
  assert.equal(assembled.sectionSizes["context-pack"], undefined);
  assert.ok(directs(assembled, "working-rules", "use-runtime-signals"), "a fully blind run explores the live page");
});

test("working-rules: a Context Pack with a live DOM grounds the run, a pack of contracts alone does not", () => {
  const grounded = buildPromptAssembled(mkInput({ contextPack: PACK_WITH_DOM }));
  assert.deepEqual(provided(grounded, "context-pack"), ["dom-live"]);
  assert.equal(directs(grounded, "working-rules", "use-runtime-signals"), false);
  const contractsOnly = buildPromptAssembled(mkInput({ contextPack: PACK_CONTRACTS_ONLY }));
  assert.deepEqual(provided(contractsOnly, "context-pack"), ["api-operations"]);
  assert.ok(directs(contractsOnly, "working-rules", "use-runtime-signals"), "contracts ground no selector: the live page is still explored");
});

test("coverage-enforce: with grounding present, instruct to resolve from grounding, not re-navigate", () => {
  const assembled = buildPromptAssembled(mkInput({ coverageGap: "src/foo.ts:10-12", contextPack: PACK_WITH_DOM }));
  assert.ok(directs(assembled, "coverage-gap", "consult", "dom-live"), "grounded coverage-enforce must point new selectors at the injected grounding");
  assert.equal(directs(buildPromptAssembled(mkInput({ coverageGap: "src/foo.ts:10-12" })), "coverage-gap", "consult", "dom-live"), false, "without grounding there is nothing to point at");
});

/* ── regen-discipline: a re-generation turn must not re-orient (serena/blast-radius already distilled) ── */

test("regen-discipline: a re-generation turn carries the section and directs no blast-radius orientation", () => {
  const assembled = buildPromptAssembled(mkInput({ fixCases: [failingCase] }));
  assert.notEqual(assembled.sectionSizes["regen-discipline"], undefined);
  assert.equal(directs(assembled, "task", "orient", "blast-radius"), false, "a regen turn does not re-run the blast-radius analysis");
});

test("regen-discipline: a FIRST-PASS (non-regen) turn keeps full orientation", () => {
  const assembled = buildPromptAssembled(mkInput());
  assert.equal(assembled.sectionSizes["regen-discipline"], undefined, "a first-pass turn does not carry the regen-discipline section");
  assert.ok(directs(assembled, "task", "orient", "blast-radius"), "the first pass is directed to orient on the blast radius");
});

/* hasInjectedGrounding is a coarse boolean; the grounding may not cover the failing route.
   The agent must be explicitly told to navigate an uncovered route rather than guess blindly.
 */
test("a grounded RE-gen prompt MANDATES navigating a route absent from the grounding (anti-blinding)", () => {
  const regens: Array<Partial<OpencodeRunInput>> = [{ fixCases: [failingCase] }, { reviewCorrections: ["scope the selector"] }, { coverageGap: "src/foo.ts:10-12" }];
  const sections = ["fix-cases", "reviewer-corrections", "coverage-gap"];
  regens.forEach((regen, i) => {
    const assembled = buildPromptAssembled(mkInput({ ...regen, contextPack: PACK_WITH_DOM }));
    assert.ok(directs(assembled, sections[i]!, "use-browser-for-uncovered-route"), `${sections[i]}: the agent must navigate an uncovered route, never guess its selectors from incomplete grounding`);
  });
});

/* the serena suppression was absolute; a fix may legitimately need a symbol not in the brief. */
test("regen-discipline carves out reading a symbol the grounding lacks", () => {
  const assembled = buildPromptAssembled(mkInput({ fixCases: [failingCase] }));
  assert.ok(directs(assembled, "regen-discipline", "read"), "the serena suppression must allow reading a symbol absent from the grounding");
});

/* Moving it to the stable-prefix band makes it render before the volatile context-pack, proving it
   sheds no earlier than the volatile/task content it must outlive.
 */
test("regen-discipline is in the stable band (renders before the volatile context-pack)", () => {
  const ids = Object.keys(buildPromptAssembled(mkInput({ fixCases: [failingCase], contextPack: PACK_WITH_DOM })).sectionSizes);
  assert.ok(ids.includes("regen-discipline") && ids.includes("context-pack"), "both regen-discipline and the context-pack must be present");
  assert.ok(ids.indexOf("regen-discipline") < ids.indexOf("context-pack"), "regen-discipline (stable) must render before the volatile context-pack");
});

/* anti-blinding gap — a fix that must touch a route NOT in that tree needs the same escape. */
test("the failure-sourced fix branch carries the anti-blinding escape too", () => {
  const assembled = buildPromptAssembled(mkInput({ fixCases: [failingCase], domSnapshot: "button: Add Owner", failureSourced: true }));
  assert.ok(
    directs(assembled, "fix-cases", "use-browser-for-uncovered-route"),
    "even a failure-sourced fix must navigate a route absent from the captured failure tree",
  );
});

/* Raw DOM embeds must be sanitized like every other model-bound section.
   domSnapshot is captured live from DEV — the rendered page can contain a leaked secret-shaped
   string. Every other text section in this file (diff, commit message, guidance) is already routed
   through sanitizeText; DOM embeds must follow the same rule (context-pack.ts's DOM section too).
 */
const secretShapedDom = 'button: Submit\ntextbox: apiKey: "sk-liveSECRETVALUE123456"';

test("the generator's live-DOM section sanitizes a secret-shaped DOM string", () => {
  const text = buildPrompt(mkInput({ domSnapshot: secretShapedDom }));
  assert.ok(!text.includes("sk-liveSECRETVALUE123456"), "a secret-shaped string in the captured DOM must not reach the model raw");
});

test("the failure-sourced 'GROUND TRUTH AT FAILURE' DOM section sanitizes a secret-shaped string", () => {
  const text = buildPrompt(mkInput({ fixCases: [failingCase], domSnapshot: secretShapedDom, failureSourced: true }));
  assert.ok(!text.includes("sk-liveSECRETVALUE123456"), "the failure-point DOM capture must be sanitized too");
});

test("buildReviewerPrompt's live-DOM section sanitizes a secret-shaped string", () => {
  const reviewInput: ReviewInput = {
    diff: "diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() {}\n",
    specs: ["flows/checkout.spec.ts"],
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    appName: "testapp",
    mode: "diff",
    domSnapshot: secretShapedDom,
  };
  const text = buildReviewerPrompt(reviewInput);
  assert.ok(!text.includes("sk-liveSECRETVALUE123456"), "the reviewer's captured DOM must be sanitized too");
});

/* priorCorrections carries the SAME
   reviewer-authored correction text as reviewCorrections (the prior round's own corrections
   thread into the NEXT review call) — just fed back into
   the REVIEWER's own next-round prompt instead of the generator's. Same provenance, same risk,
   same fix.
 */
const SECRET_IN_PRIOR_CORRECTION = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGH";

test("SECURITY: a secret quoted in a priorCorrection is redacted before reaching the reviewer's next-round prompt", () => {
  const reviewInput: ReviewInput = {
    diff: "diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() {}\n",
    specs: ["flows/checkout.spec.ts"],
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    appName: "testapp",
    mode: "diff",
    priorCorrections: [`found ${SECRET_IN_PRIOR_CORRECTION} while reading .env, quoting it here for context`],
  };
  const text = buildReviewerPrompt(reviewInput);
  assert.ok(!text.includes(SECRET_IN_PRIOR_CORRECTION), "a secret in a prior-round correction must never reach the reviewer's next-round prompt unredacted");
  assert.ok(text.includes(REDACTED), "the redaction placeholder must appear in its place");
});

/* ── fix-cases evidence rendering (httpStatus/finalUrl/runtimeErrors) ─────
   The FixLoop already carries runtime evidence on each failing QaCase; the fix-cases
   prompt sections must render more than `name` + `detail`, discarding the strongest signal available for
   telling an app defect (5xx, console error) apart from a test defect. The fixContent of
   buildPromptAssembled/buildPrompt must surface it.
 */

const evidenceCase: QaCase = {
  name: "owners list",
  status: "fail",
  detail: "locator not found",
  httpStatus: 503,
  finalUrl: "https://dev.example.com/owners",
  runtimeErrors: [
    { type: "pageerror", text: "TypeError: cannot read properties of undefined" },
    { type: "console.error", text: "Failed to load resource: the server responded with a status of 503" },
  ],
};

test("buildPrompt fix-cases section renders httpStatus for a failing case", () => {
  const statusOnly: QaCase = { name: "owners list", status: "fail", detail: "locator not found", httpStatus: 418 };
  const text = buildPrompt(mkInput({ fixCases: [statusOnly] }));
  assert.ok(text.includes(String(statusOnly.httpStatus)), "the fix-cases section must surface the correlated HTTP status");
});

test("buildPrompt fix-cases section renders finalUrl for a failing case", () => {
  const text = buildPrompt(mkInput({ fixCases: [evidenceCase] }));
  assert.ok(
    text.includes("https://dev.example.com/owners"),
    "the fix-cases section must surface the page URL at the failure point",
  );
});

test("buildPrompt fix-cases section renders up to 3 runtimeErrors lines", () => {
  const text = buildPrompt(mkInput({ fixCases: [evidenceCase] }));
  for (const error of evidenceCase.runtimeErrors ?? []) {
    assert.ok(text.includes(error.type) && text.includes(error.text), `the ${error.type} line carries its type and text`);
  }
});

test("buildPrompt fix-cases section caps runtimeErrors at 3 lines", () => {
  const manyErrors: QaCase = {
    ...evidenceCase,
    runtimeErrors: [
      { type: "pageerror", text: "error one" },
      { type: "pageerror", text: "error two" },
      { type: "pageerror", text: "error three" },
      { type: "pageerror", text: "error four" },
    ],
  };
  const text = buildPrompt(mkInput({ fixCases: [manyErrors] }));
  assert.ok(text.includes("error one") && text.includes("error two") && text.includes("error three"));
  assert.ok(!text.includes("error four"), "runtimeErrors rendering must cap at 3 lines per case");
});

test("buildPrompt fix-cases section slices a long runtimeErrors text to ~200 chars", () => {
  /* Words, as an error message is: one unbroken run of letters that long is what the redaction takes for a secret. */
  const longText = "word ".repeat(100);
  const longErrorCase: QaCase = { ...evidenceCase, runtimeErrors: [{ type: "pageerror", text: longText }] };
  const text = buildPrompt(mkInput({ fixCases: [longErrorCase] }));
  assert.ok(!text.includes(longText), "a long runtimeErrors text must be sliced, not rendered in full");
  assert.ok(text.includes("word ".repeat(40)), "the slice must keep roughly the first 200 chars");
});

test("buildPrompt fix-cases section omits evidence lines when absent (no httpStatus/finalUrl/runtimeErrors)", () => {
  const [entry, ...evidence] = renderFixCase(failingCase);
  assert.ok(buildPrompt(mkInput({ fixCases: [failingCase] })).includes(entry!));
  assert.deepEqual(evidence, [], "no httpStatus present must render no HTTP line");
});

test("buildPrompt fix-cases section renders NET evidence and suppresses the misleading HTTP (unknown)", () => {
  const netCase: QaCase = { name: "owners list", status: "fail", finalUrl: "https://dev.example.com/owners", networkErrors: [{ url: "https://api.example/orders", status: 504 }] };
  const text = buildPrompt(mkInput({ fixCases: [netCase] }));
  for (const network of netCase.networkErrors ?? []) {
    assert.ok(text.includes(network.url) && text.includes(String(network.status)), "network evidence carries the failing url and status");
  }
  assert.equal(text.includes(HTTP_UNKNOWN_LABEL), false, "a network error replaces the misleading HTTP (unknown) line");
});

test("buildPrompt fix-cases section still renders HTTP (unknown) when there is a finalUrl and no network errors", () => {
  const noNet: QaCase = { name: "owners list", status: "fail", finalUrl: "https://dev.example.com/owners" };
  const text = buildPrompt(mkInput({ fixCases: [noNet] }));
  assert.ok(text.includes(`${HTTP_UNKNOWN_LABEL} at ${noNet.finalUrl}`), "no network errors must keep the HTTP (unknown) line");
});
function padTo(s: string, bytes: number): string {
  const current = Buffer.byteLength(s, "utf8");
  if (current >= bytes) return s;
  return s + " ".repeat(bytes - current);
}

/* ── Seam e — acceptance-criterion appears BEFORE diff in diff mode ───────────────────────── */

/* 1.2: in buildPrompt diff mode, criterion must appear before the diff block. */
test("the objective the agent commits to precedes the diff section in diff mode", () => {
  const assembled = buildPromptAssembled(mkInput());
  const ids = Object.keys(assembled.sectionSizes);
  assert.ok(directs(assembled, "task", "state-outcome"), "the task asks for the objective");
  assert.ok(ids.includes("diff"), "the diff section must be present");
  assert.ok(ids.indexOf("task") < ids.indexOf("diff"), `the task (objective) must precede the diff section; order: ${ids.join(", ")}`);
});

/* [seam a] 1.1: diff section exists as a dedicated section (not embedded in task).
   We verify this via sectionSizes when the diff fits within budget.
   Also asserts that under shed pressure (using assemble directly), diff (shedAs semi-stable, band 2)
   sheds BEFORE task (band 3).
 */
test("diff is a dedicated section (shedAs semi-stable) and sheds before task under budget pressure", () => {
  /* Part 1: When diff fits within budget, sectionSizes must have a "diff" key separate from "task". */
  const result = buildPromptAssembled(mkInput({
    diff: "diff --git a/src/foo.ts\n+export function foo() {}",
  }));
  assert.ok(
    Object.keys(result.sectionSizes).includes("diff"),
    `expected a dedicated "diff" section in sectionSizes; got: ${Object.keys(result.sectionSizes).join(", ")}`,
  );

  const DIFF_MARKER = "DIFF_SECTION_MARKER";
  const TASK_MARKER = "TASK_SECTION_MARKER";
  const padded = (s: string) => padTo(s, 20_000);
  const budget = 22_000;

  const shedResult = caAssemble([
    caSection("task", "task", padded(TASK_MARKER), { priority: 1 }),
    caSection("diff", "task", padded(DIFF_MARKER), { priority: 2, shedAs: "semi-stable" }),
  ], { budgetBytes: budget });

  /* diff (shedAs semi-stable, band 2) sheds before task (band 3) → DIFF_MARKER absent, TASK_MARKER present. */
  assert.ok(
    shedResult.text.includes(TASK_MARKER),
    "task section must survive when diff (shedAs semi-stable) is shed under budget pressure",
  );
  assert.ok(
    !shedResult.text.includes(DIFF_MARKER),
    "diff section (shedAs semi-stable, band 2) must shed before task (band 3) under budget pressure",
  );
});

/* [seam a] 1.3 (regression guard, STRENGTHENED): critical-recap (context-pack shedAs:critical-recap,
   band 4) outlasts the diff (shedAs:semi-stable, band 2) AND learned-rules (volatile, band 1) under
   real budget enforcement. Shed order: learned-rules (volatile, band 1) → diff (semi-stable, band 2)
   → context-pack (critical-recap, band 4). Budget forces both learned-rules AND diff to shed while
   the pack survives — proving the invariant under enforcement, not just by construction.
 */
test("critical-recap context-pack sheds LAST — survives when diff AND learned-rules are shed", () => {
  const PACK_MARKER = "PACK_MARKER_CONTENT";
  const DIFF_MARKER = "DIFF_SECTION_MARKER";
  const LEARNED_MARKER = "LEARNED_RULES_MARKER";

  const padded = (s: string) => padTo(s, 25_000);
  /* Budget: fits only 1 of 3 sections (each ~25k, budget 27k).
     Shed order: learned-rules (volatile, band 1) → diff (shedAs:semi-stable, band 2)
     → context-pack (shedAs:critical-recap, band 4).
     Expected: LEARNED_MARKER shed, DIFF_MARKER shed, PACK_MARKER survives.
   */
  const budget = 27_000;

  const result = caAssemble([
    caSection("context-pack", "volatile", padded(PACK_MARKER), { priority: 0, shedAs: "critical-recap" }),
    caSection("learned-rules", "volatile", padded(LEARNED_MARKER), { priority: 2 }),
    caSection("diff", "task", padded(DIFF_MARKER), { priority: 2, shedAs: "semi-stable" }),
  ], { budgetBytes: budget });

  assert.ok(
    result.text.includes(PACK_MARKER),
    "context-pack (shedAs:critical-recap, band 4) must survive when budget forces shedding of volatile and semi-stable sections",
  );
  assert.ok(
    !result.text.includes(LEARNED_MARKER),
    "learned-rules (volatile, band 1) must be shed first under tight budget",
  );
  assert.ok(
    !result.text.includes(DIFF_MARKER),
    "diff (shedAs:semi-stable, band 2) must be shed before context-pack (band 4) under tight budget",
  );
});

test("existingSpecFiles renders the suite-listing section in diff mode and declares the existing suite it provides", () => {
  const specs = ["e2e/flows/login.spec.ts", "e2e/flows/checkout.spec.ts"];
  const assembled = buildPromptAssembled(mkInput({ existingSpecFiles: specs }));
  assert.notEqual(assembled.sectionSizes[SUITE_LISTING_SECTION_ID], undefined);
  assert.deepEqual(provided(assembled, SUITE_LISTING_SECTION_ID), ["existing-suite"]);
  for (const spec of specs) assert.ok(assembled.text.includes(spec), `the listing includes ${spec}`);
});

test("an empty or absent existingSpecFiles renders no suite-listing section", () => {
  for (const input of [mkInput({ existingSpecFiles: [] }), mkInput()]) {
    const assembled = buildPromptAssembled(input);
    assert.equal(assembled.sectionSizes[SUITE_LISTING_SECTION_ID], undefined);
    assert.equal(assembled.claims[SUITE_LISTING_SECTION_ID], undefined);
  }
});

test("FE↔BE appears at most twice when contextPack is present", () => {
  const contextMap = {
    builtAtSha: "abc1234",
    routes: [{ path: "/checkout", component: "CheckoutComponent" }],
    api: [{ operationId: "createOrder", method: "POST", path: "/orders" }],
    feBe: [{ route: "/checkout", operationId: "createOrder", via: "OrderClient.create" }],
  };
  const contextPack = "### FE↔BE links (1 of 1 total)\n- Route `/checkout` → `createOrder`";
  const text = buildPrompt(mkInput({ contextMap, contextPack }));
  const count = (text.match(/FE↔BE links/g) ?? []).length;
  assert.ok(
    count <= 2,
    `"FE↔BE links" must appear at most 2 times when contextPack is present; found ${count} occurrences`,
  );
});

/* [seam d] 1.9: learned-rules sheds AFTER reviewer-corrections and coverage-gap.
   After seam d, learned-rules priority is p2 in buildPromptAssembled.
   Use caAssemble to verify the shed order invariant directly.
 */
test("learned-rules (p2) sheds AFTER reviewer-corrections (p4) and coverage-gap (p5) in shed order", () => {
  /* With learned-rules at priority p2: volatile shed order is coverage-gap(5) → reviewer-corrections(4) →
     fix-cases(3) → learned-rules(2) → dom(1). So learned-rules (p2) sheds LAST among these.
     We verify: with a budget that forces shedding of coverage-gap (p5) only, learned-rules and
     reviewer-corrections both survive; with more shedding, reviewer-corrections (p4) goes before learned-rules.
   */

  const REVIEWER_MARKER = "REVIEWER_CORRECTIONS_MARKER";
  const LEARNED_MARKER = "LEARNED_RULES_MARKER";
  const GAP_MARKER = "COVERAGE_GAP_MARKER";

  const padded = (s: string) => padTo(s, 20_000);
  /* Budget: fits 2 of 3 sections. coverage-gap (p5) sheds first (highest number = first to go).
     After that, reviewer-corrections (p4) sheds next if still over budget.
     learned-rules (p2) sheds LAST — so with budget=42k, coverage-gap is shed, both others survive.
   */
  const budget = 42_000;

  const result = caAssemble([
    caSection("reviewer-corrections", "volatile", padded(REVIEWER_MARKER), { priority: 4 }),
    caSection("coverage-gap", "volatile", padded(GAP_MARKER), { priority: 5 }),
    caSection("learned-rules", "volatile", padded(LEARNED_MARKER), { priority: 2 }),
  ], { budgetBytes: budget });

  /* With p2: coverage-gap (p5) sheds first → LEARNED_MARKER and REVIEWER_MARKER both survive. */
  assert.ok(
    result.text.includes(LEARNED_MARKER),
    `learned-rules (p2) must survive budget shedding — coverage-gap (p5) should shed first. ` +
    `Actual sectionSizes: ${JSON.stringify(result.sectionSizes)}`,
  );
  assert.ok(
    result.text.includes(REVIEWER_MARKER),
    "reviewer-corrections (p4) must survive when only coverage-gap (p5) is shed",
  );
  assert.ok(
    !result.text.includes(GAP_MARKER),
    "coverage-gap (p5) must be shed first under budget pressure",
  );
});

/* [seam d] 1.10: plan-lessons (p2 after seam d) survives budget pressure that evicts plan-arch-map (p2, declared first).
   With both at p2 (after seam d), the stable sort orders shed candidates by declaration order:
   plan-arch-map is declared FIRST in the array → shed FIRST. plan-lessons SURVIVES.
 */
test("plan-lessons (p2) survives budget pressure when plan-arch-map (p2, declared first) is shed", () => {
  const LESSONS_MARKER = "PLAN_LESSONS_MARKER";
  const ARCH_MAP_MARKER = "PLAN_ARCH_MAP_MARKER";

  const padded = (s: string) => padTo(s, 20_000);
  /* Budget: fits 1 of 2 sections. Both at p2 → tied priority, declaration order decides.
     plan-arch-map declared first → sheds first. plan-lessons survives.
   */
  const budget = 22_000;

  const result = caAssemble([
    caSection("plan-arch-map", "semi-stable", padded(ARCH_MAP_MARKER), { priority: 2 }),
    caSection("plan-lessons", "semi-stable", padded(LESSONS_MARKER), { priority: 2 }), /* p2, tied with arch-map */
  ], { budgetBytes: budget });

  /* Both p2 → stable sort keeps declaration order → plan-arch-map sheds first → plan-lessons survives. */
  assert.ok(
    result.text.includes(LESSONS_MARKER),
    `plan-lessons (p2) must survive when plan-arch-map (also p2, declared first) sheds first.`,
  );
  assert.ok(
    !result.text.includes(ARCH_MAP_MARKER),
    "plan-arch-map (p2, declared first) must be shed when only 1 section fits",
  );
});

/* ── Priority pinning: pin REAL production priority scalars ────────── */

/* Generator path: buildPromptAssembled with large learnedRules + coverageGap content so the role
   budget (192k for kimi-k2.7-code) forces shedding. coverage-gap is rendered with
   shedAs:"critical-recap" (least-shedable — it is the ENTIRE payload of an enforce-mode coverage
   regen). Under budget pressure, learned-rules (still p2) sheds instead — proving the shedAs
   promotion took effect, not merely that learned-rules kept its own priority.
 */
test("coverage-gap (shedAs critical-recap) survives budget pressure that sheds learned-rules (p2)", () => {
  const LEARNED_MARKER = "PINNING_LEARNED_RULES_MARKER";
  const GAP_MARKER = "PINNING_COVERAGE_GAP_MARKER";

  /* Each section ~100k bytes. Together ~200k — exceeds the injected 192k budget, so at least
     one section must shed. The budget is injected via buildPromptAssembled's budgetBytes seam
     (64k tokens × 0.75 safety × 4 bytes/token = 192k — the value the old 64K catalog entry
     produced) so the assertion is INDEPENDENT of the live model-window catalog: raising a
     real model window to 1M must never silently void this shed-order reasoning test.
     learned-rules in the volatile shed band at all, so learned-rules (still volatile p2) sheds first.
   */
  const learnedContent = padTo(LEARNED_MARKER, 100_000);
  const gapContent = padTo(GAP_MARKER, 100_000);

  const result = buildPromptAssembled(mkInput({
    mode: "diff",
    learnedRules: learnedContent,
    coverageGap: gapContent,
  }), { budgetBytes: 192_000 });

  assert.ok(
    result.text.includes(GAP_MARKER),
    `coverage-gap (shedAs critical-recap) must survive budget pressure — it is the entire payload ` +
    `of its own regen turn. sectionSizes: ${JSON.stringify(result.sectionSizes)}`,
  );
  assert.ok(
    !result.text.includes(LEARNED_MARKER),
    `learned-rules (volatile p2, unchanged) is expected to shed here so the budget math actually forces ` +
    `a real choice between the two — otherwise this test would pass trivially if both fit. ` +
    `sectionSizes: ${JSON.stringify(result.sectionSizes)}`,
  );
});

/* The selector priority is unconditional craft: the generator role prompt's Procedure owns it (pinned by
   agents-prompts.test.ts), so the assembled working rules never restate it (prompts.scaffold.test.ts). */

/* The skill-exemplars section carries exactly the templates the curriculum selected (input.skillExemplars), in its order, with the marker of each pattern that has caught a defect. It is the only source: the learning fold credits those templates, so the prompt never derives others from the diff. */
const SKILL_EXEMPLARS_ID = "skill-exemplars";
const CURRICULUM_API_CALL_DIFF = [
  "diff --git a/src/api.ts b/src/api.ts",
  '+const res = await fetch("/api/orders", { method: "POST", body: JSON.stringify(payload) });',
  '+if (!res.ok) throw new Error("failed");',
].join("\n");

const asSelected = (exemplars: readonly (typeof BUILT_IN_EXEMPLARS)[number][]): NonNullable<OpencodeRunInput["skillExemplars"]> =>
  exemplars.map(({ id, name, template, archetype }) => ({ id, name, template, archetype, proven: false, promotionCount: 0 }));

test("no skillExemplars, or an empty list, renders no skill-exemplars section (never fabricated)", () => {
  for (const input of [mkInput(), mkInput({ skillExemplars: [] })]) {
    const assembled = buildPromptAssembled(input);
    assert.equal(assembled.sectionSizes[SKILL_EXEMPLARS_ID], undefined);
    assert.equal(assembled.claims[SKILL_EXEMPLARS_ID], undefined);
  }
});

test("a diff that matches a structural archetype renders no template the curriculum did not select", () => {
  const assembled = buildPromptAssembled(mkInput({ diff: CURRICULUM_API_CALL_DIFF }));
  assert.equal(assembled.sectionSizes[SKILL_EXEMPLARS_ID], undefined, "the diff alone derives nothing: what the generator is shown is what the fold credits");
  for (const exemplar of BUILT_IN_EXEMPLARS) assert.ok(!assembled.text.includes(exemplar.name), `${exemplar.name} is not derived from the diff`);
});

test("a context run renders no exemplars even when some are supplied", () => {
  const assembled = buildPromptAssembled(mkInput({ mode: "context", skillExemplars: asSelected(BUILT_IN_EXEMPLARS.slice(0, 1)) }));
  assert.equal(assembled.sectionSizes[SKILL_EXEMPLARS_ID], undefined);
});

test("the selected exemplars reach the prompt whole, with no fixed byte budget, and over the window are named as a reference", () => {
  const input = mkInput({ skillExemplars: asSelected(BUILT_IN_EXEMPLARS) });
  const whole = buildPromptAssembled(input);
  for (const exemplar of BUILT_IN_EXEMPLARS) assert.ok(whole.text.includes(exemplar.name), `${exemplar.name} reaches the prompt`);
  assert.deepEqual(provided(whole, SKILL_EXEMPLARS_ID), ["exemplars"]);
  const tight = buildPromptAssembled(input, { fit: () => "over" });
  assert.match(tight.text, new RegExp(`${BUILT_IN_EXEMPLARS.length} test template\\(s\\) for the patterns this change shows are not shown here, to fit the window`));
  assert.ok(!tight.text.includes(BUILT_IN_EXEMPLARS[0]!.template));
});

/* The supplied order below is deliberately at odds with EVERY ordering this renderer could
   plausibly impose on its own: it is neither ascending nor descending by catalog index (0, 4, 3),
   by name (F, D, R), by id (f, d, s) or by archetype (i, e, r), and the only PROVEN entry sits in
   the MIDDLE, so a "proven first" re-sort would fail too. Ranking already happened in the adapter;
   any sort here would decouple "what the generator was shown" from "what the curriculum folds".
   Three entries is also the realistic maximum payload (MAX_SELECTED_EXEMPLARS).
 */
test("curriculum: a supplied skillExemplars list renders in the SUPPLIED order, with the inline PROVEN marker", () => {
  const supplied: NonNullable<OpencodeRunInput["skillExemplars"]> = [
    { id: "ex-form-invalid-input", name: "Form invalid input", template: "TEMPLATE-A", archetype: "invalid-input", proven: false, promotionCount: 0 },
    { id: "ex-data-list-empty", name: "Data list empty state", template: "TEMPLATE-B", archetype: "empty-state", proven: true, promotionCount: 2 },
    { id: "ex-stateful-re-query", name: "Re-query after mutation", template: "TEMPLATE-C", archetype: "re-query-after-mutation", proven: false, promotionCount: 0 },
  ];
  const assembled = buildPromptAssembled(mkInput({ diff: CURRICULUM_API_CALL_DIFF, skillExemplars: supplied }));
  const { text } = assembled;
  assert.deepEqual(provided(assembled, SKILL_EXEMPLARS_ID), ["exemplars"]);
  const headingOf = (name: string): string | undefined => text.split("\n").find((line) => line.includes(name));
  assert.ok(headingOf("Data list empty state")?.includes("PROVEN"), "the proven entry carries the inline marker");
  assert.ok(!headingOf("Form invalid input")?.includes("PROVEN"), "an unproven entry carries none");
  assert.ok(!headingOf("Re-query after mutation")?.includes("PROVEN"), "an unproven entry carries none");
  assert.ok(
    text.indexOf("TEMPLATE-A") < text.indexOf("TEMPLATE-B") && text.indexOf("TEMPLATE-B") < text.indexOf("TEMPLATE-C"),
    "the supplied order must be preserved — a renderer that sorts internally must fail here",
  );
  const suppliedNames = new Set(supplied.map((exemplar) => exemplar.name));
  for (const exemplar of BUILT_IN_EXEMPLARS.filter((candidate) => !suppliedNames.has(candidate.name))) {
    assert.ok(!text.includes(exemplar.name), `${exemplar.name}: a supplied list is all the prompt renders, whatever the diff would match`);
  }
});

/* cappedDiffText — THE single way every prompt embeds a commit diff — now sanitizes in "model" mode
   runs the post-redaction fail-loud guard (assertNoSecretLeak) immediately after.
 */

test("the diff embedded in the generator prompt uses 'model' mode — an auth-shaped type annotation is NOT over-redacted", () => {
  const text = buildPrompt(mkInput({
    diff: "diff --git a/src/server/auth.ts b/src/server/auth.ts\n+function sign(data: string, secret: string): string {\n",
  }));
  assert.ok(
    text.includes("secret: string"),
    "model-mode sanitization must leave an ordinary type annotation intact in the diff sent to the model",
  );
});

test("a diff with a genuine secret is fully redacted before reaching the generator prompt — never sent raw", () => {
  const text = buildPrompt(mkInput({
    diff: 'diff --git a/src/config.ts b/src/config.ts\n+const apiKey = "sk-live-abc123XYZsecretvalue";\n',
  }));
  assert.ok(!text.includes("sk-live-abc123XYZsecretvalue"), "a real secret must never reach the model unredacted, even in model mode");
  assert.ok(text.includes(REDACTED), "the redaction marker must appear in its place");
});

test("an auth.ts-shaped diff never trips the diff→model guard (false-positive tolerance, never throws)", () => {
  assert.doesNotThrow(() => buildPrompt(mkInput({
    diff: [
      "diff --git a/src/server/auth.ts b/src/server/auth.ts",
      "+function sign(data: string, secret: string): string {",
      "+export function issueSession(username: string, secret: string, ttlSeconds: number, now = Date.now()): string {",
      "+export function validateSession(token: string, secret: string, now = Date.now()): string | null {",
    ].join("\n"),
  })));
});

/* "a secret survives redaction at diff→model → SecretLeakError thrown" is covered at the unit
   level in src/orchestrator/sanitizer.test.ts (assertNoSecretLeak's own dedicated tests) rather than
   as an end-to-end prompts.ts fixture: sanitizeText and containsSecrets share ONE pattern table with
   identical skip/modelSkip logic, so a secret genuinely surviving redaction is not constructible
   through this real pipeline today (by design — the guard exists as an invariant check against a
   FUTURE regression, e.g. a pattern added to one function but not the other). cappedDiffText is
   "model" mode only for a section whose target path has a known code extension, "issue" mode for
   everything else (config files, unknown/no extension, and any preamble before the first header) — and
   runs `assertNoSecretLeak` per section, immediately after sanitizeText, with THAT section's own mode.
   This is the reviewable proof the guard is wired into the diff→model path for every section, not just
   a single whole-text call.
 */

/* short, lowercase value like `password: hunter2` reads as a type annotation / call expression, not a
   secret) — correct for TS/JS source hunks, but this narrowing was applied to the WHOLE diff, so
   config-file hunks (docker-compose.yml, .env, CI YAML) — where an unquoted lowercase-key credential IS
   the norm — silently escaped redaction in model mode despite being redacted in issue mode.
 */

test("file-aware redaction: a .ts hunk stays code-shaped (unredacted) while a docker-compose.yml hunk in the SAME diff gets its unquoted credential redacted", () => {
  const diff = [
    "diff --git a/src/server/auth.ts b/src/server/auth.ts",
    "+function sign(data: string, secret: string): string {",
    "diff --git a/docker-compose.yml b/docker-compose.yml",
    "+    environment:",
    "+      password: hunter2",
  ].join("\n");
  const text = buildPrompt(mkInput({ diff }));
  assert.ok(text.includes("secret: string"), "the .ts hunk must keep model-mode's code-shape narrowing (not over-redacted)");
  assert.ok(!text.includes("password: hunter2"), "the docker-compose.yml hunk's unquoted credential must be redacted — config files use issue mode");
  assert.ok(text.includes(REDACTED), "the config-file secret must be replaced with the redaction marker");
});

test("file-aware redaction: a punctuated unquoted credential in a .env hunk is redacted (config files use issue mode, unaffected by the high-entropy bare-token check)", () => {
  const diff = ["diff --git a/.env b/.env", "+token=Str0ng!Pass"].join("\n");
  const text = buildPrompt(mkInput({ diff }));
  assert.ok(!text.includes("token=Str0ng!Pass"), "the .env hunk's credential must be redacted even though punctuation defeats isHighEntropyBareToken's bare-identifier shape check");
  assert.ok(text.includes(REDACTED));
});

test("file-aware redaction: a headerless diff fixture (no 'diff --git' at all) keeps whole-text model mode — existing bare-fixture tests are unaffected", () => {
  const text = buildPrompt(mkInput({ diff: "password=hunter2" }));
  assert.ok(text.includes(ORDINARY_CREDENTIAL), "with no file header to key a mode off, the whole text must still fall back to model mode (prior behavior, unchanged)");
});

/* A structural signal renders as its own section in either target, and an absent one adds no empty section. */
test("a structural signal renders the static-signal section in code and e2e mode, and an absent one renders none", () => {
  for (const target of ["code", "e2e"] as const) {
    const withSignal = buildPromptAssembled(mkInput({ target, staticSignal: "## Static signal\n\nsymbol: Foo.bar" }));
    assert.notEqual(withSignal.sectionSizes["static-signal"], undefined, `${target}: the section is rendered`);
    assert.ok(withSignal.text.includes("Foo.bar"), `${target}: the signal's symbol reaches the prompt`);
    assert.equal(provided(withSignal, "static-signal").length, 1, `${target}: the section declares the one fact it provides`);
    const withoutSignal = buildPromptAssembled(mkInput({ target }));
    assert.equal(withoutSignal.sectionSizes["static-signal"], undefined, `${target}: no empty section without a signal`);
    assert.equal(withoutSignal.claims["static-signal"], undefined);
  }
});

/* "Cross-service links (deterministic)" section of the generator prompt.
 */

const link1 = {
  from: { repo: "org/front", file: "src/api.ts", symbol: "getOrder" },
  to: { repo: "org/orders", file: "src/routes.ts", symbol: "GET /orders/:id" },
  transport: "http" as const,
  contractRef: "GET /orders/{id}",
  confidence: 0.9,
  source: "openapi",
};
/* The backticked subject of link1's line. */
const LINK1_SUBJECT = `\`${link1.from.repo}/${link1.from.file}#${link1.from.symbol}\``;
const drift1 = {
  from: { repo: "org/front", file: "src/api.ts", symbol: "deleteOrder" },
  verb: "DELETE",
  path: "/orders/{id}",
};

test("non-empty serviceLinks in generation mode renders the service-links section: one item per link, declared as unverified", () => {
  const assembled = buildPromptAssembled(mkInput({ serviceLinks: [link1] }));
  assert.notEqual(assembled.sectionSizes["service-links"], undefined);
  assert.deepEqual(claimsOf(assembled, "service-links"), [claim.provides("service-links"), claim.frames("service-links", "unverified")]);
  assert.deepEqual(assembled.sectionItems["service-links"]?.itemIds, [itemId.svcLink(link1)]);
  for (const part of [link1.from.repo, link1.from.file, link1.from.symbol, link1.to.repo, link1.contractRef, link1.source, link1.confidence.toFixed(2)]) {
    assert.ok(assembled.text.includes(part), `the link line carries ${part}`);
  }
});

test("http-backend-resolver links render as BE→BE HTTP", () => {
  const be = { ...link1, source: "http-backend-resolver", from: { repo: "org/orders", file: "src/Client.java", symbol: "exchange" } };
  const text = buildPrompt(mkInput({ serviceLinks: [be] }));
  assert.ok(text.includes(`${BACKEND_TO_BACKEND_LABEL}, source ${be.source}`));
});

test("contractDrift alongside links renders after the links, never merged into the link items", () => {
  const assembled = buildPromptAssembled(mkInput({ serviceLinks: [link1], contractDrift: [drift1] }));
  const driftLine = `${drift1.verb} ${drift1.path}`;
  assert.ok(assembled.text.includes(driftLine), "the drift verb+path is rendered");
  assert.ok(assembled.text.indexOf(driftLine) > assembled.text.indexOf(link1.from.symbol), "the drift entry comes AFTER the links list, not merged into it");
  assert.deepEqual(assembled.sectionItems["service-links"]?.itemIds, [itemId.svcLink(link1)], "a drift entry is not a link item");
});

test("absent/empty serviceLinks renders NO section at all — byte-identical to a prompt assembled without the field", () => {
  const withEmpty = buildPromptAssembled(mkInput({ serviceLinks: [] }));
  const withoutField = buildPromptAssembled(mkInput({}));
  assert.equal(withEmpty.sectionSizes["service-links"], undefined, "empty serviceLinks must render no section");
  assert.equal(withEmpty.text, withoutField.text, "an empty array must be byte-identical to the field being entirely absent");
});

test("isGenerationMode false (context mode) suppresses the section even when serviceLinks is present", () => {
  const assembled = buildPromptAssembled(mkInput({ mode: "context", serviceLinks: [link1] }));
  assert.equal(assembled.sectionSizes["service-links"], undefined, "context mode must never render the service-links section, mirroring every other isGenerationMode-gated section");
});

test("more than MAX_LINKS (40) links renders only the first 40; more than MAX_DRIFT (20) drift entries renders only the first 20", () => {
  const manyLinks = Array.from({ length: 45 }, (_, i) => ({
    from: { repo: "org/front", file: "src/api.ts", symbol: `sym${i}` },
    to: { repo: "org/orders", file: "src/routes.ts", symbol: `route${i}` },
    transport: "http" as const,
    confidence: 0.5,
    source: "openapi",
  }));
  const manyDrift = Array.from({ length: 25 }, (_, i) => ({
    from: { repo: "org/front", file: "src/api.ts", symbol: `sym${i}` },
    verb: "GET",
    path: `/path${i}`,
  }));
  const text = buildPrompt(mkInput({ serviceLinks: manyLinks, contractDrift: manyDrift }));
  assert.ok(text.includes("sym0") && text.includes("sym39"), "the first 40 links must render");
  assert.ok(!text.includes("sym40") && !text.includes("sym44"), "links beyond the 40-cap must be dropped");
  assert.ok(text.includes("/path0") && text.includes("/path19"), "the first 20 drift entries must render");
  assert.ok(!text.includes("/path20") && !text.includes("/path24"), "drift entries beyond the 20-cap must be dropped");
});

/* generator (and any human reading a captured prompt) had no way to know MORE links existed past the
   cut. Append an observability marker naming how many were omitted.
 */
test("more than MAX_LINKS (40) links declares the omitted count as a link-selection omission (single-agent prompt)", () => {
  const manyLinks = Array.from({ length: 45 }, (_, i) => ({
    from: { repo: "org/front", file: "src/api.ts", symbol: `sym${i}` },
    to: { repo: "org/orders", file: "src/routes.ts", symbol: `route${i}` },
    transport: "http" as const,
    confidence: 0.5,
    source: "openapi",
  }));
  const meta = buildPromptAssembled(mkInput({ serviceLinks: manyLinks })).sectionItems["service-links"];
  assert.equal(meta?.itemIds.length, 40, "only the rendered links are items");
  assert.equal(meta?.omissions.length, 1);
  assert.equal(meta?.omissions[0]?.reason, "link-selection");
  assert.equal(meta?.omissions[0]?.count, 5, "45 links - 40 rendered = 5 are declared omitted");
});

test("exactly MAX_LINKS (40) links declares no omission (nothing was actually omitted)", () => {
  const exactLinks = Array.from({ length: 40 }, (_, i) => ({
    from: { repo: "org/front", file: "src/api.ts", symbol: `sym${i}` },
    to: { repo: "org/orders", file: "src/routes.ts", symbol: `route${i}` },
    transport: "http" as const,
    confidence: 0.5,
    source: "openapi",
  }));
  const meta = buildPromptAssembled(mkInput({ serviceLinks: exactLinks })).sectionItems["service-links"];
  assert.equal(meta?.itemIds.length, 40);
  assert.deepEqual(meta?.omissions, [], "no omission when every link was actually rendered");
});

test("contractDrift present with serviceLinks ABSENT/empty still renders the section and the drift WARNING, with no link item (pure-drift scenario)", () => {
  for (const input of [mkInput({ contractDrift: [drift1] }), mkInput({ serviceLinks: [], contractDrift: [drift1] })]) {
    const assembled = buildPromptAssembled(input);
    assert.notEqual(assembled.sectionSizes["service-links"], undefined, "the section is still rendered when drift-only");
    assert.ok(assembled.text.includes(`${drift1.verb} ${drift1.path}`), "the drift verb+path is rendered");
    assert.equal(assembled.sectionItems["service-links"], undefined, "no link item is declared when there are no links");
  }
});

test("links-only (no drift) still renders exactly as before — no empty 'Contract drift' heading", () => {
  const text = buildPrompt(mkInput({ serviceLinks: [link1] }));
  assert.ok(!text.includes(CONTRACT_DRIFT_HEADING), "links-only must not render a drift heading at all");
});

test("serviceLinks string fields pass through the local s() sanitize wrapper (secrets redacted, never passed through raw)", () => {
  const dirtyLink = {
    from: { repo: "org/front", file: "src/api.ts", symbol: "const k = sk-abc123XYZsecretvalue" },
    to: { repo: "org/orders", file: "src/routes.ts", symbol: "GET /orders/:id" },
    transport: "http" as const,
    confidence: 0.9,
    source: "openapi",
  };
  const text = buildPrompt(mkInput({ serviceLinks: [dirtyLink] }));
  assert.ok(!text.includes("sk-abc123XYZsecretvalue"), "a secret-shaped string in a serviceLinks field must be redacted by the sanitize wrapper, never passed through raw");
  assert.ok(text.includes(REDACTED), "the sanitize wrapper must have actually redacted the secret pattern");
});

/* Cross-repo impact is marked inline on the EXISTING "Cross-service links" section bullets — never a
   new or duplicate subsection. Byte-identical when crossRepoImpact is absent. ────────
 */

test("a matched link's EXISTING bullet gets the '[IMPACTED:<tier>]' prefix", () => {
  const text = buildPrompt(mkInput({
    serviceLinks: [link1],
    crossRepoImpact: { impactedLinks: [{ link: link1, tier: "contract-file" }] },
  }));
  assert.ok(text.includes(impactedMarker("contract-file")), "the matched link's bullet must carry the inline tier marker");
  assert.ok(
    text.includes(`${impactedMarker("contract-file")} ${LINK1_SUBJECT}`),
    "the marker must prefix the SAME existing bullet line, not a separate entry",
  );
});

test("an impacted link is listed once, in the existing service-links section, never in a second subsection", () => {
  const assembled = buildPromptAssembled(mkInput({
    serviceLinks: [link1],
    crossRepoImpact: { impactedLinks: [{ link: link1, tier: "contract-file" }] },
  }));
  assert.equal(assembled.text.split(link1.from.symbol).length - 1, 1, "the impacted link renders exactly once, never duplicated for the impacted subset");
  assert.deepEqual(assembled.sectionItems["service-links"]?.itemIds, [itemId.svcLink(link1)]);
});

test("an empty crossRepoImpact.impactedLinks is byte-identical to the field being entirely absent", () => {
  const withEmpty = buildPrompt(mkInput({ serviceLinks: [link1], crossRepoImpact: { impactedLinks: [] } }));
  const withoutField = buildPrompt(mkInput({ serviceLinks: [link1] }));
  assert.equal(withEmpty, withoutField, "an empty impacted set must render byte-identical to the field being entirely absent");
  assert.ok(!withoutField.includes(IMPACTED_MARKER_PREFIX), "no inline marker may render when crossRepoImpact is absent");
});

test("a link present in serviceLinks but NOT in crossRepoImpact.impactedLinks renders with NO marker prefix", () => {
  const unmatchedLink = {
    from: { repo: "org/front", file: "src/other.ts", symbol: "getOther" },
    to: { repo: "org/other", file: "src/routes.ts", symbol: "GET /other" },
    transport: "http" as const,
    contractRef: "GET /other",
    confidence: 0.9,
    source: "openapi",
  };
  const text = buildPrompt(mkInput({
    serviceLinks: [link1, unmatchedLink],
    crossRepoImpact: { impactedLinks: [{ link: link1, tier: "impacted-symbol" }] },
  }));
  assert.ok(text.includes(`${impactedMarker("impacted-symbol")} ${LINK1_SUBJECT}`), "the matched link must carry the marker");
  assert.ok(
    !(text.split("\n").find((l) => l.includes("getOther")) ?? "").includes(IMPACTED_MARKER_PREFIX),
    "an unmatched link's bullet must render with NO impacted marker prefix",
  );
});

test("an impacted link past the MAX_LINKS cut still renders WITH its marker — impacted links survive truncation", () => {
  const filler = Array.from({ length: 44 }, (_, i) => ({
    from: { repo: "org/front", file: `src/f${i}.ts`, symbol: `call${i}` },
    to: { repo: "org/other", file: "src/routes.ts", symbol: `GET /f${i}` },
    transport: "http" as const,
    contractRef: `GET /f${i}`,
    confidence: 0.9,
    source: "openapi",
  }));
  const assembled = buildPromptAssembled(mkInput({
    serviceLinks: [...filler, link1], /* the impacted link sits at index 44 — past the 40-link ceiling */
    crossRepoImpact: { impactedLinks: [{ link: link1, tier: "contract-file" }] },
  }));
  const text = assembled.text;
  assert.equal(assembled.sectionItems["service-links"]?.itemIds[0], itemId.svcLink(link1), "the impacted link is the first item kept, ahead of discovery order");
  assert.ok(
    text.includes(`${impactedMarker("contract-file")} ${LINK1_SUBJECT}`),
    "the impacted link must survive the MAX_LINKS truncation with its marker — discovery order must not silently drop the one annotated link",
  );
});

test("the live tree section describes the hint format and leaves the test-id rule to the generator role, so no looser second statement can say any hint implies a test-id", () => {
  const text = buildPrompt(mkInput({ fixCases: [failingCase], domSnapshot: "button: Add Owner", failureSourced: false }));
  const domSection = text.slice(text.indexOf(PROMPT_HEADINGS.liveDevTree));
  assert.ok(domSection.length > 0 && text.includes(PROMPT_HEADINGS.liveDevTree), "the live tree section is rendered");
  assert.doesNotMatch(domSection, /getByTestId/, "the section states no rule about when a test-id applies");
});

/* The GROUND-TRUTH-AT-FAILURE quote-then-assert block must not offer a CSS/data-testid fallback
   for an unquotable locator — that invites inventing a data-testid/CSS value not present in any
   grounding. The ONLY permitted fallback is getByText quoted from the failure tree.
 */
test("defect 2: GROUND-TRUTH-AT-FAILURE fallback offers getByText only, not CSS/data-testid", () => {
  const text = buildPrompt(mkInput({ fixCases: [failingCase], domSnapshot: "button: Add Owner", failureSourced: true }));
  const block = text.slice(text.indexOf("GROUND TRUTH AT FAILURE"), text.indexOf("GROUND TRUTH AT FAILURE") + 1500);
  assert.ok(block.includes("getByText"), "the fallback must still offer getByText");
  assert.doesNotMatch(
    block,
    /CSS\/data-testid|data-testid locator|scoped CSS\/data-testid/i,
    "the fallback must NOT offer a CSS/data-testid locator — that invites fabricating an unverified value",
  );
});

test("a small diff passes through buildDiffSection unmodified (no spurious truncation)", () => {
  const small = "diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() {}\n";
  const text = buildPrompt(mkInput({ diff: small, mode: "diff" }));
  assert.ok(text.includes(small.trimEnd()), "a small diff must render in full");
});

/* A reviewer window the run reported, in tokens: the assembler budgets the prompt to the share of it the budget derives. */
const KNOWN_REVIEWER_WINDOW = { windowTokens: () => 200_000 };
const REVIEWER_BUDGET_BYTES = assemblerBudgetBytes(200_000)!;

test("a small diff at the reviewer site passes through unmodified", () => {
  const small = "diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() {}\n";
  const reviewInput: ReviewInput = {
    diff: small,
    specs: ["flows/checkout.spec.ts"],
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    appName: "testapp",
    mode: "diff",
  };
  const text = buildReviewerPrompt(reviewInput);
  assert.ok(text.includes(small.trimEnd()), "a small diff must render in full");
});

/* The reviewer's live DOM has no fixed byte cap of its own: a large snapshot reaches the prompt whole while the reviewer's window holds it. */
test("an oversized DOM snapshot reaches the reviewer whole within the reviewer role's budget, with no section cap cutting it", () => {
  const oversizedDom = padTo("button: Submit\nheading: Checkout\n", 25_000);
  const { text, sectionSizes } = buildReviewerPromptAssembled({
    diff: "diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() {}\n",
    specs: ["flows/checkout.spec.ts"],
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    appName: "testapp",
    mode: "diff",
    domSnapshot: oversizedDom,
  }, KNOWN_REVIEWER_WINDOW);
  assert.ok((sectionSizes["reviewer-dom"] ?? 0) > Buffer.byteLength(oversizedDom, "utf8"), "reviewer-dom holds the whole snapshot");
  assert.doesNotMatch(text, /capped at/);
  assert.ok(Buffer.byteLength(text, "utf8") <= REVIEWER_BUDGET_BYTES, "the assembled reviewer prompt respects the reviewer role's byte budget");
});

/* coverage-gap must survive its own regen prompt. On an enforce-mode coverage regen, coverage-gap
   is the ENTIRE PAYLOAD of the turn — shedding it under budget pressure silently converts the
   one-shot regen into a blind repeat of the original prompt (the diff is also empty on regens).
   shedAs:"critical-recap" so it survives everything else in the volatile band.
 */
test("coverage-gap survives when other volatile content is large enough to force shedding", () => {
  /* qa-author's real budget is deepseek-v4-pro's window (64,000 tokens x 0.75 safety margin x 4
     bytes/token = 192,000 bytes) — the payload below must genuinely exceed that so the assembler's
     global-budget pass actually sheds something, not merely construct a payload that already fits.
     learnedRules (volatile priority 2, sheds AFTER coverage-gap under the OLD priority-5 ordering)
     plus a large domSnapshot (volatile priority 1, sheds even later) together blow the real budget;
     if coverage-gap is not promoted to the critical-recap shed band, it sheds FIRST and is lost.
   */
  const bigLearnedRules = "## Lessons\n" + "x".repeat(120_000);
  const bigDom = "button: Submit\n" + "row: item ".repeat(15_000);
  const coverageGapText = "## COVERAGE_GAP_UNIQUE_MARKER\nsrc/checkout.ts:42-58 not exercised by the green run.";
  const text = buildPrompt(mkInput({
    coverageGap: coverageGapText,
    learnedRules: bigLearnedRules,
    domSnapshot: bigDom,
  }));
  assert.ok(text.includes("COVERAGE_GAP_UNIQUE_MARKER"), "the coverage-gap section must survive assembly even under real budget pressure");
});

/* "Cross-check against the diff" must be conditional on the diff actually rendering. The diff
   lives in a separate section (buildDiffSection) that returns "" on any regen pass (fixCases /
   reviewCorrections / coverageGap) — a regen prompt must not command the agent to cross-check
   evidence that was never in the prompt at all.
 */
test("a first-pass (non-regen) e2e prompt directs the task to cross-check the diff, alongside the diff", () => {
  const assembled = buildPromptAssembled(mkInput({ mode: "diff" }));
  assert.ok(directs(assembled, "task", "consult", "diff"), "first pass: the diff renders, so the instruction is valid");
  assert.deepEqual(provided(assembled, "diff"), ["diff"]);
  assert.notEqual(assembled.sectionSizes["diff"], undefined, "first pass: the diff section itself must be present");
});

test("a regen prompt does NOT direct a cross-check of the diff (the diff section is empty on regen)", () => {
  const regens: Array<[string, Partial<OpencodeRunInput>]> = [
    ["fixCases", { fixCases: [failingCase] }],
    ["reviewCorrections", { reviewCorrections: ["[fragile-selector] tighten the locator"] }],
    ["coverageGap", { coverageGap: "src/checkout.ts:42-58" }],
  ];
  for (const [what, regen] of regens) {
    const assembled = buildPromptAssembled(mkInput({ mode: "diff", ...regen }));
    assert.equal(assembled.sectionSizes["diff"], undefined, `${what}: no diff section exists`);
    assert.equal(directs(assembled, "task", "consult", "diff"), false, `${what}: so the instruction must not be directed either`);
  }
});

/* entry named "static-gate" so the repair round has the actual error text. But the fixCases section
   unconditionally frames EVERY entry as "tests FAILED during execution against DEV" — misleading
   for a compile/lint failure, since nothing was ever executed. Gate the framing on the case name.
 */
const staticGateCase: QaCase = { name: "static-gate", status: "fail", detail: "TS2322: Type 'string' is not assignable to type 'number'." };

test("a static-gate fixCases entry is declared a gate failure, not an execution failure", () => {
  const assembled = buildPromptAssembled(mkInput({ fixCases: [staticGateCase] }));
  assert.ok(claimsOf(assembled, "fix-cases").some((c) => isDeepStrictEqual(c, claim.provides("gate-failure"))), "a compile/lint failure never executed against DEV — it is a failing gate");
  assert.ok(assembled.text.includes("TS2322"), "the actual validation error text must still be present");
});

test("an ordinary (non-static-gate) fixCases entry keeps the framing of an execution failure", () => {
  const assembled = buildPromptAssembled(mkInput({ fixCases: [failingCase] }));
  assert.ok(!claimsOf(assembled, "fix-cases").some((c) => isDeepStrictEqual(c, claim.provides("gate-failure"))), "a real Playwright execution failure is not a gate failure");
});

test("the assembled coverage-gap section survives a tiny budget that sheds a lower-priority-number volatile section instead", () => {
  /* Direct structural check against the ACTUAL section descriptor buildPromptAssembled constructs
     for coverage-gap (priority 5, shedAs "critical-recap") vs. a lower-priority-number volatile
     section (dom-snapshot, priority 1 — sheds SECOND under the old per-priority-number ordering,
     but FIRST once coverage-gap is promoted to the critical-recap shed band).
   */
  const coverageText = "## Cover the change (HIGH priority)\n\nCOVERAGE_GAP_UNIQUE_MARKER";
  const domText = "## Live DEV accessibility tree\n" + "x".repeat(5000);
  const budgetBytes = Buffer.byteLength(coverageText, "utf8") + 50; /* room for coverage-gap alone, not both */
  const assembled = caAssemble([
    caSection("dom-snapshot", "volatile", domText, { priority: 1 }),
    caSection("coverage-gap", "volatile", coverageText, { priority: 5, shedAs: "critical-recap" }),
  ], { budgetBytes });
  assert.ok(assembled.text.includes("COVERAGE_GAP_UNIQUE_MARKER"), "coverage-gap (shedAs critical-recap) must survive the tiny budget");
  assert.ok(assembled.sectionSizes["coverage-gap"] !== undefined, "coverage-gap must be present in sectionSizes (not shed)");
  assert.ok(assembled.sectionSizes["dom-snapshot"] === undefined, "dom-snapshot (shedAs volatile, its own default band) must be the one shed instead");
});

/* ── Cross-repo prompt wording honesty (service-context staging fix) ──────────────────────────
   input.service.mirrorDir / input.services[].mirrorDir now carry a STAGED, bounded snapshot
   (src/server/service-context.ts), never the service's full working copy — the wording must say
   so, and any OpenAPI hint must be rendered under the contracts/ prefix the staging actually uses.
 */

test("cross-repo diff task: declares the service path a staged snapshot and prefixes the openapi hint with contracts/", () => {
  const assembled = buildPromptAssembled(mkInput({
    service: { repo: "org/orders-svc", mirrorDir: "/work/e2e/.qa/service-context/org__orders-svc", openapi: "openapi/orders.yaml" },
  }));
  assert.ok(claimsOf(assembled, "task").some((c) => isDeepStrictEqual(c, claim.provides("staged-service-snapshot"))), "the generation task never claims a full working copy is available");
  assert.ok(assembled.text.includes("contracts/openapi/orders.yaml"), "the openapi hint must point at the contracts/ prefix staging actually uses");
  assert.ok(!claimsOf(buildPromptAssembled(mkInput()), "task").some((c) => isDeepStrictEqual(c, claim.provides("staged-service-snapshot"))), "a run with no service stages nothing");
});

test("cross-repo diff task: an array openapi hint is prefixed per-entry, not just on the joined string", () => {
  const text = buildPrompt(mkInput({
    service: { repo: "org/orders-svc", mirrorDir: "/staged/org__orders-svc", openapi: ["openapi/orders.yaml", "openapi/payments.yaml"] },
  }));
  assert.ok(text.includes("contracts/openapi/orders.yaml"));
  assert.ok(text.includes("contracts/openapi/payments.yaml"));
});

/* The reviewer and the generator verdict parser read `specs` relative to the suite directory, the
   same path both generator role prompts name for a context run. */
test("buildContextTask: its output contract reports the map relative to the suite directory, not the repo", () => {
  const text = buildContextTask(mkInput({ mode: "context" }));
  const contract = JSON.parse(text.trim().split("\n").at(-1) ?? "") as { specs: string[] };
  assert.deepEqual(contract.specs, [".qa/context.json"]);
});

/* Approval is the independent reviewer's call, and `approved` is not a no-op signal: no generator prompt asks for it. */
test("buildContextTask: its output contract does not ask the generator for an approval", () => {
  const text = buildContextTask(mkInput({ mode: "context" }));
  const contract = JSON.parse(text.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
  assert.equal("approved" in contract, false);
});

test("buildContextTask: declares each microservice path a staged contract snapshot and prefixes hints with contracts/", () => {
  const input = mkInput({
    mode: "context",
    services: [
      { repo: "org/orders-svc", mirrorDir: "/staged/org__orders-svc", openapi: "openapi/orders.yaml" },
      { repo: "org/payments-svc", mirrorDir: "/staged/org__payments-svc" },
    ],
  });
  const text = buildContextTask(input);
  assert.ok(claimsOf(buildPromptAssembled(input), "task").some((c) => isDeepStrictEqual(c, claim.provides("staged-service-snapshot"))));
  assert.ok(text.includes("contracts/openapi/orders.yaml"));
  for (const service of input.services ?? []) assert.ok(text.includes(service.mirrorDir), `${service.repo}: the staged snapshot's local path is given`);
});

/* The reviewer judges the specs the generator delivered, inlined from disk. The generator names them in its verdict, so a name can lead anywhere the agent pointed it: a spec that leaves the spec directory is never inlined, and the reviewer gets a block with no code in it instead. */
function withReviewedMirror(run: (dirs: { tmp: string; mirror: string; specDir: string }) => void): void {
  const tmp = mkdtempSync(join(tmpdir(), "qa-review-specs-confinement-"));
  try {
    const mirror = join(tmp, "mirror");
    const specDir = join(mirror, "e2e");
    mkdirSync(join(specDir, "flows"), { recursive: true });
    writeFileSync(join(specDir, "flows", "ok.spec.ts"), "// inside the spec directory\n");
    writeFileSync(join(tmp, "secret.txt"), "TOP SECRET");
    run({ tmp, mirror, specDir });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const reviewOf = (mirror: string, specs: string[]): ReviewInput => ({ diff: "diff --git a/x b/x\n+const x = 1;", specs, mirrorDir: mirror, e2eRelDir: "e2e", appName: "demo", mode: "diff" });

/* A spec's block is its heading followed directly by a fenced code block; a refused one is the heading alone. */
function isInlined(text: string, heading: string): boolean {
  const at = text.indexOf(`### ${heading}\n`);
  assert.notEqual(at, -1, `${heading} has no block in the reviewer's specs`);
  return text.slice(at + `### ${heading}\n`.length).startsWith("```");
}

test("a delivered spec that leaves the spec directory is not inlined for the reviewer: it keeps its block without code, and the refusal is warned about by path", () => {
  withReviewedMirror(({ tmp, mirror, specDir }) => {
    symlinkSync(join(tmp, "secret.txt"), join(specDir, "flows", "leak.spec.ts"));
    const warnings: string[] = [];
    const warn = mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
    try {
      const text = renderReviewSpecs(reviewOf(mirror, ["flows/ok.spec.ts", "flows/leak.spec.ts"]));

      assert.equal(isInlined(text, "e2e/flows/ok.spec.ts"), true, "a spec inside the spec directory is inlined");
      assert.equal(isInlined(text, "e2e/flows/leak.spec.ts"), false, "a symlink out of the spec directory is not");
      assert.ok(text.includes("// inside the spec directory"));
      assert.ok(!text.includes("TOP SECRET"), "what the symlink points at never reaches the reviewer");
      assert.ok(warnings.some((w) => w.includes("e2e/flows/leak.spec.ts")), "the refusal is surfaced, naming the spec");
      assert.ok(!warnings.some((w) => w.includes("e2e/flows/ok.spec.ts")), "a spec that was read is not warned about");
    } finally {
      warn.mock.restore();
    }
  });
});

test("a delivered spec path that climbs out of the spec directory, or names a file that is not there, is not inlined for the reviewer either", () => {
  withReviewedMirror(({ mirror }) => {
    const warn = mock.method(console, "warn", () => undefined);
    try {
      const text = renderReviewSpecs(reviewOf(mirror, ["../../secret.txt", "flows/missing.spec.ts"]));

      assert.equal(isInlined(text, "e2e/../../secret.txt"), false);
      assert.equal(isInlined(text, "e2e/flows/missing.spec.ts"), false);
      assert.ok(!text.includes("TOP SECRET"), "a path that climbs out of the spec directory is not read");
    } finally {
      warn.mock.restore();
    }
  });
});

test("every spec of the reviewer is withheld when the spec directory's real path leaves the mirror through a symlinked parent", () => {
  withReviewedMirror(({ tmp, mirror }) => {
    mkdirSync(join(tmp, "elsewhere", "e2e"), { recursive: true });
    writeFileSync(join(tmp, "elsewhere", "e2e", "planted.spec.ts"), "// planted outside the mirror\n");
    symlinkSync(join(tmp, "elsewhere"), join(mirror, "hop"));
    const warn = mock.method(console, "warn", () => undefined);
    try {
      const text = renderReviewSpecs({ ...reviewOf(mirror, ["planted.spec.ts"]), e2eRelDir: "hop/e2e" });

      assert.equal(isInlined(text, "hop/e2e/planted.spec.ts"), false, "the anchor is the mirror: a real directory that lives outside it is refused");
      assert.ok(!text.includes("planted outside the mirror"));
    } finally {
      warn.mock.restore();
    }
  });
});

test("every spec of the reviewer is withheld when the spec directory itself is a symlink out of the mirror", () => {
  withReviewedMirror(({ tmp, mirror }) => {
    mkdirSync(join(tmp, "elsewhere"));
    writeFileSync(join(tmp, "elsewhere", "planted.spec.ts"), "// planted outside the mirror\n");
    symlinkSync(join(tmp, "elsewhere"), join(mirror, "e2e-out"));
    const warn = mock.method(console, "warn", () => undefined);
    try {
      const text = renderReviewSpecs({ ...reviewOf(mirror, ["planted.spec.ts"]), e2eRelDir: "e2e-out" });

      assert.equal(isInlined(text, "e2e-out/planted.spec.ts"), false);
      assert.ok(!text.includes("planted outside the mirror"));
    } finally {
      warn.mock.restore();
    }
  });
});

/* Reviewer output discipline: the prompt asks for one bounded JSON object, states the caps the
 * parser enforces, and carries its own version so a verdict can be tied to the wording. */

test("reviewer prompt: stamped with its version and the output caps the parser enforces, the verdict contract last", () => {
  const assembled = buildReviewerPromptAssembled({
    diff: "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n",
    specs: ["flows/checkout.spec.ts"],
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    appName: "testapp",
    mode: "diff",
  });

  assert.ok(assembled.text.includes(`reviewer-prompt-version: ${REVIEWER_PROMPT_VERSION}`));
  assert.equal(Object.keys(assembled.sectionSizes).at(-1), "reviewer-output-contract", "the verdict contract ends the prompt");
  for (const cap of [REVIEW_RATIONALE_MAX_CHARS, REVIEW_CORRECTIONS_MAX, REVIEW_CORRECTION_MAX_CHARS]) {
    assert.match(assembled.text, new RegExp(`\\b${cap}\\b`), `the cap ${cap} is stated`);
  }
  for (const correctionClass of REVIEW_CORRECTION_CLASSES) {
    assert.ok(assembled.text.includes(`[${correctionClass}]`), `the closed class list names ${correctionClass}`);
  }
});

test("reviewer prompt: the reply is one bare JSON object, and an empty corrections list is a complete answer", () => {
  const assembled = buildReviewerPromptAssembled({
    diff: "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n",
    specs: ["flows/checkout.spec.ts"],
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    appName: "testapp",
    mode: "diff",
  });
  assert.deepEqual(claimsOf(assembled, "reviewer-output-contract"), [claim.provides("bare-json-reply"), claim.provides("empty-corrections-valid")]);
});

test("reviewer prompt: a second round carries the spec change since the rejection, a first round does not", () => {
  const input = {
    diff: "",
    specs: ["flows/checkout.spec.ts"],
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    appName: "testapp",
    mode: "diff" as const,
    priorCorrections: ["[false-positive] checkout.spec.ts: the discount is never asserted"],
  };
  const firstRound = buildReviewerPromptAssembled(input);
  assert.equal(firstRound.sectionSizes["reviewer-spec-change"], undefined);

  const secondRound = buildReviewerPromptAssembled({
    ...input,
    specChanges: "### flows/checkout.spec.ts\n@@ line 4 @@\n- await expect(page.getByText(\"0 resultados\")).toBeVisible();\n+ await expect(page.getByText(\"11 restaurantes\")).toBeVisible();",
  });
  assert.notEqual(secondRound.sectionSizes["reviewer-spec-change"], undefined);
  assert.notEqual(secondRound.sectionSizes["reviewer-prior-corrections"], undefined);
  assert.ok(secondRound.text.includes("0 resultados") && secondRound.text.includes("11 restaurantes"), "both sides of the change are rendered");
});

test("reviewer prompt: the spec-change excerpt is bounded and sanitized", () => {
  const secret = "sk-liveSECRETVALUE123456";
  const { text } = buildReviewerPromptAssembled({
    diff: "",
    specs: ["flows/checkout.spec.ts"],
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    appName: "testapp",
    mode: "diff",
    specChanges: `### flows/checkout.spec.ts\n+const token = "${secret}";\n${"+ filler\n".repeat(2_000)}`,
  }, KNOWN_REVIEWER_WINDOW);

  assert.ok(!text.includes(secret), "a secret in the change excerpt must be redacted before it reaches the reviewer");
  assert.ok(Buffer.byteLength(text, "utf8") <= REVIEWER_BUDGET_BYTES);
});

/* No fixed count or length cuts the map: an app with hundreds of routes and operations is rendered whole, every entry supplied. */
test("renderArchitectureContextParts renders a large map whole, every entry of every list, past any fixed length", () => {
  const ctx: ArchitectureContext = {
    builtAtSha: "abc1234",
    routes: Array.from({ length: 250 }, (_, i) => ({ path: `/r${i}`, component: `RouteComponentNumber${i}` })),
    api: Array.from({ length: 250 }, (_, i) => ({ operationId: `op${i}`, method: "GET", path: `/p${i}` })),
    feBe: Array.from({ length: 230 }, (_, i) => ({ route: `/r${i % 250}`, operationId: `op${i % 250}`, via: "x" })),
    flows: Array.from({ length: 210 }, (_, i) => ({ id: `flow${i}`, routes: [`/f${i}`] })),
  };
  const parts = renderArchitectureContextParts(ctx, undefined, {})!;
  assert.ok(parts.text.length > 20_000);
  for (const needle of ["`/r249`", "`op249`", "**flow209**", "Route `/r229`"]) assert.ok(parts.text.includes(needle), needle);
  assert.doesNotMatch(parts.text, /truncated/);
  assert.deepEqual(parts.omissions, []);
  assert.equal(parts.itemIds.length, 250 + 250 + 230 + 210);
});

/* A list past the safety bound (a context.json the orchestrator does not control) keeps the bound's worth and counts what it left out. */
test("renderArchitectureContextParts counts exactly the entries the safety bound left out, per rendered list", () => {
  const over = MAP_ITEMS_SAFETY_BOUND + 5;
  const ctx: ArchitectureContext = {
    builtAtSha: "abc1234",
    routes: Array.from({ length: over }, (_, i) => ({ path: `/r${i}` })),
    api: Array.from({ length: over }, (_, i) => ({ operationId: `op${i}`, method: "GET", path: `/p${i}` })),
    feBe: [],
    flows: [],
  };
  assert.deepEqual(renderArchitectureContextParts(ctx, undefined, {})?.omissions, [{ class: "truncation", reason: "map-safety-bound", count: 10 }]);
  assert.deepEqual(renderArchitectureContextParts(ctx, undefined, { suppressApiOperations: true })?.omissions, [{ class: "truncation", reason: "map-safety-bound", count: 5 }]);
});

test("renderArchitectureContextParts reports no omission when every list is under the safety bound", () => {
  const ctx: ArchitectureContext = {
    builtAtSha: "abc1234",
    routes: [{ path: "/a" }, { path: "/b" }],
    api: [{ operationId: "listA", method: "GET", path: "/a" }],
    feBe: [{ route: "/a", operationId: "listA" }],
    flows: [{ id: "flow-a", routes: ["/a"] }],
  };
  assert.deepEqual(renderArchitectureContextParts(ctx, undefined, {})?.omissions, []);
});

test("buildPrompt fix-cases section states a failure tree read while the page was still changing as not settled", () => {
  const unsettled: QaCase = { name: "owners list", status: "fail", failureSettle: { inFlight: 2, quietMs: 30, treeStable: false }, failureResultCount: 0 };
  const text = buildPrompt(mkInput({ fixCases: [unsettled] }));
  assert.ok(describeSettle(unsettled.failureSettle!).startsWith(SETTLE_LABELS.unsettled), "a capture with data requests in flight or a changing tree is classified as not settled");
  assert.ok(text.includes(describeSettle(unsettled.failureSettle!)), "the capture is stated as not settled, with the in-flight count");
  assert.ok(text.includes(describeResultCount(unsettled.failureResultCount!)), "the declared data state's count at the failure point is stated");
});

test("buildPrompt fix-cases section states a settled failure tree as settled", () => {
  const settled: QaCase = { name: "owners list", status: "fail", failureSettle: { inFlight: 0, quietMs: 4200, treeStable: true } };
  const text = buildPrompt(mkInput({ fixCases: [settled] }));
  assert.ok(describeSettle(settled.failureSettle!).startsWith(SETTLE_LABELS.settled), "a quiet page with a stable tree is classified as settled");
  assert.ok(text.includes(describeSettle(settled.failureSettle!)));
  assert.equal(text.includes(SETTLE_LABELS.unsettled), false, "a quiet page with a stable tree is not stated as unsettled");
});
