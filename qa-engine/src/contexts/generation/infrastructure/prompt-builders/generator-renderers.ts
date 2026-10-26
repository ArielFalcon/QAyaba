/* Renderers of the facts and evidence sections of a generator prompt. Each returns the section text; the registry in generator-sections.ts decides when one applies. Never import src/. */

import { sanitizeText } from "../../../../shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { capText } from "../prompt-cap.ts";
import { failureUnsettled, type FailureSettle, type QaCase } from "@kernel/qa-case.ts";
import { stripAnsi } from "@kernel/ansi.ts";
import type { ClosedLoopLimits } from "@kernel/closed-loop.ts";
import type { AgentBrowserLimits } from "@kernel/agent-browser.ts";
import type { GeolocationFacts } from "@kernel/geolocation.ts";
import type { PlanningLimits } from "@kernel/coordination.ts";
import { candidateLine } from "@kernel/use-case-candidate.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import { isReGenTurn } from "@contexts/generation/domain/regen-turn.ts";
import { diffWithoutTestFiles } from "@kernel/diff-parser/diff-without-test-files.ts";
import type { MilestoneOutcome, StepMilestone } from "@contexts/generation/domain/step-limit.ts";
import type { HarnessFacts } from "@contexts/generation/domain/harness-facts.ts";
import type { OpencodeRunInput } from "../../domain/opencode-run-input.ts";
import { COMMIT_DIFF_HEADING, cappedDiffText, redactForModel } from "./prompt-text.ts";

/* Facts only: what the harness is configured with and what its shared fixtures export. Every value is sanitized; nothing here directs the agent. Absent facts render no section. */
export function renderHarnessFacts(facts: HarnessFacts, e2eRelDir: string): string {
  const s = (x: string): string => sanitizeText(x).text;
  const lines: string[] = [];
  if (facts.testIdAttribute) lines.push(`testIdAttribute: ${s(facts.testIdAttribute)}`);
  if (facts.fixtures?.exports.length) {
    lines.push(`fixtures: ${s(`${e2eRelDir}/${facts.fixtures.file}`)} exports ${facts.fixtures.exports.map(s).join(", ")}`);
  }
  return lines.length > 0 ? [`## ${PROMPT_HEADINGS.harnessFacts}`, ...lines, ``].join("\n") : "";
}

/* The authenticated browser a run granted the authoring agents, as facts: how many calls and how long each may take, and what its answers report. Numbers and a description only; how to use the tools is the role prompt's. */
export function renderAgentBrowser(limits: AgentBrowserLimits): string {
  const seconds = Math.round(limits.perCallMs / 1000);
  return [
    `## ${PROMPT_HEADINGS.agentBrowser}`,
    `authbrowser_navigate, authbrowser_snapshot, authbrowser_click and authbrowser_type: at most ${limits.maxCalls} calls this run, ${seconds} seconds each. They read DEV as the test account; a request that writes to DEV, a route this app closes and an address outside its origins are blocked and listed in the answer.`,
    ``,
  ].join("\n");
}

/* The run_spec tool a run granted the generator, as facts: how many calls, how long each may run, how many requests that write to DEV the executed specs may send in all. Numbers only; how to use the tool is the role prompt's. */
export function renderClosedLoop(limits: ClosedLoopLimits): string {
  const seconds = Math.round(limits.perCallMs / 1000);
  return [`## ${PROMPT_HEADINGS.closedLoop}`, `run_spec: at most ${limits.maxCalls} calls this run, ${seconds} seconds each, ${limits.maxDevWrites} requests that write to DEV (POST, PUT, PATCH, DELETE) in all.`, ``].join("\n");
}

/* The limits a lead's plan is held to on a coordinated run's planning turn, as facts. The shapes a plan may take are the role prompt's; the orchestrator decides what each flow may write, how long it takes and what it may run, so the plan carries none of that. */
export function renderLeadPlan(limits: PlanningLimits): string {
  return [
    `## ${PROMPT_HEADINGS.leadPlan}`,
    `This turn asks for a plan, not for specs: write no file. A plan names at most ${limits.maxFlows} flows, and ${limits.maxParallel} are written at once.`,
    `The orchestrator ends this turn after ${Math.round(limits.budgetMs / 1000)} seconds; a turn ended before its plan JSON delivers no plan, and the run ends with nothing authored.`,
    ...(limits.locations?.length ? [`The app's locations a flow may name: ${limits.locations.join(", ")}.`] : []),
    ...(limits.candidates?.length
      ? [
          `The change makes these use cases testable (id | entry | reach | evidence | specs the suite holds):`,
          ...limits.candidates.map((candidate) => `- ${sanitizeText(candidateLine(candidate)).text}`),
          ...(limits.otherCandidates ? [`${limits.otherCandidates} less direct use case(s) are not listed and need no flow.`] : []),
          `Give a flow to each one whose behaviour the change alters and cite its id in the flow's "candidates", or list it in "dropped" with the reason it needs no test; one the plan neither covers nor drops is asked of you once more.`,
        ]
      : []),
    ``,
  ].join("\n");
}

/* The app's declared location and the location this authoring scope works at, as facts, with the one rule a delivered spec follows. Present only when the app declares geolocation. */
export function renderGeolocation(facts: GeolocationFacts): string {
  const places = Object.entries(facts.places).map(([name, location]) => `${name} (${location.latitude}, ${location.longitude})`);
  return [
    `## ${PROMPT_HEADINGS.geolocation}`,
    `The app's default location: ${facts.default.latitude}, ${facts.default.longitude}. The suite runs at this location unless a spec sets another.`,
    ...(places.length > 0 ? [`Places the app declares: ${places.join("; ")}.`] : []),
    `This authoring scope is at: ${facts.current.latitude}, ${facts.current.longitude} (${facts.scope === "run" ? "the run" : "this flow"}). The authenticated browser, when this run grants it, opens pages at it; the plain Playwright MCP is a separate browser and does not take this value. run_spec and the suite run at the app's default, not at the authoring location: a spec whose expected result depends on a location pins it with setLocation(context, latitude, longitude) from the suite's fixtures.`,    ``,
  ].join("\n");
}

/* What each outcome of a milestone asks of the agent, in the words the milestone joins. The verdict's own reason field is the static contract's to name: a regeneration that finds no correction to make says so in the verdict. */
export const MILESTONE_OUTCOME_PHRASES: Readonly<Record<MilestoneOutcome, string>> = {
  "first-spec": "write the first test file",
  "no-op": "decide the no-op and state why",
  "first-correction": "write the first correction",
  "reason-none-applies": "state in the verdict why none applies",
};

/* The milestone of a turn that writes tests: the step by which something should be written, and what meets it. It renders the data of `stepMilestone` and adds none of its own. */
export function renderStepMilestone({ midpoint, outcomes }: StepMilestone): string {
  return `By step ${midpoint}: ${outcomes.map((outcome) => MILESTONE_OUTCOME_PHRASES[outcome]).join(", or ")}.`;
}

/* The steps of a fix the builder words itself. The step that reads the test file is there only where the listing does not tell the agent to read the specs it changes. */
export const FIX_STEPS = {
  readTestFile: `Read the test file to understand what it asserts`,
  readCodeUnderTest: `Read the code under test that the failure points at`,
  changeOnlyWhatIsBroken: `Change only what is broken.`,
} as const;

/* The steps of a fix, numbered from one; a step may carry the lines under it. */
export const numbered = (steps: readonly string[]): string[] => steps.map((step, index) => `${index + 1}. ${step}`);

/* The pieces of a cross-service link's line that a reader tells apart: the label of a hop between two backends, the marker a link the change reaches carries, and the heading of the drift warnings. */
export const BACKEND_TO_BACKEND_LABEL = "BE→BE HTTP";
export const CONTRACT_DRIFT_HEADING = "Contract drift";
export const IMPACTED_MARKER_PREFIX = "[IMPACTED:";
export const impactedMarker = (tier: string): string => `${IMPACTED_MARKER_PREFIX}${tier}]`;

function linkKindLabel(l: { transport: string; source: string }): string {
  if (l.source === "http-backend-resolver") return BACKEND_TO_BACKEND_LABEL;
  if (l.transport === "event") return "event";
  if (l.transport === "rpc") return "RPC";
  return "FE→BE HTTP";
}

export function renderServiceLinkLine(
  l: {
    from: { repo: string; file: string; symbol: string };
    to: { repo: string; symbol: string };
    transport: string;
    source: string;
    contractRef?: string;
    confidence: number;
  },
  s: (x: unknown) => string,
  tier?: string,
): string {
  return `- ${tier ? `${impactedMarker(s(tier))} ` : ""}\`${s(l.from.repo)}/${s(l.from.file)}#${s(l.from.symbol)}\` -> ` +
    `${s(l.to.repo)} ${s(l.contractRef ?? l.to.symbol)} (${linkKindLabel(l)}, source ${s(l.source)}, confidence ${l.confidence.toFixed(2)})`;
}

/* The labels of the evidence lines a failing case carries that a reader tells apart: the HTTP line of a case that reached a page without a status, and how the capture at the failure point says it settled. */
export const HTTP_UNKNOWN_LABEL = "HTTP (unknown)";
export const SETTLE_LABELS = { unsettled: "NOT SETTLED", settled: "settled" } as const;

function renderFixCaseEvidenceLines(c: QaCase): string[] {
  const lines: string[] = [];
  const hasNetworkErrors = c.networkErrors !== undefined && c.networkErrors.length > 0;
  if (c.httpStatus !== undefined) {
    const urlPart = c.finalUrl !== undefined ? ` at ${redactForModel(c.finalUrl)}` : "";
    lines.push(`  HTTP ${c.httpStatus}${urlPart}`);
  } else if (!hasNetworkErrors && c.finalUrl !== undefined) {
    /* The unknown HTTP line was misleading next to real network evidence, so it is only printed when there is none. */
    lines.push(`  ${HTTP_UNKNOWN_LABEL} at ${redactForModel(c.finalUrl)}`);
  }
  if (c.networkErrors?.length) {
    for (const e of c.networkErrors.slice(0, 3)) {
      const label = e.status !== undefined ? String(e.status) : e.errorText ?? "failed";
      lines.push(stripAnsi(`  NET ${label} ${redactForModel(e.url)}`).slice(0, 400));
    }
  }
  if (c.runtimeErrors?.length) {
    for (const e of c.runtimeErrors.slice(0, 3)) {
      lines.push(`  [${e.type}] ${stripAnsi(redactForModel(e.text)).slice(0, 200)}`);
    }
  }
  if (c.failureSettle) lines.push(`  PAGE ${describeSettle(c.failureSettle)}`);
  if (c.failureResultCount !== undefined) lines.push(`  DATA STATE ${describeResultCount(c.failureResultCount)}`);
  return lines;
}

/* The declared data state's count at the failure point. */
export const describeResultCount = (count: number): string => `result count at the failure point: ${count}`;

/* The settle facts of a failure-point capture, as facts: a page still changing is a moment of a render, not DEV's data state. */
export function describeSettle(settle: FailureSettle): string {
  const quiet = settle.quietMs !== undefined ? `, last data response ${settle.quietMs} ms before` : "";
  const tree = settle.treeStable ? "the tree was the same 1 s later" : "the tree changed within 1 s";
  return failureUnsettled(settle)
    ? `${SETTLE_LABELS.unsettled} at the failure point (${settle.inFlight} data request(s) in flight${quiet}; ${tree}): this tree is a moment of a render, not DEV's data state`
    : `${SETTLE_LABELS.settled} at the failure point (no data request in flight${quiet}; ${tree})`;
}

/* A failing case as a prompt lists it: its name, the start of its error and what the run saw of the page. The case comes out of the test run, so each text is redacted before it is cut, and no secret is left in part by the cut. */
export function renderFixCase(c: QaCase): string[] {
  const error = c.detail === undefined ? "(no detail)" : stripAnsi(redactForModel(c.detail)).slice(0, 500);
  return [`- ${redactForModel(c.name)}\n  Error: ${error}`, ...renderFixCaseEvidenceLines(c)];
}

/* Read only where the agent has no DOM tree and explores the live page itself: with a tree in the prompt it transcribes and does not navigate, so there is nothing to observe. */
export const RUNTIME_SIGNALS_LINES: readonly string[] = [
  `- Also inspect runtime signals with the Playwright MCP: browser_console_messages (catch JS errors`,
  `  and warnings — a console error on the changed flow is a real bug signal) and browser_network_requests`,
  `  (read the actual API calls/responses the flow makes, and assert against their real shape — status,`,
  `  required fields, error responses — not invented contracts).`,
];

/* Returns empty string for all non-diff modes, code mode, and re-generation passes (where the diff is already distilled in the grounding above and repeating it burns tokens). */
export function buildDiffSection(input: OpencodeRunInput): string {
  if (input.target === "code") return "";
  if (input.mode !== "diff") return "";
  if (isReGenTurn(input)) return "";
  /* A lead's planning turn sees the change without the app's own test files, named instead (the flows it plans are end-to-end). */
  const { diff, testFiles } = input.planning ? diffWithoutTestFiles(input.diff) : { diff: input.diff, testFiles: [] };
  /* Cap BEFORE sanitizing: capDiff splits on diff file-header boundaries and must see the raw structure; sanitizeText only redacts secret-shaped substrings. */
  return [
    COMMIT_DIFF_HEADING,
    "```diff",
    cappedDiffText(diff),
    "```",
    ...(testFiles.length > 0 ? [`Test files the change also touches (not shown): ${sanitizeText(testFiles.join(", "), "issue").text}`] : []),
  ].join("\n");
}

/* At most this many violations reach one prompt; the rest are counted so the agent knows the list is abridged. */
export const CONTRACT_FEEDBACK_MAX = 6;

export const CONTRACT_FEEDBACK_SECTION_ID = "contract-feedback";

/**
 * The intent lock's violations as a facts section: each line names the rule, the clause and what the
 * contract held before and after. Every text is redacted and cut, so a literal that carries a secret
 * never reaches the model, and the section states counts rather than demanding anything.
 */
export function renderContractViolations(
  violations: readonly { rule: string; file: string; clauseId: string; before: string; after: string }[],
): string {
  const shown = violations.slice(0, CONTRACT_FEEDBACK_MAX);
  const lines = [
    `## Contract violations (the intent contract this run fixed on these specs)`,
    ``,
    `The intent contract was derived from the primary pass's own bytes. Each line is a delta the orchestrator found between that contract and the bytes of the last turn:`,
    ``,
    ...shown.map(
      (violation) =>
        `- ${sanitizeText(violation.rule).text} ${sanitizeText(violation.file).text}#${sanitizeText(violation.clauseId).text}: ${capText(sanitizeText(violation.before).text, 200)} → ${capText(sanitizeText(violation.after).text, 200)}`,
    ),
    ...(violations.length > shown.length ? [``, `(${violations.length - shown.length} more not shown.)`] : []),
    ``,
  ];
  return lines.join("\n");
}
