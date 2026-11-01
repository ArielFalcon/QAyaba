/* Renderers of the facts and evidence sections of a generator prompt. Each returns the section text; the registry in generator-sections.ts decides when one applies. Never import platform/. */

import { sanitizeText } from "../../../../shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { boundedEvidenceText, EVIDENCE_ITEMS_SAFETY_BOUND, evidenceItemsCutLine } from "../prompt-cap.ts";
import { NOT_SHOWN } from "../../domain/window-fit-references.ts";
import { failureUnsettled, type FailureSettle, type QaCase } from "@kernel/qa-case.ts";
import { stripAnsi } from "@kernel/ansi.ts";
import type { ClosedLoopLimits } from "@kernel/closed-loop.ts";
import type { AgentBrowserLimits } from "@kernel/agent-browser.ts";
import type { GeolocationFacts } from "@kernel/geolocation.ts";
import type { PlanningLimits } from "@kernel/coordination.ts";
import type { ImpactReach } from "@kernel/service-links.ts";
import { candidateLine, type OwnedSliceSize, type UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import { DROP_BASIS_RULES, GOVERNED_ROUTE_RULE, refusedDropBasesOf, type DropBasis } from "@kernel/drop-basis.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import { isReGenTurn } from "@contexts/generation/domain/regen-turn.ts";
import type { MilestoneOutcome, StepMilestone } from "@contexts/generation/domain/step-limit.ts";
import { harnessFactLines, type HarnessFacts } from "@contexts/generation/domain/harness-facts.ts";
import type { OpencodeRunInput } from "../../domain/opencode-run-input.ts";
import { commitDiffBlock, redactForModel } from "./prompt-text.ts";

/* Facts only: what the harness is configured with, what the suite's shared fixtures export and declare, and what its Playwright config declares. Every value is sanitized; nothing here directs the agent. Absent facts render no section. */
export function renderHarnessFacts(facts: HarnessFacts, e2eRelDir: string): string {
  const lines = harnessFactLines(facts, e2eRelDir, (x) => sanitizeText(x).text);
  return lines.length > 0 ? [`## ${PROMPT_HEADINGS.harnessFacts}`, ...lines, ``].join("\n") : "";
}

/* The authenticated browser a run granted the authoring agents, as facts: how many calls and how long each may take, and what its answers report. Numbers and a description only; how to use the tools is the role prompt's. */
export function renderAgentBrowser(limits: AgentBrowserLimits): string {
  const seconds = Math.round(limits.perCallMs / 1000);
  return [
    `## ${PROMPT_HEADINGS.agentBrowser}`,
    `authbrowser_navigate, authbrowser_snapshot, authbrowser_click and authbrowser_type: at most ${limits.maxCalls} calls this run, ${seconds} seconds each. They read DEV as the test account; a request that writes to DEV, a route this app closes and an address outside its origins are blocked and listed in the answer. Each answer also lists the requests the page made since your session's previous browser call, as method, origin and path with a count (no query or body); requests to a host outside the run's origins are only counted per host.`,
    ``,
  ].join("\n");
}

/* The run_spec tool a run granted the generator, as facts: how many calls, how long each may run, how many requests that write to DEV the executed specs may send in all. Numbers only; how to use the tool is the role prompt's. */
export function renderClosedLoop(limits: ClosedLoopLimits): string {
  const seconds = Math.round(limits.perCallMs / 1000);
  return [`## ${PROMPT_HEADINGS.closedLoop}`, `run_spec: at most ${limits.maxCalls} calls this run, ${seconds} seconds each, ${limits.maxDevWrites} requests that write to DEV (POST, PUT, PATCH, DELETE) in all.`, ``].join("\n");
}

/* What each drop basis asserts and the fact the orchestrator refuses it for, from the kernel's table. */
function dropBasisRuleLines(): string[] {
  const bases = Object.keys(DROP_BASIS_RULES) as DropBasis[];
  return [
    ...bases.map((basis) => {
      const { meaning, refusedWhen } = DROP_BASIS_RULES[basis];
      return `- ${basis}: ${meaning}.${refusedWhen !== undefined ? ` Refused when ${refusedWhen}.` : ""}`;
    }),
    `- ${GOVERNED_ROUTE_RULE.bases.join(" and ")} are also refused when ${GOVERNED_ROUTE_RULE.refusedWhen}.`,
  ];
}

/* The use case's line, with the bases a drop of it is refused as, computed by the function that refuses the drop. */
function candidateWithRefusals(candidate: UseCaseCandidate, slice: OwnedSliceSize | undefined): string {
  const refused = refusedDropBasesOf(candidate);
  return `${candidateLine(candidate, slice)}${refused.length > 0 ? ` | drop refused as: ${refused.join(", ")}` : ""}`;
}

/* The limits a lead's plan is held to on a coordinated run's planning turn, as facts. The shapes a plan may take are the role prompt's; the orchestrator decides what each flow may write, how long it takes and what it may run, so the plan carries none of that. */
export function renderLeadPlan(limits: PlanningLimits): string {
  return [
    `## ${PROMPT_HEADINGS.leadPlan}`,
    `This turn asks for a plan, not for specs: write no file. ${limits.maxParallel} flows are written at once${limits.flowBudgetMs !== undefined ? `, each in at most ${Math.round(limits.flowBudgetMs / 60_000)} minutes` : ""}.`,
    limits.capacity !== undefined
      ? `The run has time for ${limits.capacity} flows this pass: flows past that many in your plan are not authored and are asked of you once more.`
      : `No limit of the run bounds the number of flows: name the flows the change needs.`,
    `The orchestrator ends this turn after ${Math.round(limits.budgetMs / 1000)} seconds; a turn ended before its plan JSON delivers no plan, and the run ends with nothing authored.`,
    ...(limits.locations?.length ? [`The app's locations a flow may name: ${limits.locations.join(", ")}.`] : []),
    ...(limits.candidates?.length
      ? [
          `The change makes these use cases testable (id | entry | reach | changed code | the part of the diff its flow would own | evidence | specs the suite holds | the bases a drop of it is refused as, when there are any); a flow owns the parts of the use cases it covers, so group them into flows of a size one author can work through:`,
          ...limits.candidates.map((candidate) => `- ${sanitizeText(candidateWithRefusals(candidate, limits.candidateSlices?.[candidate.id])).text}`),
          ...(limits.otherCandidates ? [`${limits.otherCandidates} less direct use case(s) are not listed and need no flow.`] : []),
          `Give a flow to each one whose behaviour the change alters and cite its id in the flow's "candidates", or list it in "dropped" with a "basis" and the reason it needs no test; one the plan neither covers nor drops is asked of you once more. The bases, and what the orchestrator refuses each one for:`,
          ...dropBasisRuleLines(),
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
  reach?: ImpactReach,
): string {
  return `- ${tier ? `${impactedMarker(s(tier))} ` : ""}\`${s(l.from.repo)}/${s(l.from.file)}#${s(l.from.symbol)}\` -> ` +
    `${s(l.to.repo)} ${s(l.contractRef ?? l.to.symbol)} (${linkKindLabel(l)}, source ${s(l.source)}, confidence ${l.confidence.toFixed(2)})` +
    (tier && reach ? ` (${reachedClause(reach, s)})` : "");
}

/* How a link was reached beyond the first hop upstream: its direction, and the links crossed to it from the change, nearest the change first. */
function reachedClause(reach: ImpactReach, s: (x: unknown) => string): string {
  const through = reach.via.map((v) => `${s(v.to.repo)}: ${s(v.operation ? `${v.operation.verb} ${v.operation.path}` : (v.contractRef ?? v.to.symbol))}`);
  return `reached ${reach.direction}${through.length > 0 ? ` through ${through.join(", then ")}` : ""}`;
}

/* A hop of the cross-repo walk that could not be finished: one line, framed as unverified because what lies beyond it was neither found nor ruled out. A hop walked and left partial says so: the links it reached are listed. */
export function renderImpactStopLine(stop: { repo: string; direction: string; reason: string; partial?: true }, s: (x: unknown) => string): string {
  return `- ${s(stop.direction)} hop through ${s(stop.repo)} was ${stop.partial ? "walked partially" : "not walked"}: ${s(stop.reason)} (links beyond it are unverified, not absent)`;
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
  const network = c.networkErrors ?? [];
  for (const e of network.slice(0, EVIDENCE_ITEMS_SAFETY_BOUND)) {
    const label = e.status !== undefined ? String(e.status) : e.errorText ?? "failed";
    lines.push(`  NET ${label} ${boundedEvidenceText(stripAnsi(e.url))}`);
  }
  if (network.length > EVIDENCE_ITEMS_SAFETY_BOUND) lines.push(evidenceItemsCutLine(network.length - EVIDENCE_ITEMS_SAFETY_BOUND));
  const runtime = c.runtimeErrors ?? [];
  for (const e of runtime.slice(0, EVIDENCE_ITEMS_SAFETY_BOUND)) {
    lines.push(`  [${e.type}] ${boundedEvidenceText(stripAnsi(e.text))}`);
  }
  if (runtime.length > EVIDENCE_ITEMS_SAFETY_BOUND) lines.push(evidenceItemsCutLine(runtime.length - EVIDENCE_ITEMS_SAFETY_BOUND));
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

/*
 * A failing case as a prompt lists it: its name, its error and what the run saw of the page, each whole while the window holds them.
 * The case comes out of the test run, so each text is redacted before the safety bound cuts it, and no secret is left in part by the cut.
 * `shape` is what the window fit rule asks for when the prompt is over its window: without the evidence lines, with only the first line of
 * the error, or the name alone.
 */
export type FixCaseShape = "whole" | "no-evidence" | "first-line" | "named";
export function renderFixCase(c: QaCase, shape: FixCaseShape = "whole"): string[] {
  const name = `- ${redactForModel(c.name)}`;
  if (shape === "named") return [`${name}\n  Error: ${NOT_SHOWN}`];
  const full = c.detail === undefined ? "(no detail)" : boundedEvidenceText(stripAnsi(c.detail));
  const error = shape === "first-line" ? (full.split("\n")[0] ?? "") : full;
  return [`${name}\n  Error: ${error}`, ...(shape === "whole" ? renderFixCaseEvidenceLines(c) : [])];
}

/* Read only where the agent has no DOM tree and explores the live page itself: with a tree in the prompt it transcribes and does not navigate, so there is nothing to observe. */
export const RUNTIME_SIGNALS_LINES: readonly string[] = [
  `- Also inspect runtime signals with the Playwright MCP: browser_console_messages (catch JS errors`,
  `  and warnings — a console error on the changed flow is a real bug signal) and browser_network_requests`,
  `  (read the actual API calls/responses the flow makes, and assert against their real shape — status,`,
  `  required fields, error responses — not invented contracts).`,
];

/* The diff of an authoring turn. Returns empty string for all non-diff modes and re-generation passes (where the diff is already distilled in the grounding above and repeating it burns tokens). A lead's planning turn renders its own section from the change map (plan-diff-section.ts). */
export function buildDiffSection(input: OpencodeRunInput): string {
  if (input.mode !== "diff") return "";
  if (isReGenTurn(input)) return "";
  return commitDiffBlock(input.diff);
}
