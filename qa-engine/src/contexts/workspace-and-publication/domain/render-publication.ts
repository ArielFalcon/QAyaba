/* Renders the GitHub markdown for a run: the Issue body for a failing/invalid/flaky run and the PR body for a green publish. The goal is REVIEWER-FACING DOCUMENTATION — a concise, high-level account of what was tested, what was found, and what to do — NOT a log dump. PURE, no sanitizer dependency: every field here is markdown-composed from caller-supplied, already-untrusted text. The CALLER (publication-port.adapter.ts) sanitizes the WHOLE composed body string returned by renderIssue/renderPrBody before it ever reaches GitHub — a single whole-body sanitize pass satisfies "every rendered field passes the injected sanitizer" (the spec's own MUST) without threading a sanitize callback through every render helper in this file, and keeps this domain file testable with zero collaborators (matches this context's OWN write-confinement.service.ts precedent: pure classifiers, effectful wiring lives one layer out). */
import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";

export interface TestedItem {
  flow?: string;
  objective?: string;
}


export interface AdjudicationLabel {
  class: string;
  confidence: string;
  reason: string;
}

const MAX_ITEMS = 50;
const CAP_NAME = 200;
const CAP_CAUSE = 200;
const CAP_FLOW = 120;
const CAP_OBJECTIVE = 300;

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
  reviewerNote?: string;
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
  if (input.reviewerNote && input.reviewerNote.trim()) {
    blocks.push(renderReviewerNoteSection(input.reviewerNote));
  }

  const head = blocks.join("\n\n");
  const footer = "\n\n_Full trace + logs in the run artifacts (trace on-first-retry)._";
  return `${head}${footer}`;
}

export interface RenderPrBodyInput {
  sha?: string;
  isCode: boolean;
  tested?: TestedItem[];
  parentRunId?: string;
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

  if (input.parentRunId) blocks.push(`> ⛓️ Continuation of ${input.parentRunId}`);

  return blocks.join("\n\n");
}
