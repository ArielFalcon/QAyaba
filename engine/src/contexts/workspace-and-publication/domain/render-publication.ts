/* Renders the GitHub markdown for a run: the Issue body for a failing/invalid/flaky run and the PR body for a green publish. The goal is REVIEWER-FACING DOCUMENTATION — a concise, high-level account of what was tested, what was found, and what to do — NOT a log dump. PURE, no sanitizer dependency: every field here is markdown-composed from caller-supplied, already-untrusted text. The CALLER (publication-port.adapter.ts) sanitizes the WHOLE composed body string returned by renderIssue/renderPrBody before it ever reaches GitHub, and hands the same redactor in as an argument: every field the renderers BOUND is redacted before it is cut (shared-kernel/redact-then-bound.ts), so the cut can never leave the first characters of a secret that the whole-body pass would no longer recognise. The redactor is a parameter, not an import, which keeps this domain file testable and pure (matches this context's OWN write-confinement.service.ts precedent: pure classifiers, effectful wiring lives one layer out). */
import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { outcomeText, type RouteAvailabilityFact } from "@kernel/route-availability.ts";
import { dataContradictionStatement, type DataContradiction, type DefectFact } from "@kernel/data-contradiction.ts";
import { redactThenBound } from "@kernel/redact-then-bound.ts";
import { printedRoute } from "@kernel/printed-route.ts";
import { ambientPinReads, type AmbientDataPin } from "@kernel/page-data-read.ts";

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

/* A field of the body bounded to `max`: redacted first, then cut, with the marker saying how long it was. */
type Bound = (value: string, max: number) => string;
const boundWith = (redact: (text: string) => string): Bound => (value, max) =>
  redactThenBound(value, max, redact, { marker: (original, kept) => ` …(+${original - kept} chars)` });

function oneLineCause(detail: string, bound: Bound): string {
  const lines = detail.split("\n").map((l) => l.trim()).filter(Boolean);
  const pick = lines.find((l) => /error|expect|timeout|fail|assert|not found|exceeded/i.test(l)) ?? lines[0] ?? "";
  return bound(pick, CAP_CAUSE);
}

function renderTestedItem(t: TestedItem, bound: Bound): string {
  const flow = t.flow ? bound(t.flow, CAP_FLOW) : "";
  const obj = t.objective ? bound(t.objective, CAP_OBJECTIVE) : "";
  if (flow && obj) return `- **${flow}** — ${obj}`;
  if (flow) return `- **${flow}**`;
  if (obj) return `- ${obj}`;
  return "";
}

function renderFailedCase(c: QaCase, bound: Bound): string {
  const lines = [`- **${bound(c.name, CAP_NAME)}**${c.detail ? ` — ${oneLineCause(c.detail, bound)}` : ""}`];
  if (c.objective) lines.push(`  - tested: ${bound(c.objective, CAP_OBJECTIVE)}`);
  if (c.reason) lines.push(`  - fix: ${bound(c.reason, CAP_OBJECTIVE)}`);
  return lines.join("\n");
}

function headline(verdict: RunVerdict, failedCount: number, totalCount: number, flakyCount: number, defectCount: number): string {
  const found = failedCount === 0 && defectCount > 0 ? `${defectCount} defect(s) found without a failing check` : undefined;
  switch (verdict) {
    case "fail":
      if (found) return found;
      return totalCount
        ? `${failedCount} of ${totalCount} check(s) failed against the live environment`
        : "the tests failed against the live environment";
    case "invalid":
      return "the generated tests could not be validated (static gate)";
    case "flaky": {
      const unstable = `${flakyCount} test(s) were unstable and were quarantined`;
      return found ? `${found}, and ${unstable}` : unstable;
    }
    default:
      return found ?? "the generated tests need changes before they can land";
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
function renderCausalSection(c: CausalLabelView, bound: Bound): string {
  const lines = ["Change reach", `- Reach: ${REACH_WORDS[c.reach] ?? c.reach}`, `- Basis: ${c.basis}`];
  if (c.via.length) lines.push(`- Via: ${c.via.slice(0, MAX_ITEMS).map((v) => `\`${bound(v, CAP_NAME)}\``).join(", ")}`);
  lines.push(`- Reason: ${bound(c.reason, CAP_CAUSE)}`);
  const shown = c.cases.slice(0, MAX_ITEMS);
  for (const k of shown) lines.push(`  - ${bound(k.name, CAP_NAME)}: ${REACH_WORDS[k.reach] ?? k.reach} (${k.basis})`);
  if (c.cases.length > shown.length) lines.push(`  - …and ${c.cases.length - shown.length} more case(s) omitted`);
  return lines.join("\n");
}

/* Threaded ONLY for the reviewer-unavailable fail-closed exit, never a genuine reviewer rejection (corrections are already that signal) — the caller's own contract. */
function renderReviewerNoteSection(note: string): string {
  return ["Reviewer unavailable", note].join("\n");
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
  /* The fields the consumer's code expects of an answer that the run's captured pages' answers lack, from the response shapes the capture read. */
  dataContradictions?: readonly DataContradiction[];
  /* The defects the run found without a failing test: the contradictions the provider's contract does not declare, on code the change reaches. */
  defects?: readonly DefectFact[];
  /* The passing cases that checked a page only as DEV served it confirmed empty, and the untaken arms on those pages. */
  ambientDataState?: AmbientDataStateView;
}

/* The change-coverage measurement of a run the gate held: the ratio against the threshold, the changed lines no test ran per file and the arms of the changed code no test took. */
export interface CoverageReportView {
  ratio: number | null;
  minRatio?: number;
  uncovered: ReadonlyArray<{ file: string; lines: readonly number[] }>;
  untakenArms: ReadonlyArray<{ file: string; line: number; arm: string }>;
}

const MAX_COVERAGE_FILES = 50;
const MAX_LINES_PER_FILE = 20;

/* The coverage report as a section of its own: why the work was held and where the suite leaves the change unrun. Empty when there is no report. */
function renderCoverageSection(report: CoverageReportView | undefined, bound: Bound): string {
  if (!report) return "";
  const ratio = report.ratio === null ? "not measured" : report.ratio.toFixed(2);
  const against = report.minRatio !== undefined ? ` against the ${report.minRatio} the app enforces` : "";
  const blocks: string[] = [`**Change coverage** — held, not published: the green suite executed ${ratio} of the change's code lines${against}. Nothing was opened in the repository.`];
  const files = report.uncovered.slice(0, MAX_COVERAGE_FILES);
  if (files.length > 0) {
    const line = (f: CoverageReportView["uncovered"][number]): string => `- \`${bound(f.file, CAP_FLOW)}\`: ${f.lines.slice(0, MAX_LINES_PER_FILE).join(", ")}${f.lines.length > MAX_LINES_PER_FILE ? `, …(+${f.lines.length - MAX_LINES_PER_FILE})` : ""}`;
    const cut = report.uncovered.length - files.length;
    blocks.push(`Changed lines no test ran:\n${files.map(line).join("\n")}${cut > 0 ? `\n- …and ${cut} more file(s) omitted` : ""}`);
  }
  const arms = report.untakenArms.slice(0, MAX_ITEMS);
  if (arms.length > 0) {
    const cut = report.untakenArms.length - arms.length;
    blocks.push(`Arms of the changed code no test took:\n${arms.map((a) => `- \`${bound(a.file, CAP_FLOW)}:${a.line}\` — ${bound(a.arm, CAP_NAME)}`).join("\n")}${cut > 0 ? `\n- …and ${cut} more arm(s) omitted` : ""}`);
  }
  return blocks.join("\n\n");
}

/* The reviewer's missing cases as a section of their own; empty when there are none. A record for the reader, never a gate. */
function renderMissingCasesSection(missingCases: readonly string[] | undefined, bound: Bound): string {
  const shown = (missingCases ?? []).filter((text) => text.trim() !== "").slice(0, MAX_ITEMS);
  if (shown.length === 0) return "";
  return `**Cases the change decides that no test runs** (the reviewer's reading of the measured arms; not a gate):\n${shown.map((text) => `- ${bound(text, CAP_OBJECTIVE)}`).join("\n")}`;
}

/* Where each fact's evidence is: the route table entry or guard the change governs it by, or the reach of a possible regression. */
function availabilityEvidence(fact: RouteAvailabilityFact): string {
  const basis = fact.basis;
  if (basis.class === "change-introduced") return basis.via === "route-declaration" ? `its route table entry changed at ${basis.at}` : `a changed symbol reaches its guard ${basis.at}`;
  if (basis.class === "regression-candidate") return basis.reach === "governs" ? "the change governs it and the page logged a runtime error" : "the change reaches the page and it logged a runtime error";
  return basis.class;
}

/* The route availability the reader must see: every unavailability the change introduced (a new contract the tests may assert), and every possible regression. Empty when there is neither. A record for the reader, never a gate. */
function renderAvailabilitySection(facts: readonly RouteAvailabilityFact[] | undefined, bound: Bound): string {
  const line = (fact: RouteAvailabilityFact): string => `- \`${bound(fact.route, CAP_FLOW)}\` ends on ${bound(outcomeText(fact.outcome), CAP_FLOW)}: ${bound(availabilityEvidence(fact), CAP_CAUSE)}`;
  const introduced = (facts ?? []).filter((fact) => fact.basis.class === "change-introduced").slice(0, MAX_ITEMS);
  const regressions = (facts ?? []).filter((fact) => fact.basis.class === "regression-candidate").slice(0, MAX_ITEMS);
  const blocks: string[] = [];
  if (introduced.length > 0) blocks.push(`**Routes this change makes unavailable** (the change governs where they send the browser; check that this is intended):\n${introduced.map(line).join("\n")}`);
  if (regressions.length > 0) blocks.push(`**Possible regressions** (a route the change reaches is sent away after a runtime error; a signal, not a gate):\n${regressions.map(line).join("\n")}`);
  return blocks.join("\n\n");
}

/* The data contradictions of the run's pages: a field the consumer's own code expects of an answer that no response of the operation carries. A possible defect of the app's data (or of the provider's contract), which a test written around it would hide; a record for the reader, never a gate. */
function renderDataContradictionsSection(facts: readonly DataContradiction[] | undefined, bound: Bound): string {
  const shown = (facts ?? []).slice(0, MAX_ITEMS);
  if (shown.length === 0) return "";
  const page = (fact: DataContradiction): string => printedRoute(fact, (part) => `\`${bound(part, CAP_FLOW)}\``);
  const more = (facts ?? []).length - shown.length;
  const omitted = more > 0 ? `\n_…and ${more} more omitted._` : "";
  const lines = shown.map((fact) => `- ${page(fact)}: ${bound(dataContradictionStatement(fact), CAP_CONTRADICTION)}`);
  return `**Possible data contradictions** (a field the consumer's own code expects of an answer, that its declared type holds and its code reads and never writes, is absent from every response the page received; it may be a defect of the app's data or of the provider's contract, not of the tests; a signal, not a gate):\n${lines.join("\n")}${omitted}`;
}

const REACH_BASIS: Record<DefectFact["basis"], string> = { page: "the page", request: "the operation it was read from" };

/* The defects the run found without a failing test: each contradiction the provider's contract does not declare, on code the change reaches, and what places it there. The reason a green suite does not make the run pass. */
function renderDefectsSection(defects: readonly DefectFact[] | undefined, bound: Bound): string {
  const shown = (defects ?? []).slice(0, MAX_ITEMS);
  if (shown.length === 0) return "";
  const more = (defects ?? []).length - shown.length;
  const omitted = more > 0 ? `\n_…and ${more} more omitted._` : "";
  const lines = shown.map(({ fact, basis, via }) => {
    const page = printedRoute(fact, (part) => `\`${bound(part, CAP_FLOW)}\``);
    return `- ${page}: ${bound(dataContradictionStatement(fact), CAP_CONTRADICTION)}\n  - the change reaches ${REACH_BASIS[basis]} via ${via.slice(0, MAX_ITEMS).map((v) => `\`${bound(v, CAP_NAME)}\``).join(", ")}`;
  });
  return `**Defects found without a failing test** (the consumer's code reads a field the provider's contract does not declare, on code the change reaches: the interface is broken whatever data DEV holds, and a test that passes around it proves nothing about it):\n${lines.join("\n")}${omitted}`;
}

/* The passing cases that checked a page only as DEV served it confirmed empty, and the arms of the changed code on those pages that no test took, as the run recorded them. */
export interface AmbientDataStateView {
  pins: readonly AmbientDataPin[];
  arms: ReadonlyArray<{ file: string; line: number; arm: string; pages: readonly string[] }>;
}

/* The pinned cases and the untaken arms on their pages as a section of their own: a pass that cannot tell DEV's lack of data from the change, and the change's code DEV's data never took there. Empty when no case is pinned. A record for the reader, never a gate. */
function renderAmbientDataStateSection(view: AmbientDataStateView | undefined, bound: Bound): string {
  const pins = (view?.pins ?? []).slice(0, MAX_ITEMS);
  if (pins.length === 0) return "";
  const pages = (list: readonly string[]): string => list.map((page) => `\`${bound(page, CAP_FLOW)}\``).join(", ");
  const blocks = [`**Checked only as DEV served it** (these cases ran on the page as it loaded, before any step of their own, either on a page the run read as a confirmed empty state or asserting the result count the run read there: the pass cannot tell DEV's data of the moment from the change; a signal, not a gate):\n${pins.map((pin) => `- \`${bound(pin.file, CAP_FLOW)}\` › ${bound(pin.test, CAP_NAME)} — ${ambientPinReads(pin).map((read) => `\`${bound(read, CAP_FLOW)}\``).join(", ")}`).join("\n")}`];
  const arms = (view?.arms ?? []).slice(0, MAX_ITEMS);
  if (arms.length > 0) blocks.push(`Arms of the changed code on those pages no test took (DEV may lack the data that takes them):\n${arms.map((a) => `- \`${bound(a.file, CAP_FLOW)}:${a.line}\` — ${bound(a.arm, CAP_NAME)} (${pages(a.pages)})`).join("\n")}`);
  return blocks.join("\n\n");
}

export function renderIssue(input: RenderIssueInput, redact: (text: string) => string): string {
  const bound = boundWith(redact);
  const failed = input.cases.filter((c) => c.status === "fail");
  const flaky = input.cases.filter((c) => c.status === "flaky");
  const shownFailed = failed.slice(0, MAX_ITEMS);
  const omittedFailed = failed.length - shownFailed.length;

  const blocks: string[] = [`## QA — ${headline(input.verdict, failed.length, input.cases.length, flaky.length, input.defects?.length ?? 0)}`];

  blocks.push(input.sha ? `**SHA:** \`${input.sha}\` · **Verdict:** ${input.verdict}` : `**Verdict:** ${input.verdict}`);

  const tested = (input.tested ?? []).filter((t) => t.flow || t.objective).slice(0, MAX_ITEMS);
  if (tested.length) {
    blocks.push(`### What was tested\n${tested.map((t) => renderTestedItem(t, bound)).filter(Boolean).join("\n")}`);
  }

  if (shownFailed.length) {
    const omitted = omittedFailed > 0 ? `\n\n_…and ${omittedFailed} more failed case(s) omitted._` : "";
    blocks.push(`### Failing cases\n${shownFailed.map((c) => renderFailedCase(c, bound)).join("\n")}${omitted}`);
  }

  if (flaky.length) {
    blocks.push(`### Flaky (quarantined)\n${flaky.slice(0, MAX_ITEMS).map((c) => `- ⚠️ ${bound(c.name, CAP_NAME)}`).join("\n")}`);
  }

  if (input.adjudication) {
    blocks.push(renderAdjudicationSection(input.adjudication));
  }
  if (input.causal) {
    blocks.push(renderCausalSection(input.causal, bound));
  }
  if (input.reviewerNote && input.reviewerNote.trim()) {
    blocks.push(renderReviewerNoteSection(input.reviewerNote));
  }
  const missing = renderMissingCasesSection(input.missingCases, bound);
  if (missing) blocks.push(missing);
  const availability = renderAvailabilitySection(input.routeAvailability, bound);
  if (availability) blocks.push(availability);
  const defects = renderDefectsSection(input.defects, bound);
  if (defects) blocks.push(defects);
  const contradictions = renderDataContradictionsSection(input.dataContradictions, bound);
  if (contradictions) blocks.push(contradictions);
  const ambient = renderAmbientDataStateSection(input.ambientDataState, bound);
  if (ambient) blocks.push(ambient);

  const head = blocks.join("\n\n");
  const footer = "\n\n_Full trace + logs in the run artifacts (trace on-first-retry)._";
  return `${head}${footer}`;
}

export interface RenderPrBodyInput {
  sha?: string;
  tested?: TestedItem[];
  parentRunId?: string;
  /* The change-coverage report of a run the gate held, shown first among the signals. Absent: no section. */
  coverage?: CoverageReportView;
  /* The reviewer's missing cases: behaviours the change decides that no test runs. */
  missingCases?: readonly string[];
  /* The routes the change made unavailable and the possible regressions, from the run's availability classification. */
  routeAvailability?: readonly RouteAvailabilityFact[];
  /* The fields the consumer's code expects of an answer that the run's captured pages' answers lack, from the response shapes the capture read. */
  dataContradictions?: readonly DataContradiction[];
  /* The passing cases that checked a page only as DEV served it confirmed empty, and the untaken arms on those pages. */
  ambientDataState?: AmbientDataStateView;
}

export function renderPrBody(input: RenderPrBodyInput, redact: (text: string) => string): string {
  const bound = boundWith(redact);
  const shaText = input.sha ? ` for \`${input.sha}\`` : "";
  const blocks: string[] = ["## What this PR adds", `E2E tests generated/updated by qayaba${shaText}.`];

  const covered = (input.tested ?? []).filter((t) => t.flow || t.objective).slice(0, MAX_ITEMS);
  if (covered.length) {
    blocks.push(`**Covers:**\n${covered.map((t) => renderTestedItem(t, bound)).filter(Boolean).join("\n")}`);
  }

  blocks.push("**Validation:** harness green (typecheck + lint + stable run against the live DEV) and approved by the independent reviewer.");

  const coverage = renderCoverageSection(input.coverage, bound);
  if (coverage) blocks.push(coverage);
  const missing = renderMissingCasesSection(input.missingCases, bound);
  if (missing) blocks.push(missing);
  const availability = renderAvailabilitySection(input.routeAvailability, bound);
  if (availability) blocks.push(availability);
  const contradictions = renderDataContradictionsSection(input.dataContradictions, bound);
  if (contradictions) blocks.push(contradictions);
  const ambient = renderAmbientDataStateSection(input.ambientDataState, bound);
  if (ambient) blocks.push(ambient);

  if (input.parentRunId) blocks.push(`> ⛓️ Continuation of ${input.parentRunId}`);

  return blocks.join("\n\n");
}
