/* Renders the GitHub markdown for a run: the Issue body for a failing/invalid/flaky run and the PR body for a green publish. The goal is REVIEWER-FACING DOCUMENTATION — a concise, high-level account of what was tested, what was found, and what to do — NOT a log dump. PURE, no sanitizer dependency: every field here is markdown-composed from caller-supplied, already-untrusted text. The CALLER (publication-port.adapter.ts) sanitizes the WHOLE composed body string returned by renderIssue/renderPrBody before it ever reaches GitHub — a single whole-body sanitize pass satisfies "every rendered field passes the injected sanitizer" (the spec's own MUST) without threading a sanitize callback through every render helper in this file, and keeps this domain file testable with zero collaborators (matches this context's OWN write-confinement.service.ts precedent: pure classifiers, effectful wiring lives one layer out). */
import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { outcomeText, type RouteAvailabilityFact } from "@kernel/route-availability.ts";
import { dataContradictionStatement, type DataContradiction } from "@kernel/data-contradiction.ts";

export interface TestedItem {
  flow?: string;
  objective?: string;
}


export interface AdjudicationLabel {
  class: string;
  confidence: string;
  reason: string;
}

/* The change-reach label of a failing run, as the Issue shows it. */
export interface CausalLabelView {
  reach: string;
  basis: string;
  via: readonly string[];
  reason: string;
  cases: ReadonlyArray<{ name: string; reach: string; basis: string }>;
}

const MAX_ITEMS = 50;
const CAP_NAME = 200;
const CAP_CAUSE = 200;
const CAP_FLOW = 120;
const CAP_OBJECTIVE = 300;
/* A data contradiction names two operations by their address and says what each returned: longer than an objective. */
const CAP_CONTRADICTION = 900;
const MAX_STUBS_PER_GAP = 3;

const cap = (v: string, max: number): string =>
  v.length <= max ? v : v.slice(0, max).trimEnd() + ` …(+${v.length - max} chars)`;

function oneLineCause(detail: string): string {
  const lines = detail.split("\n").map((l) => l.trim()).filter(Boolean);
  const pick = lines.find((l) => /error|expect|timeout|fail|assert|not found|exceeded/i.test(l)) ?? lines[0] ?? "";
  return cap(pick, CAP_CAUSE);
}

function renderTestedItem(t: TestedItem): string {
  const flow = t.flow ? cap(t.flow, CAP_FLOW) : "";
  const obj = t.objective ? cap(t.objective, CAP_OBJECTIVE) : "";
  if (flow && obj) return `- **${flow}** — ${obj}`;
  if (flow) return `- **${flow}**`;
  if (obj) return `- ${obj}`;
  return "";
}

function renderFailedCase(c: QaCase): string {
  const lines = [`- **${cap(c.name, CAP_NAME)}**${c.detail ? ` — ${oneLineCause(c.detail)}` : ""}`];
  if (c.objective) lines.push(`  - tested: ${cap(c.objective, CAP_OBJECTIVE)}`);
  if (c.reason) lines.push(`  - fix: ${cap(c.reason, CAP_OBJECTIVE)}`);
  return lines.join("\n");
}

function headline(verdict: RunVerdict, failedCount: number, totalCount: number, flakyCount: number): string {
  switch (verdict) {
    case "fail":
      return totalCount
        ? `${failedCount} of ${totalCount} check(s) failed against the live environment`
        : "the tests failed against the live environment";
    case "invalid":
      return "the generated tests could not be validated (static gate)";
    case "flaky":
      return `${flakyCount} test(s) were unstable and were quarantined`;
    default:
      return "the generated tests need changes before they can land";
  }
}

function renderAdjudicationSection(a: AdjudicationLabel): string {
  const heading = a.confidence === "low"
    ? "Engine adjudication (low confidence — treat as a hint)"
    : "Engine adjudication";
  return [heading, `- Class: ${a.class}`, `- Confidence: ${a.confidence}`, `- Reason: ${a.reason}`].join("\n");
}

const REACH_WORDS: Record<string, string> = { "in-reach": "in the change's reach", "out-of-reach": "outside the change's reach", unknown: "reach unknown" };

/* What the failure says about the change, in the evidence's own terms: the run-level reach, how it was established, the entries it rests on and at most MAX_ITEMS cases. A recorded label, not a decision. */
function renderCausalSection(c: CausalLabelView): string {
  const lines = ["Change reach", `- Reach: ${REACH_WORDS[c.reach] ?? c.reach}`, `- Basis: ${c.basis}`];
  if (c.via.length) lines.push(`- Via: ${c.via.slice(0, MAX_ITEMS).map((v) => `\`${cap(v, CAP_NAME)}\``).join(", ")}`);
  lines.push(`- Reason: ${cap(c.reason, CAP_CAUSE)}`);
  const shown = c.cases.slice(0, MAX_ITEMS);
  for (const k of shown) lines.push(`  - ${cap(k.name, CAP_NAME)}: ${REACH_WORDS[k.reach] ?? k.reach} (${k.basis})`);
  if (c.cases.length > shown.length) lines.push(`  - …and ${c.cases.length - shown.length} more case(s) omitted`);
  return lines.join("\n");
}

/* Threaded ONLY for the reviewer-unavailable fail-closed exit, never a genuine reviewer rejection (corrections are already that signal) — the caller's own contract. */
function renderReviewerNoteSection(note: string): string {
  return ["Reviewer unavailable", note].join("\n");
}

/* The tests that fulfil a stated response instead of reading DEV, and the guards they broke, as the run recorded them. */
export interface StubbedStateView {
  tests: ReadonlyArray<{ file: string; name: string; response?: string; routes: readonly string[]; fulfils?: readonly string[] }>;
  violations?: ReadonlyArray<{ file: string; kind: string; test?: string }>;
}

const STUB_MARKER_PREFIX = /^\s*\[stubbed:[^\]]*\]\s*/i;

const GUARD_MEANING: Record<string, string> = {
  "fulfil-without-get-guard": "a fulfil no explicit GET check guards would answer a write too",
  "unverifiable-handler": "its route handler is not in the file, so it cannot be shown to fulfil only reads",
  "override-changes-request": "a continue or fallback sets the request's method or body",
  "har-replay": "a HAR replay answers every method it recorded",
  "no-live-test": "every test of the spec file is stubbed: no live test sits beside them",
};

function renderStubbedTest(t: StubbedStateView["tests"][number]): string {
  const title = t.response !== undefined ? t.name.replace(STUB_MARKER_PREFIX, "") : t.name;
  const routes = t.routes.length > 0 ? ` (${t.routes.map((r) => `\`${cap(r, CAP_FLOW)}\``).join(", ")})` : "";
  const against =
    t.response !== undefined ? cap(t.response, CAP_OBJECTIVE) + routes
    : t.routes.length > 0 ? `the response its handler fulfils${routes}`
    : "a helper it calls could not be read, so it is counted as stubbed";
  return `- \`${cap(t.file, CAP_FLOW)}\` › ${cap(title, CAP_NAME)} — ${against}`;
}

/* The stubbed tests as a section of their own, and the guards they broke: what the reader must know about a test that holds for a stated response and not for what DEV returns. Empty when there is neither. A record for the reader, never a gate. */
function renderStubbedSection(state: StubbedStateView | undefined): string {
  const tests = (state?.tests ?? []).slice(0, MAX_ITEMS);
  const violations = (state?.violations ?? []).slice(0, MAX_ITEMS);
  const blocks: string[] = [];
  if (tests.length > 0) blocks.push(`**Tested against a stated response, not DEV** (these tests fulfil the responses they state through the browser's route interception: they hold for those responses, not for what DEV returns; a signal, not a gate):\n${tests.map(renderStubbedTest).join("\n")}`);
  if (violations.length > 0) {
    const line = (v: NonNullable<StubbedStateView["violations"]>[number]): string => `- \`${cap(v.file, CAP_FLOW)}\`${v.test !== undefined ? ` › ${cap(v.test, CAP_NAME)}` : ""} — ${v.kind}: ${GUARD_MEANING[v.kind] ?? "a guard of the stubbed-state rules"}`;
    blocks.push(`**Guards these tests broke** (the stubbed-state rules: only reads are fulfilled, a write is never faked, and a live test sits beside; a signal, not a gate):\n${violations.map(line).join("\n")}`);
  }
  return blocks.join("\n\n");
}

export interface RenderIssueInput {
  verdict: RunVerdict;
  cases: readonly QaCase[];
  sha?: string;
  tested?: TestedItem[];
  adjudication?: AdjudicationLabel;
  /* Absent for a run with no failing case: the Issue then says nothing about reach. */
  causal?: CausalLabelView;
  reviewerNote?: string;
  /* The reviewer's missing cases: behaviours the change decides that no test runs. */
  missingCases?: readonly string[];
  /* The routes the change made unavailable and the possible regressions, from the run's availability classification. */
  routeAvailability?: readonly RouteAvailabilityFact[];
  /* The delivered tests that fulfil a stated response instead of reading DEV, and the guards they broke. */
  stubbedState?: StubbedStateView;
  /* The fields the consumer's code expects of an answer that the run's captured pages' answers lack, from the response shapes the capture read. */
  dataContradictions?: readonly DataContradiction[];
}

/* The reviewer's missing cases as a section of their own; empty when there are none. A record for the reader, never a gate. */
function renderMissingCasesSection(missingCases: readonly string[] | undefined): string {
  const shown = (missingCases ?? []).filter((text) => text.trim() !== "").slice(0, MAX_ITEMS);
  if (shown.length === 0) return "";
  return `**Cases the change decides that no test runs** (the reviewer's reading of the measured arms; not a gate):\n${shown.map((text) => `- ${cap(text, CAP_OBJECTIVE)}`).join("\n")}`;
}

/* Where each fact's evidence is: the route table entry or guard the change governs it by, or the reach of a possible regression. */
function availabilityEvidence(fact: RouteAvailabilityFact): string {
  const basis = fact.basis;
  if (basis.class === "change-introduced") return basis.via === "route-declaration" ? `its route table entry changed at ${basis.at}` : `a changed symbol reaches its guard ${basis.at}`;
  if (basis.class === "regression-candidate") return basis.reach === "governs" ? "the change governs it and the page logged a runtime error" : "the change reaches the page and it logged a runtime error";
  return basis.class;
}

/* The route availability the reader must see: every unavailability the change introduced (a new contract the tests may assert), and every possible regression. Empty when there is neither. A record for the reader, never a gate. */
function renderAvailabilitySection(facts: readonly RouteAvailabilityFact[] | undefined): string {
  const line = (fact: RouteAvailabilityFact): string => `- \`${cap(fact.route, CAP_FLOW)}\` ends on ${cap(outcomeText(fact.outcome), CAP_FLOW)}: ${cap(availabilityEvidence(fact), CAP_CAUSE)}`;
  const introduced = (facts ?? []).filter((fact) => fact.basis.class === "change-introduced").slice(0, MAX_ITEMS);
  const regressions = (facts ?? []).filter((fact) => fact.basis.class === "regression-candidate").slice(0, MAX_ITEMS);
  const blocks: string[] = [];
  if (introduced.length > 0) blocks.push(`**Routes this change makes unavailable** (the change governs where they send the browser; check that this is intended):\n${introduced.map(line).join("\n")}`);
  if (regressions.length > 0) blocks.push(`**Possible regressions** (a route the change reaches is sent away after a runtime error; a signal, not a gate):\n${regressions.map(line).join("\n")}`);
  return blocks.join("\n\n");
}

/* The stubbed tests that fulfil a field a gap lacks, as lines under the gap: a test that states a response carrying the field the live answers do not corroborates the gap, but it is a test of the stated response, not of DEV. A test whose body the spec does not state is linked to none. */
function corroboratingStubs(fact: DataContradiction, state: StubbedStateView | undefined): string[] {
  return (state?.tests ?? [])
    .filter((t) => t.fulfils?.includes(fact.key))
    .slice(0, MAX_STUBS_PER_GAP)
    .map((t) => `  - also tested against a stated response that fulfils "${cap(fact.key, CAP_NAME)}": \`${cap(t.file, CAP_FLOW)}\` › ${cap(t.response !== undefined ? t.name.replace(STUB_MARKER_PREFIX, "") : t.name, CAP_NAME)}`);
}

/* The data contradictions of the run's pages: a field the consumer's own code expects of an answer that no response of the operation carries. A possible defect of the app's data (or of the provider's contract), which a test written around it would hide; a record for the reader, never a gate. */
function renderDataContradictionsSection(facts: readonly DataContradiction[] | undefined, stubbed: StubbedStateView | undefined): string {
  const shown = (facts ?? []).slice(0, MAX_ITEMS);
  if (shown.length === 0) return "";
  const page = (fact: DataContradiction): string => (fact.template === undefined ? `\`${cap(fact.route, CAP_FLOW)}\`` : `\`${cap(fact.route, CAP_FLOW)}\` (instance of \`${cap(fact.template, CAP_FLOW)}\`)`);
  const more = (facts ?? []).length - shown.length;
  const omitted = more > 0 ? `\n_…and ${more} more omitted._` : "";
  const lines = shown.flatMap((fact) => [`- ${page(fact)}: ${cap(dataContradictionStatement(fact), CAP_CONTRADICTION)}`, ...corroboratingStubs(fact, stubbed)]);
  return `**Possible data contradictions** (a field the consumer's own code expects of an answer, that its declared type holds and its code reads and never writes, is absent from every response the page received; it may be a defect of the app's data or of the provider's contract, not of the tests; a signal, not a gate):\n${lines.join("\n")}${omitted}`;
}

export function renderIssue(input: RenderIssueInput): string {
  const failed = input.cases.filter((c) => c.status === "fail");
  const flaky = input.cases.filter((c) => c.status === "flaky");
  const shownFailed = failed.slice(0, MAX_ITEMS);
  const omittedFailed = failed.length - shownFailed.length;

  const blocks: string[] = [`## QA — ${headline(input.verdict, failed.length, input.cases.length, flaky.length)}`];

  blocks.push(input.sha ? `**SHA:** \`${input.sha}\` · **Verdict:** ${input.verdict}` : `**Verdict:** ${input.verdict}`);

  const tested = (input.tested ?? []).filter((t) => t.flow || t.objective).slice(0, MAX_ITEMS);
  if (tested.length) {
    blocks.push(`### What was tested\n${tested.map(renderTestedItem).filter(Boolean).join("\n")}`);
  }

  if (shownFailed.length) {
    const omitted = omittedFailed > 0 ? `\n\n_…and ${omittedFailed} more failed case(s) omitted._` : "";
    blocks.push(`### Failing cases\n${shownFailed.map(renderFailedCase).join("\n")}${omitted}`);
  }

  if (flaky.length) {
    blocks.push(`### Flaky (quarantined)\n${flaky.slice(0, MAX_ITEMS).map((c) => `- ⚠️ ${cap(c.name, CAP_NAME)}`).join("\n")}`);
  }

  if (input.adjudication) {
    blocks.push(renderAdjudicationSection(input.adjudication));
  }
  if (input.causal) {
    blocks.push(renderCausalSection(input.causal));
  }
  if (input.reviewerNote && input.reviewerNote.trim()) {
    blocks.push(renderReviewerNoteSection(input.reviewerNote));
  }
  const missing = renderMissingCasesSection(input.missingCases);
  if (missing) blocks.push(missing);
  const availability = renderAvailabilitySection(input.routeAvailability);
  if (availability) blocks.push(availability);
  const stubbed = renderStubbedSection(input.stubbedState);
  if (stubbed) blocks.push(stubbed);
  const contradictions = renderDataContradictionsSection(input.dataContradictions, input.stubbedState);
  if (contradictions) blocks.push(contradictions);

  const head = blocks.join("\n\n");
  const footer = "\n\n_Full trace + logs in the run artifacts (trace on-first-retry)._";
  return `${head}${footer}`;
}

export interface RenderPrBodyInput {
  sha?: string;
  isCode: boolean;
  tested?: TestedItem[];
  parentRunId?: string;
  /* The reviewer's missing cases: behaviours the change decides that no test runs. */
  missingCases?: readonly string[];
  /* The routes the change made unavailable and the possible regressions, from the run's availability classification. */
  routeAvailability?: readonly RouteAvailabilityFact[];
  /* The delivered tests that fulfil a stated response instead of reading DEV, and the guards they broke. */
  stubbedState?: StubbedStateView;
  /* The fields the consumer's code expects of an answer that the run's captured pages' answers lack, from the response shapes the capture read. */
  dataContradictions?: readonly DataContradiction[];
}

export function renderPrBody(input: RenderPrBodyInput): string {
  const what = input.isCode ? "Source-code tests" : "E2E tests";
  const shaText = input.sha ? ` for \`${input.sha}\`` : "";
  const blocks: string[] = ["## What this PR adds", `${what} generated/updated by qayaba${shaText}.`];

  const covered = (input.tested ?? []).filter((t) => t.flow || t.objective).slice(0, MAX_ITEMS);
  if (covered.length) {
    blocks.push(`**Covers:**\n${covered.map(renderTestedItem).filter(Boolean).join("\n")}`);
  }

  blocks.push(
    input.isCode
      ? "**Validation:** the repo's own test suite passed (exit code 0) and the change was approved by the independent reviewer."
      : "**Validation:** harness green (typecheck + lint + stable run against the live DEV) and approved by the independent reviewer.",
  );

  const missing = renderMissingCasesSection(input.missingCases);
  if (missing) blocks.push(missing);
  const availability = renderAvailabilitySection(input.routeAvailability);
  if (availability) blocks.push(availability);
  const stubbed = renderStubbedSection(input.stubbedState);
  if (stubbed) blocks.push(stubbed);
  const contradictions = renderDataContradictionsSection(input.dataContradictions, input.stubbedState);
  if (contradictions) blocks.push(contradictions);

  if (input.parentRunId) blocks.push(`> ⛓️ Continuation of ${input.parentRunId}`);

  return blocks.join("\n\n");
}
