/* The sections of a reviewer prompt, in prompt order, and the context they render from. The reviewer is independent of the generator: it sees the diff, the specs and the orchestrator's evidence, never the generator's reasoning. Never import src/. */

import { sanitizeText } from "../../../../shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { claim, SPEC_CONTENTS_INLINE_FACT, type PromptClaim } from "@contexts/generation/domain/prompt-contract-lint.ts";
import {
  REVIEWER_PROMPT_VERSION,
  REVIEW_CORRECTIONS_MAX,
  REVIEW_CORRECTION_MAX_CHARS,
  REVIEW_RATIONALE_MAX_CHARS,
} from "@contexts/generation/domain/review-output.ts";
import type { ReviewInput } from "../../domain/generation-input.ts";
import type { PromptFit } from "./generator-context.ts";
import { assemblerBudgetBytes } from "@kernel/context-budget.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
import { renderStepLimit } from "./prompt-text.ts";
import { reviewObjective, reviewSpecsOutcome, type ReviewSpecContents } from "./review-render.ts";
import type { PromptSectionDef, SectionRender } from "./prompt-sections.ts";
import type { SectionDegradation } from "@kernel/prompt-sections.ts";
import { REVIEWER_CHANGE_SECTIONS } from "./reviewer-change-sections.ts";
import { diffWindowDegrade } from "./plan-diff-section.ts";
import { countByDirectory, domPagesDegrade, NOT_SHOWN, referenceDegrade, stepsDegrade } from "../../domain/window-fit-references.ts";
import { availabilityLine } from "../../domain/route-availability-section.ts";

/* The reviewer's statement of its own cap is a section of its own, apart from the generator's. */
export const REVIEWER_STEP_LIMIT_SECTION_ID = "reviewer-step-limit";
/* The reviewer section that lists the arms of the changed code no delivered test ran. */
export const REVIEWER_MISSING_CASES_SECTION_ID = "reviewer-missing-cases";

export interface ReviewerContext {
  readonly input: ReviewInput;
  readonly budgetBytes: number | undefined;
  readonly changeType: string;
  readonly specBlock: string;
  /* The one outcome of whether the specs section holds the spec contents; the instructions and the section both render from it. */
  readonly specContents: ReviewSpecContents;
  readonly kind: string;
  readonly obj: ReturnType<typeof reviewObjective>;
  /* The parts of a planned run's change shown as references because the prompt did not fit the reviewer's window; empty otherwise. */
  readonly degraded: ReadonlySet<string>;
}

/* What a reviewer prompt is built with besides its input: the specs named to be read instead of inlined, when the window holds no less. */
export interface ReviewerContextOpts extends BuildReviewerPromptOpts {
  specsAsReferences?: boolean;
}

export interface BuildReviewerPromptOpts {
  /** Explicit byte-budget override. Absent, the budget derives from the reviewer's window. */
  budgetBytes?: number;
  /** The run's context window of a role, in tokens. Absent, or unknown for the reviewer: the prompt is not cut. */
  windowTokens?: (role: AgentRole) => number | undefined;
  /** Whether a prompt of this many bytes fits a role's window with the working room its turn needs. Absent, or unknown: every part of the change is shown. */
  fit?: PromptFit;
}

export function deriveReviewerContext(input: ReviewInput, opts: ReviewerContextOpts = {}): ReviewerContext {
  const changeType = input.intent?.type ?? input.mode;
  const { text: specBlock, contents: specContents } = reviewSpecsOutcome(input, { asReferences: opts.specsAsReferences === true });
  const kind = input.target === "code" ? "tests" : "E2E tests";
  const obj = reviewObjective(input);
  return { input, budgetBytes: opts.budgetBytes ?? assemblerBudgetBytes(opts.windowTokens?.("reviewer")), changeType, specBlock, specContents, kind, obj, degraded: new Set() };
}

function renderRoleFraming(ctx: ReviewerContext): SectionRender {
  const { kind, obj } = ctx;
  const roleFramingContent = [
    `<!-- reviewer-prompt-version: ${REVIEWER_PROMPT_VERSION} -->`,
    `## Independent review — judge these ${kind} WITHOUT the generator's reasoning`,
    ``,
    `You are reviewing tests written for ${obj.subject}, but you have NO access to the`,
    `generator's thought process. Judge the tests on their own merit using the`,
    `test-value-review skill.`,
    ``,
  ].join("\n");
  return { content: roleFramingContent };
}

/* The run's type and the DEV it ran against: facts of the run, rendered apart from the framing and outside the stable prefix. */
function renderReviewContext({ input, changeType }: ReviewerContext): SectionRender {
  return { content: [`## Review context`, `- Run type: ${changeType}`, `- Base URL: ${input.baseUrl ?? "(not provided)"}`].join("\n") };
}

function renderInstructions(ctx: ReviewerContext): SectionRender {
  const { input, obj, specContents } = ctx;
  const specsInstruction = specContents === "inline"
    ? `1. The spec contents are provided in this prompt — no need to read files.`
    : `1. The spec contents are not in this prompt — read each listed spec file with the read tool.`;
  const rulesInstruction = input.learnedRules
    ? [`7. Also REJECT if any spec violates an app-specific reject-on-sight rule provided in this prompt.`]
    : [];
  const instructionsContent = [
    `## Instructions`,
    specsInstruction,
    `2. Apply the test-value-review skill from BOTH perspectives (value + robustness).`,
    `3. Answer: could ${obj.targetNoun} be BROKEN and these tests STILL be green?`,
    `4. Be strict — a single anti-pattern in any spec means rejection.`,
    `5. STAY IN YOUR LANE — judge VALUE and ROBUSTNESS. The GENERATOR owns ground-truth against the`
      + ` live app (it navigated DEV). Judge a concrete UI fact (exact label, button/link text, route)`
      + ` ONLY when the ${input.domSnapshot ? "Live DEV DOM section" : "spec itself"} confirms it. NEVER`
      + ` assert a UI fact from memory: an unconfirmed guess that a label/route "should be" something is`
      + ` NOT a valid correction — omit it. Reject on what you can SEE (no assertions, fragile selectors,`
      + ` wrong objective, missing cleanup), not on guessed app specifics.`,
    `6. The "Specs under review" are the specs this run delivered. The "Existing suite" section is`
      + ` context only: never reject a spec because an existing suite file does not cover this change.`,
    ...rulesInstruction,
  ].join("\n");
  /* The instruction refers to the spec contents only while the specs section provides them (R13: `spec-contents-inline`). */
  return { content: instructionsContent };
}

function renderOutputContract(ctx: ReviewerContext): SectionRender {
  const { obj } = ctx;
  const outputContractContent = [
    `## Output — one JSON object, nothing else`,
    `Your ENTIRE reply is the JSON object below: no prose before or after it, no markdown fence, no`,
    `restatement of the specs, no analysis of your process. Text outside the object is discarded.`,
    `- "rationale": 1-2 sentences, ${REVIEW_RATIONALE_MAX_CHARS} characters at most, on APPROVAL too —`,
    `  name ${obj.targetNoun} and what these tests do or fail to do about it.`,
    `- "corrections": at most ${REVIEW_CORRECTIONS_MAX} entries, each "text" at most ${REVIEW_CORRECTION_MAX_CHARS}`,
    `  characters (what file, what to change, why), blocking entries first.`,
    `Prefix EVERY correction with exactly one class tag from this closed list so the failure`,
    `is machine-classifiable: [false-positive] (asserts nothing / passes when the feature is`,
    `broken), [wrong-objective] (does not test ${obj.targetNoun}), [fragile-selector] (ambiguous or`,
    `brittle locator), [no-cleanup] (leaves test data behind), or [other].`,
    `Each correction MUST be a structured object with "text" (the actionable message, prefixed with the class tag) and "severity":`,
    `- "blocking": this issue makes the test worthless (false-positive, wrong-objective, missing cleanup) — fails the gate.`,
    `- "advisory": style/robustness nit that does not make the test worthless alone — recorded but does not fail the gate.`,
    `An unconfirmable UI selector (no DOM evidence in this prompt) MUST be advisory, never blocking.`,
    `Every correction MUST also carry "citation", the evidence it rests on, as {"kind":...,"ref":...}:`,
    `- "contract": the spec's contract clause it violates; ref is "<spec path>#<clause>".`,
    `- "execution": an execution of this run that shows it; ref is the "<spec path>" that ran.`,
    `- "dom": a fact from the DOM section above; ref is the "<spec path>" it concerns (always advisory).`,
    `A correction with no citation cannot block: the orchestrator treats it as advisory at most.`,
    `An empty "corrections" list beside "approved": true is a complete answer — never invent a finding to look thorough.`,
    `{"approved":false,"rationale":"why, in 1-2 sentences","corrections":[{"text":"[fragile-selector] file.spec.ts: specific actionable fix","severity":"blocking","citation":{"kind":"execution","ref":"file.spec.ts"}}]}`,
  ].join("\n");
  return { content: outputContractContent, claims: [claim.provides("bare-json-reply"), claim.provides("empty-corrections-valid")] };
}

/* Live DEV DOM: actual roles + accessible names on the routes this spec targets. Captured by the orchestrator (reviewer independence). Model-mode sanitization — this is prompt text, never an Issue body. */
function renderDom(ctx: ReviewerContext): SectionRender {
  const { input } = ctx;
  const wrap = (dom: string): string =>
    [
      `## Live DEV DOM — the ACTUAL roles + accessible names on the routes this spec targets`,
      `Captured by the orchestrator from ${input.baseUrl ?? "DEV"}. Judge EVERY concrete UI fact`,
      `(button/link labels, headings, routes) against THIS, never against prior knowledge of similar apps.`,
      "```",
      dom,
      "```",
    ].join("\n");
  const dom = input.domSnapshot ? sanitizeText(input.domSnapshot, "model").text : "";
  /* Whole; over the window the last page gives way first, each named by its route. */
  return { content: dom ? wrap(dom) : "", overflow: "summarize", degrade: domPagesDegrade({ dom, wrap }) };
}

/* The existing suite is context, never a review target: the reviewer sees what already exists so it does not mistake a pre-existing file for a missing part of this change. */
function renderExistingSuite(ctx: ReviewerContext): SectionRender {
  const { input } = ctx;
  const files = (input.existingSpecFiles ?? []).map((file) => sanitizeText(file).text);
  const head = [
    `## Existing suite — context only`,
    `These files already exist in the suite. Do NOT judge them and do NOT raise corrections against them; judge only the specs in the "Specs under review" section.`,
  ];
  const existingSpecsContent = files.length > 0 ? [...head, ...files.map((file) => `- ${file}`)].join("\n") : "";
  /* The listing is context for the reviewer, never a target of its review. */
  const existingSpecsClaims: PromptClaim[] = existingSpecsContent ? [claim.provides("existing-suite"), claim.frames("existing-suite", "unverified")] : [];
  /* Over the window the files are counted by directory: each directory is named, its files are not. */
  const byDirectory = [...head, `The ${files.length} file(s) are ${NOT_SHOWN}; by directory:`, ...countByDirectory(files)].join("\n");
  return { content: existingSpecsContent, claims: existingSpecsClaims, overflow: "summarize", degrade: referenceDegrade(byDirectory, files.length) };
}

function renderMissingCases({ input }: ReviewerContext): SectionRender {
  const arms = input.untakenArms ?? [];
  const head = [
    `## Decisions of the change no test ran — measured by the orchestrator`,
    `Each line is an arm of a decision on a changed line that no delivered test ran in this run's browser coverage.`,
    `When one is a behaviour worth a test that the page can be brought to through the UI against DEV, report it as a`,
    `correction prefixed [missing-case], with "severity":"advisory" and "citation":{"kind":"arm","ref":"<file>:<line>"} as listed.`,
    `A missing case is recorded and shown with the run; it never changes "approved".`,
  ];
  const linesByFile = new Map<string, number[]>();
  for (const arm of arms) {
    const file = sanitizeText(arm.file, "model").text;
    linesByFile.set(file, [...(linesByFile.get(file) ?? []), arm.line]);
  }
  /* Over the window: first each file with the lines of its arms (a citation still names one), then each file with how many arms it holds. */
  const asLines = [...head, `What each arm is, is ${NOT_SHOWN}; each file with the lines of its arms:`, ...[...linesByFile].map(([file, lines]) => `- ${file}:${lines.join(",")}`)].join("\n");
  const asCounts = [...head, `The ${arms.length} arm(s) are ${NOT_SHOWN}; each file with how many it holds:`, ...[...linesByFile].map(([file, lines]) => `- ${file}: ${lines.length} arm(s)`)].join("\n");
  return {
    content: [...head, ...arms.map((u) => `- ${sanitizeText(`${u.file}:${u.line} ${u.kind}: ${u.arm}`, "model").text}`)].join("\n"),
    overflow: "summarize",
    degrade: stepsDegrade([{ content: asLines, items: arms.length }, { content: asCounts, items: arms.length }]),
  };
}

/* The run's availability facts: where the browser ends on each route the capture could not show at its own address, and why. A finding that a spec claims to cover such a route but never asserts where it ends can cite one. */
function renderRouteAvailability({ input }: ReviewerContext): SectionRender {
  const facts = input.routeAvailability ?? [];
  const head = [
    `## Route availability — classified by the orchestrator from this run's capture`,
    `A finding about where one of these routes ends may cite "citation":{"kind":"availability","ref":"<route>"} with the route as listed.`,
  ];
  /* Over the window: first each route with its class (a citation still names one), then each class with how many routes it holds. */
  const asRoutes = [...head, `Where each ends and why is ${NOT_SHOWN}; each route with its class:`, ...facts.map((fact) => sanitizeText(`- ${fact.route}: ${fact.basis.class}`, "model").text)].join("\n");
  const byClass = new Map<string, number>();
  for (const fact of facts) byClass.set(fact.basis.class, (byClass.get(fact.basis.class) ?? 0) + 1);
  const asCounts = [...head, `The ${facts.length} route(s) are ${NOT_SHOWN}; by class:`, ...[...byClass].map(([cls, count]) => `- ${cls}: ${count}`)].join("\n");
  return {
    content: [...head, ...facts.map((fact) => sanitizeText(availabilityLine(fact), "model").text)].join("\n"),
    overflow: "summarize",
    degrade: stepsDegrade([{ content: asRoutes, items: facts.length }, { content: asCounts, items: facts.length }]),
  };
}

function renderPriorCorrections(ctx: ReviewerContext): SectionRender {
  const { input } = ctx;
  const corrections = input.priorCorrections ?? [];
  if (corrections.length === 0) return { content: "" };
  const head = [
    `## Prior-round corrections (from YOUR previous verdict on these specs)`,
    ``,
    `Only the specs listed as materially changed in the next section are new to you; the spec`,
    `change is excerpted there. Judge that change, not the whole suite again.`,
    `- APPROVE if the previously-raised BLOCKING issues are resolved (do not re-raise them).`,
    `- Raise a NEW blocking correction only if the change introduced a new anti-pattern.`,
    `- Omit advisory nits; they are not worth a round.`,
    ``,
  ];
  const content = [...head, corrections.map((c, i) => `${i + 1}. ${sanitizeText(c).text}`).join("\n")].join("\n");
  return { content, degrade: referenceDegrade([...head, `The ${corrections.length} correction(s) of your previous verdict are ${NOT_SHOWN}.`].join("\n"), corrections.length) };
}

/* Second-round focus: the spec lines that changed since the reviewer's own rejection, bounded and sanitized like every other agent-authored text that becomes prompt text. */
function renderSpecChange(ctx: ReviewerContext): SectionRender {
  const { input } = ctx;
  if (!input.specChanges || input.specChanges.trim() === "") return { content: "" };
  const head = [`## Spec change since your last rejection (material change only)`, ``];
  const change = sanitizeText(input.specChanges, "model").text;
  const content = [
    ...head,
    `This is the change the generator made in response to your corrections. Anything not shown here`,
    `is unchanged since the specs you already judged.`,
    ``,
    change,
  ].join("\n");
  const lines = change.split("\n").length;
  return { content, degrade: referenceDegrade([...head, `The change (${lines} line(s)) is ${NOT_SHOWN}: judge it from the specs under review.`].join("\n"), lines) };
}

const referencesTheDiff = (degrade: (step: number) => SectionDegradation | undefined) => (step: number): SectionDegradation | undefined => {
  const next = degrade(step);
  return next === undefined ? undefined : { ...next, claims: [claim.provides("diff")] };
};

export const REVIEWER_SECTIONS: readonly PromptSectionDef<ReviewerContext>[] = [
  { id: "reviewer-role-framing", tier: "stable-prefix", priority: 1, stability: "static", reason: "Reviewer independence: it judges the tests on their own merit, without the generator's reasoning (bd29f624)", applies: () => true, render: renderRoleFraming },
  { id: "reviewer-instructions", tier: "stable-prefix", priority: 2, stability: "static", reason: "Keeps the reviewer in its lane: no UI fact from memory, no rejection over the existing suite (875a6004, 8fea750c)", applies: () => true, render: renderInstructions },
  /* First of the run's facts, right after the stable prefix. */
  { id: "reviewer-review-context", tier: "semi-stable", priority: 0, stability: "run", reason: "The run type and the DEV URL the review is about, kept out of the framing so the stable prefix carries no run fact (bd29f624)", applies: () => true, render: renderReviewContext },
  {
    id: "reviewer-objective",
    tier: "semi-stable",
    priority: 1, stability: "run", reason: "What the tests must prove in this run: the change, the guidance or the targeted flow",
    applies: () => true,
    /* The commit diff is whole; over the window its hunks give way as `path:start-end` references, and the references say where the diff is (a claim only that render needs). */
    render: ({ obj }) => ({ content: [obj.heading, ...obj.body].join("\n"), language: "verbatim", overflow: "summarize", ...(obj.diff !== undefined ? { degrade: referencesTheDiff(diffWindowDegrade(obj.diff)) } : {}) }),
  },
  /* A planned run's change by flow under review, in place of the whole diff the objective carries otherwise. */
  ...REVIEWER_CHANGE_SECTIONS,
  /* VOLATILE: DOM grounding (priority 1 — first in VOLATILE so it precedes the spec contents that reference it; the instructions refer to it position-independently as "the Live DEV DOM section"). Whole while the window holds it; past it, page by page as references. */
  { id: "reviewer-dom", tier: "volatile", priority: 1, stability: "run", reason: "UI facts are judged against the live DOM the orchestrator captured, never prior knowledge (875a6004)", applies: ({ input }) => Boolean(input.domSnapshot), render: renderDom },
  /* VOLATILE: runtime execution evidence. Deterministic orchestrator evidence (HTTP status codes + final URLs captured via page.on('response')) injected BEFORE the spec contents so the reviewer can weigh the objective server-error signal before reading test code. Priority 1.5 — after DOM grounding (which grounds UI facts) but before specs themselves. Absent when the run produced no execution evidence (first-time generate, code mode, etc.). */
  { id: "reviewer-execution-result", tier: "volatile", priority: 1.5, stability: "run", reason: "Runtime server-error evidence, weighed before the test code (f8fa33f8)", applies: ({ input }) => Boolean(input.executionResult), render: ({ input }) => ({ content: input.executionResult ?? "" }) },
  { id: "reviewer-specs", tier: "volatile", priority: 2, stability: "run", reason: "The specs under review, inline or to be read, from the one outcome the instructions also render from", applies: () => true, render: ({ specBlock, specContents }) => ({ content: specBlock, overflow: "summarize", ...(specContents === "inline" ? { claims: [claim.provides(SPEC_CONTENTS_INLINE_FACT)] } : {}) }) },
  { id: "reviewer-existing-suite", tier: "volatile", priority: 3, stability: "run", reason: "Existing specs as context only: the reviewer judges only what this run delivered (8fea750c)", applies: ({ input }) => Boolean(input.existingSpecFiles?.length), render: renderExistingSuite },
  {
    id: "reviewer-learned-rules",
    tier: "volatile",
    priority: 3, stability: "run", reason: "The app's reject-on-sight rules from the learning ledger",
    applies: ({ input }) => Boolean(input.learnedRules),
    render: ({ input }) => ({ content: [``, input.learnedRules].join("\n") }),
  },
  /* The arms of the changed code no delivered test ran, measured by the orchestrator: a missing case cites one of them, and it is a record, never a reason to reject. */
  { id: REVIEWER_MISSING_CASES_SECTION_ID, tier: "volatile", priority: 3, stability: "run", reason: "The arms no test ran, so a missing case cites a measured arm and never gates (d717095d)", applies: ({ input }) => Boolean(input.untakenArms?.length), render: renderMissingCases },
  /* Where the routes the capture could not show at their own address end, and why: an `availability` citation names one. */
  { id: "reviewer-route-availability", tier: "volatile", priority: 3, stability: "run", reason: "A spec that claims to cover a route the change makes unavailable can be checked against where the run saw it end (route-availability S2)", applies: ({ input }) => Boolean(input.routeAvailability?.length), render: renderRouteAvailability },
  /* VOLATILE: prior-round corrections (priority 4 — convergence context; lowest priority in VOLATILE so it does not crowd out the spec contents or DOM grounding on budget overflow). */
  { id: "reviewer-prior-corrections", tier: "volatile", priority: 4, stability: "run", reason: "Convergent rounds: approve once the earlier blocking findings are resolved (14ec74b7)", applies: ({ input }) => Boolean(input.priorCorrections?.length), render: renderPriorCorrections },
  /* What the generator changed since the rejection this round answers: the smallest section in the prompt, and the one the round is about. Shed first when the window is tight. */
  {
    id: "reviewer-spec-change",
    tier: "volatile",
    priority: 5, stability: "run", reason: "A second round judges what changed since its rejection, not the whole suite again (92cfc1ef)",
    applies: ({ input }) => Boolean(input.specChanges) && input.specChanges!.trim() !== "",
    render: renderSpecChange,
  },
  /* The cap the reviewer's session runs under, when the host resolved one: a fact of its own, placed before the verdict contract so that the contract still ends the prompt. */
  {
    id: REVIEWER_STEP_LIMIT_SECTION_ID,
    tier: "critical-recap",
    priority: 0, stability: "run", reason: "The cap the reviewer's session runs under, when the host resolved one (78d1bef4)",
    applies: ({ input }) => input.stepLimit !== undefined,
    render: ({ input }) => ({ content: renderStepLimit(input.stepLimit!), claims: [claim.provides("step-limit")] }),
  },
  { id: "reviewer-output-contract", tier: "critical-recap", priority: 1, stability: "static", reason: "One bare JSON verdict with tagged, cited corrections; an uncited finding cannot block (evidence-bound review)", applies: () => true, render: renderOutputContract },
];
