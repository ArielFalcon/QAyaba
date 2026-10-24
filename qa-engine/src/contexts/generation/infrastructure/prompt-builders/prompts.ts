/* Assembles the per-run TASK + CONTEXT the agent receives. The "how" lives in agents/agent/*.md. Diffs are capped then secret-scrubbed; never import src/. */

import { join } from "node:path";
import { readConfinedSpecFile, type SpecRoot } from "../../../../shared-infrastructure/spec-path-confinement.ts";
import { sanitizeText, assertNoSecretLeak, type SanitizeMode } from "../sanitize-text.ts";
import { capText, capDiff, extractDiffFilePath } from "../prompt-cap.ts";
import { failureUnsettled, type FailureSettle, type QaCase } from "@kernel/qa-case.ts";
import { stripAnsi } from "@kernel/ansi.ts";
import type {
  ArchitectureContext,
  CommitIntent,
  OpencodeRunInput,
  ReviewInput,
  ExplorationBrief,
} from "@contexts/generation/application/ports/generation-ports.ts";
import { ExplorationBriefAdapter, type BriefFns } from "../exploration-brief.adapter.ts";
import { deriveClaimsFromPackText, withoutPackSection } from "../context-pack.ts";
import { diffStat, diffTier, type DiffStat, type DiffTier } from "@contexts/generation/domain/diff-stat.ts";
import { PACK_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import { PROMPT_HEADINGS, ASSEMBLED_ARTIFACT_NAMES } from "@contexts/generation/domain/prompt-headings.ts";
import { isReGenTurn } from "@contexts/generation/domain/regen-turn.ts";
import { diffWithoutTestFiles } from "@contexts/generation/domain/diff-without-test-files.ts";
import type { ClosedLoopLimits } from "@kernel/closed-loop.ts";
import type { AgentBrowserLimits } from "@kernel/agent-browser.ts";
import type { GeolocationFacts } from "@kernel/geolocation.ts";
import { LEAD_PLAN_KIND, type PlanningLimits } from "@kernel/coordination.ts";
import { claim, AGENT_BROWSER_SECTION_ID, APP_LOGIN_SECTION_ID, CLOSED_LOOP_SECTION_ID, GEOLOCATION_SECTION_ID, HARNESS_FACTS_SECTION_ID, LEAD_PLAN_SECTION_ID, STEP_LIMIT_SECTION_ID, type FactId, type PromptClaim } from "@contexts/generation/domain/prompt-contract-lint.ts";
import { STEP_MILESTONE_SECTION_ID, isTestWritingTurn, stepMilestone, type MilestoneOutcome, type StepMilestone } from "@contexts/generation/domain/step-limit.ts";
import { buildSuiteListing } from "@contexts/generation/domain/suite-listing.ts";
import { renderSuiteListing, suiteListingHead } from "@contexts/generation/domain/suite-listing-render.ts";
import type { HarnessFacts } from "@contexts/generation/domain/harness-facts.ts";
import { renderExemplarsForPrompt } from "@kernel/scenario-catalog.ts";
import { advisoryLineIds, briefItemIds, itemId } from "@contexts/generation/domain/context-item-ids.ts";
import type { Omission } from "@kernel/telemetry/section-meta.ts";
import { assemble, section, type AssembledPrompt } from "./context-assembler.ts";
import { roleWindowBytes } from "./model-window-catalog.ts";
import {
  REVIEWER_PROMPT_VERSION,
  REVIEW_CORRECTIONS_MAX,
  REVIEW_CORRECTION_MAX_CHARS,
  REVIEW_RATIONALE_MAX_CHARS,
} from "@contexts/generation/domain/review-output.ts";

export type { AssembledPrompt };
export { PROMPT_HEADINGS, ASSEMBLED_ARTIFACT_NAMES };

/* Throws loudly if a brief render is attempted before wiring — never a silent no-op (CLAUDE.md's "surface integration errors loudly" invariant) — but every real production path wires this before any run starts, and every test either wires it locally or never exercises `w.brief`/ `input.contextBrief` (renderBrief is only called when a brief is actually present). */
let explorationBriefAdapter: ExplorationBriefAdapter | undefined;

export function setExplorationBriefCollaborators(fns: BriefFns): void {
  explorationBriefAdapter = new ExplorationBriefAdapter(fns);
}

function renderBrief(brief: ExplorationBrief, opts?: { omitLandmarks?: boolean }): string {
  if (!explorationBriefAdapter) {
    throw new Error(
      "prompts: renderExplorationBrief collaborator not wired — call setExplorationBriefCollaborators() at composition time (see rewritten-engine-factory.ts)",
    );
  }
  return explorationBriefAdapter.render(brief, opts);
}

/* Facts only: what the harness is configured with and what its shared fixtures export. Every value is sanitized; nothing here directs the agent. Absent facts render no section. */
function renderHarnessFacts(facts: HarnessFacts, e2eRelDir: string): string {
  const s = (x: string): string => sanitizeText(x).text;
  const lines: string[] = [];
  if (facts.testIdAttribute) lines.push(`testIdAttribute: ${s(facts.testIdAttribute)}`);
  if (facts.fixtures?.exports.length) {
    lines.push(`fixtures: ${s(`${e2eRelDir}/${facts.fixtures.file}`)} exports ${facts.fixtures.exports.map(s).join(", ")}`);
  }
  return lines.length > 0 ? [`## ${PROMPT_HEADINGS.harnessFacts}`, ...lines, ``].join("\n") : "";
}

export { AGENT_BROWSER_SECTION_ID, CLOSED_LOOP_SECTION_ID, GEOLOCATION_SECTION_ID, LEAD_PLAN_SECTION_ID };

/* The authenticated browser a run granted the authoring agents, as facts: how many calls and how long each may take, and what its answers report. Numbers and a description only; how to use the tools is the role prompt's. */
function renderAgentBrowser(limits: AgentBrowserLimits): string {
  const seconds = Math.round(limits.perCallMs / 1000);
  return [
    `## ${PROMPT_HEADINGS.agentBrowser}`,
    `authbrowser_navigate, authbrowser_snapshot, authbrowser_click and authbrowser_type: at most ${limits.maxCalls} calls this run, ${seconds} seconds each. They read DEV as the test account; a request that writes to DEV, a route this app closes and an address outside its origins are blocked and listed in the answer.`,
    ``,
  ].join("\n");
}

/* The run_spec tool a run granted the generator, as facts: how many calls, how long each may run, how many requests that write to DEV the executed specs may send in all. Numbers only; how to use the tool is the role prompt's. */
function renderClosedLoop(limits: ClosedLoopLimits): string {
  const seconds = Math.round(limits.perCallMs / 1000);
  return [`## ${PROMPT_HEADINGS.closedLoop}`, `run_spec: at most ${limits.maxCalls} calls this run, ${seconds} seconds each, ${limits.maxDevWrites} requests that write to DEV (POST, PUT, PATCH, DELETE) in all.`, ``].join("\n");
}

/* The plan a lead is asked for on a coordinated run's planning turn: the shapes it may take and the limits the orchestrator holds it to. The orchestrator decides what each flow may write, how long it takes and what it may run, so the plan carries none of that. */
function renderLeadPlan(limits: PlanningLimits): string {
  const locationField = limits.locations?.length ? `,"location":"<one of: ${limits.locations.join(", ")}>"` : "";
  return [
    `## ${PROMPT_HEADINGS.leadPlan}`,
    `This turn asks for a plan, not for specs: write no file. Close with ONLY a JSON object {"plan": ...} of one of these shapes.`,
    `- {"plan":{"kind":"${LEAD_PLAN_KIND.NOOP}","reason":"<why nothing here is worth a test, or the element and the evidence showing the change cannot be observed on DEV in its current state>"}}`,
    `- {"plan":{"kind":"${LEAD_PLAN_KIND.SINGLE}"}} when the change is one piece of work that you will author yourself.`,
    `- {"plan":{"kind":"${LEAD_PLAN_KIND.FANOUT}","flows":[{"id":"<short-slug>","objective":"<what the flow proves>","acceptance":["<an observable outcome>"],"routes":["/<path the flow visits>"]${locationField}}]}} when the change is several independent flows, each of which can be written and run without the others.`,
    `A fan-out names at most ${limits.maxFlows} flows, and ${limits.maxParallel} are written at once. A flow is one spec file named by its id; no two flows share a file or depend on each other's data.`,
    ...(limits.locations?.length ? [`A flow may name one of the app's locations; a flow without one inherits the run's.`] : []),
    ...(limits.changeRoutes?.length
      ? [`The change is linked to these pages of the app's map: ${limits.changeRoutes.join(", ")}. Give a flow to each page whose behaviour the change alters; a page no flow visits is reported with the plan.`]
      : []),
    ``,
  ].join("\n");
}

/* The app's declared location and the location this authoring scope works at, as facts, with the one rule a delivered spec follows. Present only when the app declares geolocation. */
function renderGeolocation(facts: GeolocationFacts): string {
  const places = Object.entries(facts.places).map(([name, location]) => `${name} (${location.latitude}, ${location.longitude})`);
  return [
    `## ${PROMPT_HEADINGS.geolocation}`,
    `The app's default location: ${facts.default.latitude}, ${facts.default.longitude}. The suite runs at this location unless a spec sets another.`,
    ...(places.length > 0 ? [`Places the app declares: ${places.join("; ")}.`] : []),
    `This authoring scope is at: ${facts.current.latitude}, ${facts.current.longitude} (${facts.scope === "run" ? "the run" : "this flow"}). The authenticated browser, when this run grants it, opens pages at it; the plain Playwright MCP is a separate browser and does not take this value. run_spec and the suite run at the app's default, not at the authoring location: a spec whose expected result depends on a location pins it with setLocation(context, latitude, longitude) from the suite's fixtures.`,    ``,
  ].join("\n");
}

/* The files whose content the surviving sections render compactly: reading one of them re-fetches what the prompt already carries. A section that was shed contributes nothing. */
function providedPathsOf(input: OpencodeRunInput, sectionSizes: Record<string, number>): string[] {
  const paths: string[] = [];
  if (sectionSizes["arch-map"] !== undefined) paths.push(`${input.e2eRelDir}/.qa/context.json`);
  if (sectionSizes[HARNESS_FACTS_SECTION_ID] !== undefined && input.harnessFacts?.fixtures) {
    paths.push(`${input.e2eRelDir}/${input.harnessFacts.fixtures.file}`);
  }
  return paths;
}

function renderCommitMessage(intent: CommitIntent | undefined, includeBody: boolean): string {
  const subject = intent?.message ?? "";
  const body = includeBody ? intent?.body : undefined;
  return sanitizeText(body ? `${subject}\n\n${capText(body)}` : subject).text;
}

/* The reviewer's statement of its own cap is a section of its own, apart from the generator's. */
export const REVIEWER_STEP_LIMIT_SECTION_ID = "reviewer-step-limit";

/* The cap the runtime enforces for the turn, stated as a fact: the number and nothing else. It bounds the turn the prompt is sent for, never the session. A generator, an explorer and a reviewer prompt state it the same way. */
function renderStepLimit(limit: number): string {
  return [`## ${PROMPT_HEADINGS.stepLimit}`, `This turn runs at most ${limit} steps.`].join("\n");
}

/* What each outcome of a milestone asks of the agent, in the words the milestone joins. The verdict's own reason field is the static contract's to name: a regeneration that finds no correction to make says so in the verdict. */
export const MILESTONE_OUTCOME_PHRASES: Readonly<Record<MilestoneOutcome, string>> = {
  "first-spec": "write the first test file",
  "no-op": "decide the no-op and state why",
  "first-correction": "write the first correction",
  "reason-none-applies": "state in the verdict why none applies",
};

/* The milestone of a turn that writes tests: the step by which something should be written, and what meets it. It renders the data of `stepMilestone` and adds none of its own. */
function renderStepMilestone({ midpoint, outcomes }: StepMilestone): string {
  return `By step ${midpoint}: ${outcomes.map((outcome) => MILESTONE_OUTCOME_PHRASES[outcome]).join(", or ")}.`;
}

/* What a turn that writes tests says about the outcome its tests assert. The question is asked where the turn has no supplied, undisputed objective to go by; the rule against weakening a test is stated on every turn that writes tests, whether or not the question is asked, and by no other section. */
export const OBJECTIVE_HEADING = `## Objective — commit to this BEFORE writing`;

export const OBJECTIVE_QUESTION =
  `Before writing, state in ONE line the concrete, user-observable OUTCOME this change introduces — ` +
  `the specific thing a user can see that proves it works (e.g. "the discounted total shows after the ` +
  `cart re-queries"). Write the test to ASSERT that outcome, not merely that the flow runs.`;

export const ANTI_WEAKENING_RULE = `Preserve each test's objective and assertions: a spec MUST still fail if the behavior it covers regresses.`;

/* The steps of a fix the builder words itself. The step that reads the test file is there only where the listing does not tell the agent to read the specs it changes. */
export const FIX_STEPS = {
  readTestFile: `Read the test file to understand what it asserts`,
  readCodeUnderTest: `Read the code under test that the failure points at`,
  changeOnlyWhatIsBroken: `Change only what is broken.`,
} as const;

/* The steps of a fix, numbered from one; a step may carry the lines under it. */
const numbered = (steps: readonly string[]): string[] => steps.map((step, index) => `${index + 1}. ${step}`);

/* The id of the section that lists the suite; it titles the section as well. */
const SUITE_LISTING_SECTION_ID = PROMPT_HEADINGS.existingSuiteManifest;

/* Free text an agent or a test run wrote (what the listing says of a spec, what a failing case reports) crosses the model boundary through the same redaction as any other model-bound text. */
function redactForModel(text: string): string {
  return sanitizeText(text, "model").text;
}

/* THE single way to embed a commit diff into any prompt: capped FIRST (capDiff needs raw `diff --git` boundaries to split/rank files), then secret-scrubbed. Each section is redacted AND guarded (assertNoSecretLeak) independently, with that section's own mode. A diff with no file header at all (several unit-test fixtures pass raw, header-less snippets as `diff`) has no file to key a mode off, so the whole text keeps the prior "model" mode — unchanged for those callers. */
const CODE_FILE_EXTENSIONS = new Set([
  /* Every language this system's watched apps and self-maintenance target today (see CLAUDE.md's "Java + JavaScript/TypeScript" scope note) plus common ecosystems, so a diff hunk touching source code keeps model-mode's narrower, code-aware redaction instead of the config-file default. */
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "java", "go", "rs", "kt", "cs", "rb", "php", "swift",
]);

function diffSectionMode(filePath: string): SanitizeMode {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  return CODE_FILE_EXTENSIONS.has(ext) ? "model" : "issue";
}

const DIFF_HEADER_RE = /^diff --git /;

/* The heading of the diff section of a prompt. The judges read the diff back out of a stored prompt by it (src/server/judge-evidence.ts), so the heading is one constant. */
export const COMMIT_DIFF_HEADING = "## Commit diff";

function cappedDiffText(diff: string): string {
  const capped = capDiff(diff);
  const sections = capped.split(/^(?=diff --git )/m);
  const hasFileHeader = sections.some((s) => DIFF_HEADER_RE.test(s));
  if (!hasFileHeader) {
    const redacted = sanitizeText(capped, "model").text;
    assertNoSecretLeak(redacted, "model", "diff→model");
    return redacted;
  }
  return sections
    .map((section) => {
      const mode: SanitizeMode = DIFF_HEADER_RE.test(section) ? diffSectionMode(extractDiffFilePath(section)) : "issue";
      const redacted = sanitizeText(section, mode).text;
      assertNoSecretLeak(redacted, mode, "diff→model");
      return redacted;
    })
    .join("");
}

export function specFileForFlow(flow: string): string {
  const safe = flow.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "flow";
  return `flows/${safe}.spec.ts`;
}

/* The most route paths of the map the explorer is shown, and the longest one it is shown whole: the map is data read from a file, so each path is cleaned and bounded where it is rendered. */
export const MAX_EXPLORER_MAP_ROUTES = 80;
const MAX_EXPLORER_MAP_ROUTE_CHARS = 160;

/* The route paths the context map declares, so the explorer names a page it maps by the path the rest of the run already uses for it (the context pack ranks, matches and opens the map's routes by exactly that text). One path per line; none, no block. */
function explorerMapRouteLines(input: OpencodeRunInput): string[] {
  const declared: unknown = input.contextMap?.routes;
  if (!Array.isArray(declared)) return [];
  const seen = new Set<string>();
  for (const entry of declared) {
    const path: unknown = (entry as { path?: unknown } | null)?.path;
    if (typeof path !== "string") continue;
    const clean = sanitizeText(path).text.replace(/\s+/g, " ").trim().slice(0, MAX_EXPLORER_MAP_ROUTE_CHARS);
    /* A path is shown whole in inline code: one with a backtick could end it early and write text of its own, and shown any other way it would no longer be the path the map declares. */
    if (clean !== "" && !clean.includes("`")) seen.add(clean);
  }
  const paths = [...seen];
  if (paths.length === 0) return [];
  const listed = paths.slice(0, MAX_EXPLORER_MAP_ROUTES);
  const rest = paths.length - listed.length;
  return [
    ``,
    `## Routes of the app (from the context map)`,
    `When a page you map is one of these routes, set \`routes[].path\` to its listed path verbatim; name any other page by its path in the app's router.`,
    ...listed.map((path) => `- \`${path}\``),
    ...(rest > 0 ? [`(+${rest} more not shown)`] : []),
  ];
}

export function buildExplorerPrompt(input: OpencodeRunInput): string {
  /* Rendering the (empty) diff would give the explorer nothing to map, so its brief would be empty and the manual Context Pack would carry no grounding. Drive the exploration from the guidance instead. */
  if (input.mode === "manual") {
    const guidance = sanitizeText((input.guidance ?? "(no guidance provided)").trim()).text;
    return [
      `Explore the blast radius of the following GUIDANCE for ${input.repo} and return a distilled ExplorationBrief.`,
      `You are READ-ONLY: do NOT write tests or any file. Map the affected flows, then emit ONLY the brief JSON.`,
      ``,
      `## Guidance (the user's instruction — the scope to explore)`,
      guidance,
      ``,
      `Use serena (activate_project, find_symbol, find_referencing_symbols) to locate the code that`,
      `implements the guidance's flows and map its blast radius. Stay strictly within the guidance scope.`,
      ...(input.baseUrl ? [``, `Route context only — you do NOT navigate; selectors stay unverified. LIVE DEV URL: ${input.baseUrl}`] : []),
      ...(input.service
        ? [``, `## Cross-repo (microservice)`, `Related service: ${input.service.repo} (a READ-ONLY staged snapshot — contracts + this commit's changed files, not the full source — is at ${input.service.mirrorDir}). Map the FRONTEND flows that exercise it.`]
        : []),
      ...explorerMapRouteLines(input),
      ``,
      ...explorerStepLimitLines(input),
      `## Output — set builtForSha to ${input.sha}; end with ONLY the ExplorationBrief JSON (schema in your role prompt).`,
    ].join("\n");
  }
  return [
    `Explore the blast radius of commit ${input.sha} of ${input.repo} and return a distilled ExplorationBrief.`,
    `You are READ-ONLY: do NOT write tests or any file. Map the change, then emit ONLY the brief JSON.`,
    ``,
    `## Change intent (Conventional Commits)`,
    `- Type: ${input.intent?.type ?? "unknown"}${input.intent?.breaking ? " (BREAKING)" : ""}`,
    `- Changed files: ${sanitizeText(input.intent?.changedFiles?.join(", ") ?? "").text || "(unknown)"}`,
    ``,
    `## Commit message (the author's intent — subject + body)`,
    renderCommitMessage(input.intent, true),
    ``,
    COMMIT_DIFF_HEADING,
    "```diff",
    cappedDiffText(input.diff),
    "```",
    ...(input.baseUrl ? [``, `Route context only — you do NOT navigate; selectors stay unverified. LIVE DEV URL: ${input.baseUrl}`] : []),
    ...(input.service
      ? [``, `## Cross-repo change (microservice)`, `The change is in ${input.service.repo} (a READ-ONLY staged snapshot — contracts + this commit's changed files, not the full source — is at ${input.service.mirrorDir}). Map the FRONTEND flows that exercise it.`]
      : []),
    ...explorerMapRouteLines(input),
    ``,
    ...explorerStepLimitLines(input),
    `## Output — set builtForSha to ${input.sha}; end with ONLY the ExplorationBrief JSON (schema in your role prompt).`,
  ].join("\n");
}

/* The explorer states the cap its session runs under in a block just before its output block, set apart by a blank line; no cap, no block. It names no milestone: it writes no tests. */
function explorerStepLimitLines(input: OpencodeRunInput): string[] {
  return input.stepLimit !== undefined ? [renderStepLimit(input.stepLimit), ``] : [];
}

/* Assembles the dynamic message for the agent. The "how" lives in agents/agent/qa-generator.md and the skills; only the task + context go here. The diff/guidance are sanitized (cheap defense in depth). Return type is unchanged (string). Use buildPromptAssembled() to get the sectionSizes map for telemetry. `hasInjectedGrounding` is a coarse boolean — the injected grounding (Context Pack ≤6 routes / failure DOM ≤4 routes) may NOT cover the route a regen must touch. To avoid suppressing navigation into a blind/wrong fix, every grounded regen branch carries this explicit anti-blinding escape. */
const groundingUncoveredEscape = (browser: LiveBrowser): string =>
  `If a route you must touch is NOT represented in the injected grounding above, you MUST still ` +
  `${browser.navigate} that specific route before writing its selectors — never guess them.`;

/* The browser an authoring turn reads a page the prompt does not show with: the authenticated one when the run granted it (signed in as the test account), else the Playwright MCP. */
interface LiveBrowser {
  name: string;
  navigate: string;
  snapshot: string;
  /* The plain Playwright MCP also reads console messages and network requests; the authenticated browser does not. */
  runtimeSignals: boolean;
}
const liveBrowserOf = (input: Pick<OpencodeRunInput, "agentBrowser">): LiveBrowser =>
  input.agentBrowser
    ? { name: "the authenticated browser", navigate: "authbrowser_navigate", snapshot: "authbrowser_snapshot", runtimeSignals: false }
    : { name: "the Playwright MCP", navigate: "browser_navigate", snapshot: "browser_snapshot", runtimeSignals: true };

/* How a turn reads code the prompt does not provide: the order the shared rules give, so no prompt names a tool a role may not hold. */
const CODE_TOOLS = "your code tools in the order AGENTS.md gives";

function linkKindLabel(l: { transport: string; source: string }): string {
  if (l.source === "http-backend-resolver") return "BE→BE HTTP";
  if (l.transport === "event") return "event";
  if (l.transport === "rpc") return "RPC";
  return "FE→BE HTTP";
}

function renderServiceLinkLine(
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
  return `- ${tier ? `[IMPACTED:${s(tier)}] ` : ""}\`${s(l.from.repo)}/${s(l.from.file)}#${s(l.from.symbol)}\` -> ` +
    `${s(l.to.repo)} ${s(l.contractRef ?? l.to.symbol)} (${linkKindLabel(l)}, source ${s(l.source)}, confidence ${l.confidence.toFixed(2)})`;
}

function renderFixCaseEvidenceLines(c: QaCase): string[] {
  const lines: string[] = [];
  const hasNetworkErrors = c.networkErrors !== undefined && c.networkErrors.length > 0;
  if (c.httpStatus !== undefined) {
    const urlPart = c.finalUrl !== undefined ? ` at ${redactForModel(c.finalUrl)}` : "";
    lines.push(`  HTTP ${c.httpStatus}${urlPart}`);
  } else if (!hasNetworkErrors && c.finalUrl !== undefined) {
    /* The unknown HTTP line was misleading next to real network evidence, so it is only printed when there is none. */
    lines.push(`  HTTP (unknown) at ${redactForModel(c.finalUrl)}`);
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
  if (c.failureResultCount !== undefined) lines.push(`  DATA STATE result count at the failure point: ${c.failureResultCount}`);
  return lines;
}

/* The settle facts of a failure-point capture, as facts: a page still changing is a moment of a render, not DEV's data state. */
function describeSettle(settle: FailureSettle): string {
  const quiet = settle.quietMs !== undefined ? `, last data response ${settle.quietMs} ms before` : "";
  const tree = settle.treeStable ? "the tree was the same 1 s later" : "the tree changed within 1 s";
  return failureUnsettled(settle)
    ? `NOT SETTLED at the failure point (${settle.inFlight} data request(s) in flight${quiet}; ${tree}): this tree is a moment of a render, not DEV's data state`
    : `settled at the failure point (no data request in flight${quiet}; ${tree})`;
}

/* A failing case as a prompt lists it: its name, the start of its error and what the run saw of the page. The case comes out of the test run, so each text is redacted before it is cut, and no secret is left in part by the cut. */
function renderFixCase(c: QaCase): string[] {
  const error = c.detail === undefined ? "(no detail)" : stripAnsi(redactForModel(c.detail)).slice(0, 500);
  return [`- ${redactForModel(c.name)}\n  Error: ${error}`, ...renderFixCaseEvidenceLines(c)];
}

/* Read only where the agent has no DOM tree and explores the live page itself: with a tree in the prompt it transcribes and does not navigate, so there is nothing to observe. */
const RUNTIME_SIGNALS_LINES: readonly string[] = [
  `- Also inspect runtime signals with the Playwright MCP: browser_console_messages (catch JS errors`,
  `  and warnings — a console error on the changed flow is a real bug signal) and browser_network_requests`,
  `  (read the actual API calls/responses the flow makes, and assert against their real shape — status,`,
  `  required fields, error responses — not invented contracts).`,
];

export interface BuildPromptAssembledOpts {
  /** Explicit byte-budget override for tests/telemetry that must not depend on the live model-window catalog. Undefined ⇒ the qa-generator catalog window (production path). */
  budgetBytes?: number;
  /** The regeneration is sent in the generator session that already holds the run's grounding: the sections it holds are left out. Ignored on a turn that is not a regeneration. */
  continuation?: boolean;
}

/* What the generator session already holds from the turn that opened it, and a continuation therefore leaves out. The run's tool budgets and authoring location stay: they are small and may have moved. */
const HELD_BY_THE_SESSION: ReadonlySet<string> = new Set([
  "working-rules", "regen-discipline", "arch-map", "context-brief", HARNESS_FACTS_SECTION_ID, "static-signal", "service-links",
  "skill-exemplars", APP_LOGIN_SECTION_ID, "context-pack", "learned-rules", "diff",
]);

export function buildPromptAssembled(input: OpencodeRunInput, opts: BuildPromptAssembledOpts = {}): AssembledPrompt {
  const isGenerationMode = input.mode !== "context";
  const openapiHint = Array.isArray(input.openapi) ? input.openapi.join(", ") : input.openapi;
  const isCode = input.target === "code";
  /* A re-generation turn (fix / reviewer-corrections / coverage-gap) has already distilled the blast radius — it must not trace it again or re-skim the repo. */
  const isReGen = isGenerationMode && isReGenTurn(input);
  const isContinuation = isReGen && opts.continuation === true;

  const sanitizedDomSnapshot = input.domSnapshot ? sanitizeText(input.domSnapshot, "model").text : undefined;

  /* The tree is a failure-point tree only when the run says so; any other captured tree is the live page. Every reference to "the tree above" below is driven by these two, so a prompt never points at a tree it does not carry. */
  const hasFailureTree = Boolean(sanitizedDomSnapshot && isGenerationMode && input.failureSourced);
  const hasLiveTree = Boolean(sanitizedDomSnapshot && isGenerationMode && !input.failureSourced);

  /* The live DOM has one section: a freshly captured live tree replaces the pack's own (older) live DOM, and the pack keeps whatever else it holds. A failure tree is a different fact and coexists with it. */
  const packText = input.contextPack && isGenerationMode ? input.contextPack : "";
  const packHasLiveDom = packText !== "" && deriveClaimsFromPackText(packText).some((c) => c.kind === "provides" && c.fact === "dom-live");
  const contextPackContent = packHasLiveDom && hasLiveTree ? (withoutPackSection(packText, PACK_HEADINGS.liveDom) ?? "") : packText;
  const contextPackClaims: PromptClaim[] = contextPackContent ? deriveClaimsFromPackText(contextPackContent) : [];
  const packProvides = (fact: FactId): boolean => contextPackClaims.some((c) => c.kind === "provides" && c.fact === fact);
  /* A DOM tree is in the prompt when the pack carries a live DOM or a captured tree is injected: the tree is then the only selector source, and a regeneration fixes from it instead of re-navigating. A pack of contracts alone is not a tree. */
  const treeInPrompt = packProvides("dom-live") || hasFailureTree || hasLiveTree;
  const browser = liveBrowserOf(input);
  const GROUNDING_UNCOVERED_ESCAPE = groundingUncoveredEscape(browser);
  /* A lead's planning turn opens no browser (its session is denied one): it plans from the pack and the code. */
  const planningTurn = isGenerationMode && input.target === "e2e" && Boolean(input.planning) && !isReGen;

  const workingRulesLines: string[] = [
    `## ${PROMPT_HEADINGS.workingRules}`,
    ...(input.mode === "context"
      ? [
          `- This is a CONTEXT mode run: you are building the FE↔BE architecture map, not writing tests.`,
          `- Your ONLY output is ${input.e2eRelDir}/.qa/context.json — do not create or modify any .spec.ts files.`,
          `- Use ONLY serena to read code (activate_project, find_symbol, get_symbols_overview) — no Playwright MCP.`,
          `- Extract from STRUCTURED sources: every route from a routing file, every operation from an OpenAPI spec.`,
          `- Consult the architecture-mapping skill for detailed extraction patterns per source type.`,
          `- The task block in this prompt has the complete procedure. Follow it precisely.`,
        ]
      : isCode
      ? [
          `- This is a CODE mode run: you are testing source-code logic, not a deployed web app.`,
          /* The conventions of the repo's tests are read once, on the first pass: a regeneration works from the failing tests and the code under test. */
          `- Detect the test framework from the repo's dependencies.${isReGen ? "" : " Read 2-3 existing test files for conventions. Match them exactly."}`,
          `- Place generated tests alongside existing ones. Do not install new dependencies. Run no command: the orchestrator compiles and runs the tests after you finish and returns any compile or test failure to you.`,
          `- In your closing verdict JSON, include specMetas with {file, flow, objective, targets} for each spec so the orchestrator can write the manifest deterministically.`,
          `- Classify each affected symbol:`,
          `  * Pure function → unit test: call with inputs, assert outputs`,
          `  * Module with deps → integration test: real module + test doubles`,
          `  * Handler/endpoint → integration test: test client, real request, assert status + body`,
          `  * Trivial delegation/getter/setter → skip`,
          `- Assert on BEHAVIOR, not implementation. Include edge cases.`,
          `- One objective per test. Use realistic test data.`,
          `- Never write a test whose only assertion is "does not throw".`,
        ]
      : [
          `- Work in the repo's tests folder: ${input.e2eRelDir}/ (source of truth in git). Reuse and improve existing fixtures/specs; do not duplicate.`,
          `- In your closing verdict JSON, include specMetas with {file, flow, objective, targets} for each spec. The orchestrator writes the manifest deterministically from these.`,
          `- Test-data prefix: ${input.namespace}`,
          `- LIVE DEV URL: ${input.baseUrl ?? "(not provided — ABORT and report infra-error: no base URL)"}`,
          `  In the SPEC files, reach the app via the PW_BASE_URL env var (the orchestrator sets it at run time).`,
          ...(planningTurn
            ? [
                `- This turn plans and opens no browser.${packProvides("dom-live") ? ` The "Live DOM" section is what DEV rendered for the pages it lists; a flow that visits another page names it, and its author reads it.` : " The authors of the flows read the pages they visit."}`,
                `  Find what the change reaches (its callers and the pages that use it) with ${CODE_TOOLS}.`,
              ]
            : packProvides("dom-live")
            ? [
                `- A Context Pack (live DOM${packProvides("api-operations") ? " + contracts" : ""}) was pushed into this prompt by the`,
                `  orchestrator before this session started. Where the pack supplies the DOM for a route,`,
                `  TRANSCRIBE selectors directly from the "Live DOM" section — do NOT use ${browser.navigate} or`,
                `  ${browser.snapshot} on routes already covered in the pack.`,
                `  For routes NOT covered in the pack (not listed in the DOM section), use ${browser.name}`,
                `  to explore the live page before writing selectors.`,
              ]
            : treeInPrompt
            ? [
                `- An injected a11y tree is provided below for the affected routes —`,
                `  transcribe selectors from it; do NOT ${browser.navigate} a route it covers. Use ${browser.name}`,
                `  only for a route NOT present in that tree.`,
              ]
            : [
                `- You MUST read the live page with ${browser.name} BEFORE writing any test: ${browser.navigate} to`,
                `  the LIVE DEV URL above, then ${browser.snapshot} to read the ACTUAL DOM. Selectors MUST be verified`,
                `  against the real DOM, NEVER invented from code analysis alone.`,
                ...(browser.runtimeSignals ? RUNTIME_SIGNALS_LINES : []),
              ]),
          /* Where the contract is, as a fact; the static layers own the rule for reading it. */
          ...(openapiHint ? [`- OpenAPI contract(s) for this repo: ${openapiHint}.`] : []),
        ]),
  ];
  const workingRulesContent = workingRulesLines.join("\n");
  const workingRulesClaims: PromptClaim[] = input.mode !== "context" && !isCode && !treeInPrompt ? [claim.directs("use-runtime-signals")] : [];

  /* The brief owns FE-BE links when it carries them (the map yields its own), the pack's contracts section owns API operations when present (the map yields its list), and a brief drops its landmark hints when a tree exists. */
  const archMap = input.contextMap
    ? renderArchitectureContextParts(
        input.contextMap,
        input.mode === "diff" ? input.intent?.changedFiles : undefined,
        {
          suppressFeBeLinks: Boolean(input.contextBrief?.feBe?.length),
          suppressApiOperations: packProvides("api-operations"),
        },
      )
    : null;
  const archMapContent = input.contextMap ? [archMap?.text ?? "", ``].join("\n") : "";
  const archMapClaims: PromptClaim[] = archMap?.claims ?? [];
  const mapInjected = archMap !== null;
  const blastRadiusSupplied = Boolean(input.contextBrief?.blastRadius.length);
  /* The suite as this turn knows it: the specs that already exist, listed for a diff or a manual run, and the specs this run has delivered, which only a regeneration carries; with, on a regeneration, the marks of the specs it must change. A prompt that lists no spec has no listing section. */
  const listing = buildSuiteListing(
    isGenerationMode
      ? {
          ...(input.mode === "diff" || input.mode === "manual" ? { existing: input.existingSpecFiles } : {}),
          delivered: input.deliveredSpecs,
          fixCases: input.fixCases,
          reviewCorrections: input.reviewCorrections,
          coverageGap: input.coverageGap,
          selectorContradictions: input.selectorContradictions,
          attributedSpecFiles: input.attributedSpecFiles,
        }
      : {},
    { sanitize: redactForModel },
  );
  const listingContent = renderSuiteListing(listing);
  const suiteIsListed = listingContent !== "";
  /* The listing tells the agent to read the specs it changes when it has some editable. */
  const editableListed = listing.editable.length > 0;

  const briefShowsLandmarks = Boolean(input.contextBrief?.routes?.some((r) => r.domLandmarks?.length)) && !treeInPrompt;
  const contextBriefContent = input.contextBrief
    ? [
        renderBrief(input.contextBrief, { omitLandmarks: treeInPrompt }),
        `(The brief above is established: it distilled the blast radius, risks, objective and contracts, so do NOT re-read that code. Verification is the harness's job — its static, execution and review gates.${briefShowsLandmarks ? " Route landmarks are hints, never selectors." : ""})`,
        ``,
      ].join("\n")
    : "";
  const contextBriefClaims: PromptClaim[] = input.contextBrief ? briefClaims(input.contextBrief, briefShowsLandmarks) : [];

  const domContent = sanitizedDomSnapshot && isGenerationMode
    ? hasFailureTree
      ? [
          `## ${PROMPT_HEADINGS.groundTruthAtFailure}`,
          ``,
          `The tree below is the page AT THE FAILURE POINT — the ONLY source of truth for this fix.`,
          `Do NOT use general knowledge of what tables, forms, or components usually contain.`,
          `The ACTUAL rendered tree is what matters, and it is captured below.`,
          ``,
          `⚠ Counterfactual warning: even if element types commonly expose a given role`,
          `(e.g. tables commonly expose \`columnheader\`, forms commonly expose \`textbox\`),`,
          `if THIS tree does NOT show it — trust the tree, not the convention. The live page`,
          `may use CSS \`role="presentation"\` or a custom component that drops standard roles.`,
          ``,
          `📌 Quote-then-assert contract: before writing any locator, cite the EXACT \`role: name\``,
          `line from the tree below that the locator relies on. An unquotable locator`,
          `(i.e. no matching line exists in this tree) MUST be rejected and replaced with a`,
          `\`getByText\` locator quoted from the SAME tree — text visible in the tree below. NEVER`,
          `invent a CSS selector or data-testid value that is not present in this grounding.`,
          ``,
          sanitizedDomSnapshot,
          ``,
        ].join("\n")
      : [
          `## ${PROMPT_HEADINGS.liveDevTree} (GROUND TRUTH for selectors — trust this over HTML intuition)`,
          ``,
          `These are the roles + accessible names the browser ACTUALLY exposes for the target routes.`,
          `Lines may carry a trailing \`-> [attr=…]\` hint showing id=, name=, href, or type= as well as the test-id attribute.`,
          `Author selectors ONLY from what appears below:`,
          `- If a role you expected (e.g. \`columnheader\`) is NOT listed, it is NOT in the a11y tree —`,
          `  do NOT use \`getByRole\` for it. Fall back to \`getByText\` or a scoped locator.`,
          `- If a name appears MORE THAN ONCE, a bare \`getByRole\`/\`getByText\` matches multiple elements`,
          `  (strict-mode violation) — scope it to a unique parent/section, or use a unique attribute.`,
          ``,
          `Lines tagged [CHANGED: …] are what THIS change introduced — your objective targets these.`,
          ``,
          sanitizedDomSnapshot,
          ``,
        ].join("\n")
    : "";

  const domClaims: PromptClaim[] =
    domContent === ""
      ? []
      : hasFailureTree
      ? [claim.provides("dom-failure"), claim.frames("dom-failure", "established")]
      : [claim.provides("dom-live"), claim.frames("dom-live", "established")];

  /* VOLATILE: Lever-2 deterministic selector contradictions. Each is a VERIFIED finding from comparing the generated specs' selectors against the captured failure-point a11y tree — an absent selector ("role:name is NOT in the captured tree; present roles: …") or an ambiguous one ("matches MULTIPLE nodes …"). */
  const selectorContradictionsContent =
    input.selectorContradictions?.length && isGenerationMode
      ? [
          `## ⚠ Lever-2 selector contradictions (DETERMINISTIC — resolve EVERY one)`,
          ``,
          `These selectors were checked against ${hasFailureTree ? "the captured failure-point tree above" : hasLiveTree ? "the captured tree above" : "the page's captured a11y tree"} and FAILED.`,
          `Each is a verified fact, not a hint: a contradicted \`role:name\` is NOT ${treeInPrompt ? "in the captured tree" : "on the page"}`,
          `(the listed present roles are what IS there) — do NOT re-use it. Replace it with a role/name`,
          `${treeInPrompt ? "that appears in the tree" : "from the present roles listed"}, or a \`getByText\`/scoped locator; for a "matches MULTIPLE" finding,`,
          `scope the locator to a unique parent. You MUST resolve every item before finishing:`,
          ``,
          "```",
          ...input.selectorContradictions.map((c) => `- ${sanitizeText(c).text}`),
          "```",
          ``,
        ].join("\n")
      : "";

  const selectorContradictionsClaims: PromptClaim[] = !selectorContradictionsContent
    ? []
    : hasFailureTree
    ? [claim.directs("consult", "dom-failure")]
    : hasLiveTree
    ? [claim.directs("consult", "dom-live")]
    : [];

  const hasStaticGateCase = Boolean(input.fixCases?.some((c) => c.name === "static-gate"));
  /* The listing tells the agent to read the specs it changes; where it does not, the fix reads the test file itself. */
  const readTestStep = editableListed ? [] : [FIX_STEPS.readTestFile];

  const fixContent = input.fixCases?.length && isGenerationMode
    ? [
        `## Fix failing tests`,
        ``,
        ...(hasStaticGateCase
          ? [
              `The following is a failing gate (static analysis — compile/lint), not an executed test`,
              `failure. Fix the underlying error; do NOT rewrite or touch tests that passed the gate.`,
            ]
          : [
              `The following tests FAILED during execution${isCode ? "" : " against DEV"}. Fix ONLY these`,
              `tests; do NOT rewrite or touch tests that passed.`,
            ]),
        ``,
        `Failed cases:`,
        ...input.fixCases.flatMap(renderFixCase),
        ``,
        ...(hasFailureTree
          ? [
              `The captured a11y tree at the failure point is injected ABOVE as "${PROMPT_HEADINGS.groundTruthAtFailure}".`,
              ...numbered([
                ...readTestStep,
                [
                  `Consult ONLY that tree — do NOT navigate or snapshot the live page.`,
                  `   The tree above is the page AT THE FAILURE POINT, not the current live state.`,
                  `   ${GROUNDING_UNCOVERED_ESCAPE}`,
                ].join("\n"),
                [
                  `Fix the ROOT CAUSE, guided by the error type:`,
                  `   - "strict mode violation" → scope the selector to a section first`,
                  `   - "locator.click: … not found" → the element doesn't exist; check role/label in that tree`,
                  `   - "expect(…).toBeVisible() timed out" → the element exists but isn't visible; check loading states`,
                  `   - "locator resolved to N elements" → use .filter({hasText:…}) or scope to a unique parent`,
                ].join("\n"),
                FIX_STEPS.changeOnlyWhatIsBroken,
              ]),
            ]
          : treeInPrompt
          ? [
              `Fix from the injected grounding above (the DOM tree) — do NOT navigate to re-derive`,
              `a route it already covers; navigate ONLY a route absent from the injected grounding.`,
              GROUNDING_UNCOVERED_ESCAPE,
              ...numbered([
                ...readTestStep,
                `Resolve the failing selector/assertion against the injected grounding above`,
                [
                  `Fix the ROOT CAUSE, guided by the error type:`,
                  `   - "strict mode violation" → scope the selector to a section first`,
                  `   - "locator.click: … not found" → the element doesn't exist; check role/label in the injected grounding`,
                  `   - "expect(…).toBeVisible() timed out" → the element exists but isn't visible; check loading states`,
                  `   - "locator resolved to N elements" → use .filter({hasText:…}) or scope to a unique parent`,
                ].join("\n"),
                FIX_STEPS.changeOnlyWhatIsBroken,
              ]),
            ]
          : isCode
          ? [
              `For each failure:`,
              ...numbered([
                ...readTestStep,
                FIX_STEPS.readCodeUnderTest,
                `Fix the ROOT CAUSE: a wrong expectation, a wrong test double or setup, or a compile error`,
                FIX_STEPS.changeOnlyWhatIsBroken,
              ]),
            ]
          : [
              `For each failure, use ${browser.name} to explore the page and verify`,
              `your fix BEFORE writing it:`,
              ...numbered([
                ...readTestStep,
                `Use ${browser.navigate} + ${browser.snapshot} to see the ACTUAL page structure`,
                [
                  `Fix the ROOT CAUSE, guided by the error type:`,
                  `   - "strict mode violation" → scope the selector to a section first`,
                  `   - "locator.click: … not found" → the element doesn't exist; check role/label`,
                  `   - "expect(…).toBeVisible() timed out" → the element exists but isn't visible; check loading states`,
                  `   - "NS_ERROR_…" / network error → the URL or route is wrong; verify with ${browser.navigate}`,
                  `   - "locator resolved to N elements" → use .first() ONLY as last resort; prefer scoping`,
                ].join("\n"),
                FIX_STEPS.changeOnlyWhatIsBroken,
              ]),
            ]),
        ``,
      ].join("\n")
    : "";

  const fixContentClaims: PromptClaim[] = fixContent && hasFailureTree ? [claim.directs("consult", "dom-failure")] : [];

  /* VOLATILE: Reviewer corrections — the highest-priority re-generation signal. The agent addresses every flagged item, correcting it or rebutting it with evidence. Positioned in VOLATILE after DOM so the DOM grounding is already established when the corrections reference it. */
  const reviewContent = input.reviewCorrections?.length && isGenerationMode
    ? [
        `## Apply reviewer corrections (HIGHEST priority)`,
        ``,
        `An independent reviewer REJECTED the previous specs. Address each finding below: fix the spec`,
        `when the finding holds, or rebut it with the evidence the correction turn accepts when you can show`,
        `it is wrong. Do NOT rewrite specs that were not flagged.`,
        treeInPrompt
          ? `Re-verify against the injected grounding above (the DOM tree) before editing — do NOT re-navigate a route it already covers. ${GROUNDING_UNCOVERED_ESCAPE}`
          : isCode
          ? `Where a fix concerns an assertion, re-verify it against the code under test before editing.`
          : `Where a fix concerns a selector or an assertion, re-verify it against the live page with ${browser.name} before editing.`,
        ``,

        ...input.reviewCorrections.map((c) => `- ${sanitizeText(c).text}`),
        ``,
      ].join("\n")
    : "";

  const coverageContent = input.coverageGap && isGenerationMode
    ? [
        `## Cover the change (HIGH priority)`,
        ``,
        `The tests ran green but did NOT exercise all the lines this commit changed. Extend or add`,
        `tests so those lines are actually executed and asserted (covering ≠ asserting — assert the`,
        `behavior of the changed code, do not just touch the line):`,
        ``,
        ...(treeInPrompt
          ? [
              `Resolve any new selectors from the injected grounding above — do NOT re-navigate routes it already covers.`,
              GROUNDING_UNCOVERED_ESCAPE,
              ``,
            ]
          : []),
        input.coverageGap,
        ``,
      ].join("\n")
    : "";

  /* A-2b: the deltas the intent lock found in the previous turn, as facts of this one. Capped, sanitized, and never an order: the generator decides how to restore what its bytes weakened. */
  const contractFeedbackContent = input.contractFeedback?.length && isGenerationMode ? renderContractViolations(input.contractFeedback) : "";

  const learnedRulesContent = input.learnedRules && isGenerationMode
    ? [input.learnedRules, ``].join("\n")
    : "";

  /* A brief that carries a blast radius already has it distilled; the advisory structural copy of it only appears when there is none. */
  const staticSignalContent = input.staticSignal && isGenerationMode && !blastRadiusSupplied ? input.staticSignal : "";
  /* Only a signal that names symbols is an explored blast radius. One of co-change files alone says which files tend to move together, so it claims nothing explored; a signal that arrives without the flag cannot prove it names symbols and is read the same way. */
  const staticSignalHasSymbols = staticSignalContent !== "" && input.staticSignalHasSymbols === true;
  const signalFact = staticSignalHasSymbols ? "structural-signal" : "co-change";
  const staticSignalClaims: PromptClaim[] = staticSignalContent ? [claim.provides(signalFact), claim.frames(signalFact, "unverified")] : [];

  /* A re-generation turn must not re-orient. What it says about the blast radius holds only when the prompt carries an explored one (a brief with a blast radius, or a structural signal that names symbols); otherwise it only forbids the re-skim. */
  const blastRadiusGrounded = blastRadiusSupplied || staticSignalHasSymbols;
  const regenDisciplineContent = isReGen
    ? [
        `## Re-generation turn — do NOT re-orient`,
        ``,
        blastRadiusGrounded
          ? `Re-generation turn: the blast radius was already explored and distilled above. Do NOT trace the`
          : `Re-generation turn: do NOT trace the`,
        `change's callers again, do NOT re-skim the repository or re-read unchanged`,
        blastRadiusGrounded
          ? `code. Work from the grounding already in this prompt and change only what the correction requires.`
          : `code. Change only what the correction requires.`,
        `(One exception: if a correction names a specific symbol you have not seen, read ONLY that symbol.)`,
        ``,
      ].join("\n")
    : "";
  const continuationContent = isContinuation
    ? [
        `## Continuation — same session`,
        ``,
        `The suite you wrote was run. The working rules, the grounding and the change are earlier in this session`,
        `(or in its summary, if it was compacted): do NOT re-read them, do NOT trace the change's callers again, do NOT re-skim the`,
        `repository and do NOT re-navigate a route you already explored. Change only what the signal below requires.`,
        `If something you need is no longer in this session, look up only that.`,
        GROUNDING_UNCOVERED_ESCAPE,
        ``,
      ].join("\n")
    : "";

  /* The stock auth seed did not sign in: the generator authors the login before any spec. Where to read the login page from depends on whether a live-DOM Context Pack is actually in this prompt. */
  const authSetupPath = `${input.e2eRelDir}/auth.setup.ts`;
  const appLoginContent =
    input.authSeedUnauthored && isGenerationMode && !isCode
      ? [
          `## ${PROMPT_HEADINGS.appLogin}`,
          `${PROMPT_HEADINGS.appLogin} is configured, but ${authSetupPath} is still the stock seed and did not sign in.`,
          `Rewrite ${authSetupPath}: open the login page with the Playwright MCP and read its real fields before writing selectors.`,
          `Import test from @playwright/test, not from ./fixtures.`,
          `Keep reading DEV_TEST_USER and DEV_TEST_PASS. Delete the seed marker on the first line.`,
          `Wait until the password field is hidden (cookies are set on the redirect) before storageState.`,
          `Then write the specs for this change. Each spec that needs the app calls authenticate().`,
          `The orchestrator signs in with your setup file before execute.`,
        ].join("\n")
      : "";

  /* Local sanitize wrapper (this function's own scope — NOT the DIFFERENT s() declared inside renderArchitectureContext further down this file) so untrusted cross-repo strings (data leaving/entering the model boundary) are redacted before reaching the prompt. */
  const s = (x: unknown): string => sanitizeText(String(x ?? "")).text;
  const MAX_LINKS = 40;
  const MAX_DRIFT = 20;
  const hasServiceLinks = Boolean(input.serviceLinks?.length);
  const hasContractDrift = Boolean(input.contractDrift?.length);
  const linkKey = (l: { from: { repo: string; file: string; symbol: string }; to: { repo: string } }): string =>
    `${l.from.repo}/${l.from.file}#${l.from.symbol}->${l.to.repo}`;
  const impactedTierByKey = new Map(
    (input.crossRepoImpact?.impactedLinks ?? []).map(({ link, tier }) => [linkKey(link), tier] as const),
  );
  const tierFor = (l: { from: { repo: string; file: string; symbol: string }; to: { repo: string } }): string | undefined =>
    impactedTierByKey.get(linkKey(l));
  const orderedLinks =
    impactedTierByKey.size > 0 && hasServiceLinks
      ? [
          ...input.serviceLinks!.filter((l) => tierFor(l) !== undefined),
          ...input.serviceLinks!.filter((l) => tierFor(l) === undefined),
        ]
      : input.serviceLinks ?? [];
  const omittedLinkCount = hasServiceLinks ? Math.max(0, orderedLinks.length - MAX_LINKS) : 0;
  const serviceLinksContent =
    (hasServiceLinks || hasContractDrift) && isGenerationMode
      ? [
          `## ${PROMPT_HEADINGS.crossServiceLinks} (deterministic — from the stitcher, advisory)`,
          "Structural cross-service contract links resolved from the code, advisory and NOT a gate; absent links do NOT imply no dependency. Transport/source name how each hop was derived (FE→BE HTTP, BE→BE HTTP, event).",
          "",
          ...(hasServiceLinks
            ? orderedLinks.slice(0, MAX_LINKS).map((l) => {
                const tier = tierFor(l);
                return renderServiceLinkLine(l, s, tier);
              })
            : []),
          ...(omittedLinkCount > 0 ? [`...and ${omittedLinkCount} more link${omittedLinkCount === 1 ? "" : "s"} (truncated at MAX_LINKS=${MAX_LINKS})`] : []),
          ...(hasContractDrift
            ? ["", "### Contract drift (WARNINGS — front calls an endpoint the backend contract does not declare):",
               ...input.contractDrift!.slice(0, MAX_DRIFT).map((d) =>
                 `- WARNING: \`${s(d.from.repo)}/${s(d.from.file)}#${s(d.from.symbol)}\` calls ${s(d.verb)} ${s(d.path)} — not in the contract`)]
            : []),
        ].join("\n")
      : "";

  const serviceLinksClaims: PromptClaim[] = serviceLinksContent
    ? [claim.provides("service-links"), claim.frames("service-links", "unverified")]
    : [];

  const harnessFactsContent = isGenerationMode && input.harnessFacts ? renderHarnessFacts(input.harnessFacts, input.e2eRelDir) : "";

  /* The templates the curriculum selected for the structural patterns of this change, in its order, with the marker of each pattern that has caught a defect. The fold credits exactly these, so a template the curriculum did not select is never rendered. */
  const skillExemplarsContent = (() => {
    if (!isGenerationMode || !input.skillExemplars?.length) return "";
    const proven: Record<string, number> = {};
    for (const e of input.skillExemplars) if (e.proven && e.promotionCount > 0) proven[e.archetype] = e.promotionCount;
    return renderExemplarsForPrompt(input.skillExemplars, { proven });
  })();

  const closedLoopContent = isGenerationMode && input.target === "e2e" && input.closedLoop ? renderClosedLoop(input.closedLoop) : "";
  const agentBrowserContent = isGenerationMode && input.target === "e2e" && input.agentBrowser ? renderAgentBrowser(input.agentBrowser) : "";
  const geolocationContent = isGenerationMode && input.target === "e2e" && input.geolocation ? renderGeolocation(input.geolocation) : "";
  /* Only the first pass is planned: a regeneration repairs specs that exist. */
  const leadPlanContent = isGenerationMode && input.target === "e2e" && input.planning && !isReGenTurn(input) ? renderLeadPlan(input.planning) : "";
  const stepLimitContent = input.stepLimit !== undefined ? renderStepLimit(input.stepLimit) : "";
  const milestone = input.stepLimit !== undefined ? stepMilestone(input, input.stepLimit) : undefined;
  const stepMilestoneContent = milestone ? renderStepMilestone(milestone) : "";

  const diffContent = isGenerationMode ? buildDiffSection(input) : "";

  /* The sections of the prompt, with the task worded for a suite that a listing in the prompt does, or does not, supply, and asking for the outcome again or not. The listing of a turn with specs to change is summarized when the budget cannot hold it, so that its end is cut and its label stays; the plain list of the suite is dropped whole. */
  const assembleWith = (suiteListed: boolean, reaskObjective: boolean): AssembledPrompt => {
    const task = buildTask(input, { mapInjected, blastRadiusGrounded, suiteListed, reaskObjective });
    const sections = [
      section("working-rules", "stable-prefix", workingRulesContent, { priority: 1, cacheable: true, claims: workingRulesClaims }),
      ...(regenDisciplineContent ? [section("regen-discipline", "stable-prefix", regenDisciplineContent, { priority: 2 })] : []),
      ...(archMapContent ? [section("arch-map", "semi-stable", archMapContent, { priority: 1, cacheable: true, claims: archMapClaims, ...(archMap ? { itemIds: archMap.itemIds, omissions: archMap.omissions } : {}) })] : []),
      ...(contextBriefContent ? [section("context-brief", "semi-stable", contextBriefContent, { priority: 2, claims: contextBriefClaims, ...(input.contextBrief ? { itemIds: briefItemIds(input.contextBrief) } : {}) })] : []),
      ...(harnessFactsContent ? [section(HARNESS_FACTS_SECTION_ID, "semi-stable", harnessFactsContent, { priority: 0, claims: [claim.provides("harness-facts")] })] : []),
      ...(closedLoopContent ? [section(CLOSED_LOOP_SECTION_ID, "semi-stable", closedLoopContent, { priority: 0, claims: [claim.provides("closed-loop")] })] : []),
      ...(agentBrowserContent ? [section(AGENT_BROWSER_SECTION_ID, "semi-stable", agentBrowserContent, { priority: 0, claims: [claim.provides("agent-browser")] })] : []),
      ...(geolocationContent ? [section(GEOLOCATION_SECTION_ID, "semi-stable", geolocationContent, { priority: 0, claims: [claim.provides("geolocation")] })] : []),
      ...(suiteIsListed ? [section(SUITE_LISTING_SECTION_ID, "semi-stable", listingContent, { priority: 2, claims: [claim.provides("existing-suite")], ...(editableListed ? { overflow: "summarize" as const } : {}) })] : []),
      ...(staticSignalContent ? [section("static-signal", "semi-stable", staticSignalContent, { priority: 3, claims: staticSignalClaims, itemIds: advisoryLineIds(staticSignalContent) })] : []),
      ...(serviceLinksContent ? [section("service-links", "semi-stable", serviceLinksContent, { priority: 3, claims: serviceLinksClaims, ...(hasServiceLinks ? { itemIds: orderedLinks.slice(0, MAX_LINKS).map((l) => itemId.svcLink(l)), ...(omittedLinkCount > 0 ? { omissions: [{ class: "selection", reason: "link-selection", count: omittedLinkCount }] } : {}) } : {}) })] : []),
      ...(skillExemplarsContent ? [section("skill-exemplars", "semi-stable", skillExemplarsContent, { priority: 3, maxBytes: 1536, claims: [claim.provides("exemplars")] })] : []),
      ...(appLoginContent ? [section(APP_LOGIN_SECTION_ID, "volatile", appLoginContent, { priority: 0, shedAs: "critical-recap" })] : []),
      ...(contextPackContent ? [section("context-pack", "volatile", contextPackContent, { priority: 0, shedAs: "critical-recap", claims: contextPackClaims, ...(input.contextPackItemIds ? { itemIds: input.contextPackItemIds } : {}), ...(input.contextPackOmissions ? { omissions: input.contextPackOmissions } : {}) })] : []),
      /* VOLATILE: grounding (DOM snapshot — priority 1 within VOLATILE so it's first and the selectorContradictions section can reference "the tree above" correctly). */
      ...(domContent ? [section("dom-snapshot", "volatile", domContent, { priority: 1, claims: domClaims })] : []),
      ...(selectorContradictionsContent ? [section("selector-contradictions", "volatile", selectorContradictionsContent, { priority: 2, claims: selectorContradictionsClaims })] : []),
      ...(fixContent ? [section("fix-cases", "volatile", fixContent, { priority: 3, claims: fixContentClaims })] : []),
      /* VOLATILE: reviewer corrections (priority 4 — after grounding context is established). */
      ...(reviewContent ? [section("reviewer-corrections", "volatile", reviewContent, { priority: 4, maxBytes: 20_000, overflow: "drop" })] : []),
      ...(contractFeedbackContent ? [section(CONTRACT_FEEDBACK_SECTION_ID, "volatile", contractFeedbackContent, { priority: 4, maxBytes: 6_000, overflow: "drop" })] : []),
      ...(coverageContent ? [section("coverage-gap", "volatile", coverageContent, { priority: 5, shedAs: "critical-recap" })] : []),
      ...(learnedRulesContent ? [section("learned-rules", "volatile", learnedRulesContent, { priority: 2, claims: [claim.provides("learned-rules")] })] : []),
      section("task", "task", task.text, { priority: 1, claims: task.claims }),
      ...(diffContent ? [section("diff", "task", diffContent, { priority: 2, shedAs: "semi-stable", claims: [claim.provides("diff")] })] : []),
      /* The cap the runtime enforces for this turn, when the host resolved one: a fact of its own, then, on a turn that writes tests, the step by which it should have written something. Both close the prompt. */
      ...(leadPlanContent ? [section(LEAD_PLAN_SECTION_ID, "critical-recap", leadPlanContent, { priority: 0, claims: [claim.provides("lead-plan")] })] : []),
      ...(stepLimitContent ? [section(STEP_LIMIT_SECTION_ID, "critical-recap", stepLimitContent, { priority: 1, claims: [claim.provides("step-limit")] })] : []),
      ...(stepMilestoneContent ? [section(STEP_MILESTONE_SECTION_ID, "critical-recap", stepMilestoneContent, { priority: 2 })] : []),
    ];
    return assemble(isContinuation
      ? [section("continuation", "stable-prefix", continuationContent, { priority: 1 }), ...sections.filter((s) => !HELD_BY_THE_SESSION.has(s.id))]
      : sections, { budgetBytes: opts.budgetBytes ?? roleWindowBytes("qa-generator") });
  };

  /* The listing is a section the byte budget may cut or shed. What the task says about reading the suite depends on whether the listing is there, and the decision not to ask for the outcome again rests on the objectives the listing shows. So when the budget sheds the listing the prompt is assembled again with the task worded for a prompt that has none, so that the agent is sent to read the suite and no claim reads a fact the prompt provides; when it cuts the listing, the prompt is assembled again with what is left of it. Either way the task asks for the outcome. The second assembly is kept only if the question costs the prompt no section and no part of the head of the listing: a wording must not take what the listing is for. */
  let assembled = assembleWith(suiteIsListed, listing.reaskObjective);
  const kept = assembled.sectionSizes[SUITE_LISTING_SECTION_ID];
  if (suiteIsListed && kept !== Buffer.byteLength(listingContent, "utf8")) {
    const reassembled = assembleWith(kept !== undefined, true);
    const keepsEverySection = Object.keys(assembled.sectionSizes).every((id) => reassembled.sectionSizes[id] !== undefined);
    if (keepsEverySection && (kept === undefined || reassembled.text.includes(suiteListingHead(listing)))) assembled = reassembled;
  }
  return { ...assembled, providedPaths: providedPathsOf(input, assembled.sectionSizes) };
}

export function buildPrompt(input: OpencodeRunInput): string {
  return buildPromptAssembled(input).text;
}

/** context.json is read from the WATCHED repo (and committed by this system's own PRs), so it is attacker-influenceable. Every field is sanitized before it reaches the test-writing agent (prompt-injection / secret-exfil defense), and the map is BOUNDED so a huge file cannot blow the token budget. `s()` redacts; MAX_ITEMS caps each section. */
export function renderArchitectureContext(
  ctx: ArchitectureContext,
  changedFiles?: string[],
  opts: { suppressFeBeLinks?: boolean; suppressApiOperations?: boolean } = {},
): string | null {
  return renderArchitectureContextParts(ctx, changedFiles, opts)?.text ?? null;
}

/** The rendered map plus the claims its content makes: the map itself, its API operations and its FE↔BE links when they were rendered, and the grounding ids the delivered span records. */
export function renderArchitectureContextParts(
  ctx: ArchitectureContext,
  changedFiles?: string[],
  opts: { suppressFeBeLinks?: boolean; suppressApiOperations?: boolean } = {},
): { text: string; claims: PromptClaim[]; itemIds: string[]; omissions: Omission[] } | null {
  if (!ctx.routes?.length && !ctx.api?.length) return null;

  const s = (x: unknown): string => sanitizeText(String(x ?? "")).text;
  const MAX_ITEMS = 200;
  const MAX_LEN = 20_000;

  const fullFeBe = changedFiles?.length
    ? ctx.feBe?.filter((link) => {
        const terms = [link.route, link.via ?? "", link.operationId].filter((t) => t && t.length >= 3);
        return changedFiles.some((f) => terms.some((t) => f.includes(t)));
      }) ?? ctx.feBe ?? []
    : ctx.feBe ?? [];
  const relevantLinks = fullFeBe.slice(0, MAX_ITEMS);

  const lines: string[] = [];
  lines.push(`## ${PROMPT_HEADINGS.architectureContext} (from e2e/.qa/context.json)`);
  lines.push(`Built at ${s(ctx.builtAtSha).slice(0, 7)} — the FE↔BE map this app's QA uses to cross the frontend→backend boundary.`);
  lines.push("This map was extracted from source and may be stale or incomplete.");
  lines.push("");

  if (ctx.routes.length) {
    lines.push(`### Routes (${ctx.routes.length} entry points)`);
    for (const r of ctx.routes.slice(0, MAX_ITEMS)) {
      lines.push(`- \`${s(r.path)}\` → ${s(r.component ?? "(unknown component)")}${r.name ? ` ("${s(r.name)}")` : ""}`);
    }
    lines.push("");
  }

  const listsApiOperations = ctx.api.length > 0 && !opts.suppressApiOperations;
  if (listsApiOperations) {
    lines.push(`### API operations (${ctx.api.length} endpoints)`);
    for (const o of ctx.api.slice(0, MAX_ITEMS)) {
      lines.push(`- \`${s(o.operationId)}\`: ${s(o.method)} ${s(o.path)}${o.service ? ` (${s(o.service)})` : ""}`);
    }
    lines.push("");
  }

  if (relevantLinks.length && !opts.suppressFeBeLinks) {
    lines.push(`### FE↔BE links (${relevantLinks.length} of ${ctx.feBe?.length ?? 0} total)`);
    lines.push("Each link tells you which frontend route calls which backend operation — use this to widen the blast radius:");
    for (const l of relevantLinks) {
      lines.push(`- Route \`${s(l.route)}\` → \`${s(l.operationId)}\`${l.via ? ` (via ${s(l.via)})` : ""}`);
    }
    lines.push("");
  }

  if (ctx.flows?.length) {
    lines.push("### Named flows");
    for (const f of ctx.flows.slice(0, MAX_ITEMS)) {
      const opList = f.operations?.length ? ` → ${f.operations.slice(0, MAX_ITEMS).map(s).join(", ")}` : "";
      lines.push(`- **${s(f.id)}**: ${f.routes.slice(0, MAX_ITEMS).map(s).join(", ")}${opList}`);
    }
    lines.push("");
  }

  const out = lines.join("\n");
  const claims: PromptClaim[] = [claim.provides("arch-map"), claim.frames("arch-map", "unverified")];
  if (listsApiOperations) claims.push(claim.provides("api-operations"));
  if (relevantLinks.length && !opts.suppressFeBeLinks) claims.push(claim.provides("fe-be-links"));
  /* The ids of what the rendered map supplies, in the map's own order. A map truncated past MAX_LEN delivers none of them (conservative). */
  const truncated = out.length > MAX_LEN;
  const itemIds = truncated
    ? []
    : [
        ...ctx.routes.slice(0, MAX_ITEMS).map((r) => itemId.route(r.path)),
        ...(listsApiOperations ? ctx.api.slice(0, MAX_ITEMS).map((o) => itemId.op(o.operationId)) : []),
        ...(!opts.suppressFeBeLinks ? relevantLinks.map((l) => itemId.link(l.route, l.operationId)) : []),
        ...(ctx.flows?.length ? ctx.flows.slice(0, MAX_ITEMS).map((f) => itemId.flow(f.id)) : []),
      ];
  /* The entries each rendered list left out to MAX_ITEMS, and only those: a list the caller suppressed (API operations, FE↔BE
   * links) was never rendered, so its cap is not an omission, and a list under the cap omits nothing. */
  const mapCapOmitted =
    Math.max(0, ctx.routes.length - MAX_ITEMS)
    + (listsApiOperations ? Math.max(0, ctx.api.length - MAX_ITEMS) : 0)
    + (!opts.suppressFeBeLinks && fullFeBe.length > 0 ? Math.max(0, fullFeBe.length - MAX_ITEMS) : 0)
    + (ctx.flows?.length ? Math.max(0, ctx.flows.length - MAX_ITEMS) : 0);
  const omissions: Omission[] = mapCapOmitted > 0 ? [{ class: "truncation", reason: "map-cap", count: mapCapOmitted }] : [];
  return { text: truncated ? out.slice(0, MAX_LEN) + "\n…(context truncated)" : out, claims, itemIds, omissions };
}

/* What a rendered brief provides and how it frames it: the blast radius, risks and contracts it distilled are established, its landmark hints (kept only when no DOM tree exists) are not. */
function briefClaims(brief: ExplorationBrief, showsLandmarks: boolean): PromptClaim[] {
  const claims: PromptClaim[] = [];
  const fact = (id: FactId, as: "established" | "unverified"): void => {
    claims.push(claim.provides(id), claim.frames(id, as));
  };
  if (brief.blastRadius.length) fact("blast-radius", "established");
  if (brief.risks?.length) fact("risks", "established");
  if (brief.feBe?.length) claims.push(claim.provides("fe-be-links"));
  if (brief.contracts?.length) fact("contracts", "established");
  if (showsLandmarks) fact("landmarks", "unverified");
  return claims;
}


export function buildContextTask(input: OpencodeRunInput): string {
  const openapiHint = Array.isArray(input.openapi) ? input.openapi.join(", ") : input.openapi;
  const serviceLines = input.services?.length
    ? [
        ``,
        `## Microservice repos (${input.services.length})`,
        `This app's backend is split into microservices. For each repo below, a READ-ONLY staged`,
        `snapshot of its OpenAPI/contract files (NOT its full source) is at the local path shown;`,
        `extract its OpenAPI operations into the SAME context.json, setting each operation's`,
        `"service" field to the repo name shown here:`,
        ``,
        ...input.services.flatMap((s) => {
          const hints = s.openapi ? (Array.isArray(s.openapi) ? s.openapi : [s.openapi]) : undefined;
          const stagedHint = hints?.map((h) => `contracts/${h}`).join(", ");
          return [
            `- **${s.repo}** — staged contract snapshot at: ${s.mirrorDir}`,
            ...(stagedHint ? [`  OpenAPI hint: ${stagedHint} (relative to that staged snapshot)`] : [`  No OpenAPI hint — search that staged snapshot's contracts/ subdir for openapi/swagger files.`]),
          ];
        }),
        ``,
        `The feBe JOIN is still derived from THIS frontend repo's API clients: a client method's`,
        `operationId must match an operation extracted from one of the services above (or from`,
        `this repo's own specs). Do not invent links for services the frontend never calls.`,
      ]
    : [];
  return [
    `Build or refresh the FE↔BE architecture map for ${input.repo}.`,
    ``,
    `## Goal`,
    `Produce a distilled map of the app's architecture so future QA runs can cross the`,
    `frontend→backend boundary without re-deriving it from raw code.`,
    ``,
    `## What to produce`,
    `Write a single JSON file at ${input.e2eRelDir}/.qa/context.json with these sections:`,
    ``,
    `1. **routes** — every frontend entry URL (the unit an E2E targets) + the component it renders.`,
    `   Extract FROM the Angular routing files (e.g. app.routes.ts, *.routes.ts).`,
    `   Required per entry: path (e.g. "/checkout"). Optional: name, component, source.`,
    `   Also give implementationFiles: the repo-relative files that implement the route's page (the files a change to that page would touch, with its template and style files when separate).`,
    ``,
    `2. **api** — every backend operation the app calls.`,
    `   Extract FROM the OpenAPI specs${openapiHint ? ` (hint: ${openapiHint})` : " (search with serena/glob for openapi or swagger files)"}.`,
    `   Required per entry: operationId, method (GET/POST/...), path. Optional: service, spec.`,
    ``,
    `3. **feBe** — the JOIN between frontend routes and backend operations: which route calls which operation.`,
    `   Derive BY following each generated API client method to its operationId.`,
    `   Required per entry: route (a path from routes), operationId (from api). Optional: via (the client method).`,
    `   THE JOIN IS THE WHOLE POINT: every link must resolve to a known route AND a known operation.`,
    ``,
    `4. **flows** (optional) — named user flows grouping routes + operations for readability.`,
    ...serviceLines,
    ``,
    `## Procedure`,
    `1. Activate serena (activate_project) on the working directory.`,
    `2. Find ALL Angular routing files (glob: **/*routes*.ts, **/app-routing*.ts).`,
    `   For each route definition (path + component), add an entry to routes.`,
    `3. Find ALL OpenAPI spec files${openapiHint ? ` (start with ${openapiHint})` : ""}.${input.services?.length ? " Include every microservice repo listed above (their staged contract snapshots are local paths you can read)." : ""}`,
    `   For each operation (operationId + method + path), add an entry to api.`,
    `4. Find the generated API client files (typically src/app/generated/ or similar).`,
    `   For each client method that calls a backend operation, map its call site to a route`,
    `   and add the link to feBe. The operationId in the client MUST match an api entry.`,
    `5. Self-validate: every feBe route exists in routes AND every feBe operationId exists in api.`,
    `   Remove any dangling link BEFORE writing.`,
    `6. Write ${input.e2eRelDir}/.qa/context.json with the four sections + "builtAtSha":"${input.sha}".`,
    ``,
    `## Rules`,
    `- Extract from STRUCTURED sources, never invent. Every route comes from a routing file;`,
    `  every operation from an OpenAPI spec; every link from a generated client.`,
    `- If no OpenAPI spec is found, leave api and feBe empty (a repo with no backend).`,
    `- If routing is file-based (not a central Routes array), enumerate the route files.`,
    `- Do NOT guess or hallucinate paths/operationIds. If a source is missing, leave that section empty.`,
    `- Keep the map small: this is an E2E authoring aid, not exhaustive documentation.`,
    ``,
    `## Output`,
    `End with ONLY this JSON (no other text). \`specs\` names the map relative to ${input.e2eRelDir}/, like every spec path:`,
    `{"specs":[".qa/context.json"],"note":"built architecture map with X routes, Y api operations, Z links"}`,
  ].join("\n");
}

interface TaskParts {
  text: string;
  claims: PromptClaim[];
}

/* The changed-files line every diff-shaped task carries. */
function changedFilesLine(input: OpencodeRunInput, label: string): string {
  return `- ${label}: ${sanitizeText(input.intent?.changedFiles?.join(", ") ?? "").text || "(unknown)"}`;
}

/* The objective part of a task: the rule against weakening a test on every turn that writes tests, and the question of the outcome ahead of it, with its heading and its claim, only where the turn asks it. A regeneration asks unless the listing found every spec under correction to have an objective its lead declared and nobody disputes; a first pass asks, except a code run on a diff, whose first pass has never asked for it. A turn that writes no tests says nothing of either. */
function objectivePart(input: OpencodeRunInput, guards: TaskGuards): TaskParts {
  if (!isTestWritingTurn(input)) return { text: "", claims: [] };
  const asked = isReGenTurn(input) ? guards.reaskObjective : !(input.target === "code" && input.mode === "diff");
  return asked
    ? { text: [OBJECTIVE_HEADING, OBJECTIVE_QUESTION, ANTI_WEAKENING_RULE].join("\n"), claims: [claim.directs("state-outcome")] }
    : { text: ANTI_WEAKENING_RULE, claims: [] };
}

/* A regeneration is a correction turn: the whole-repository analysis, the diff and the scope budget of a first pass are already in the session, and the regen-discipline section owns scope. Every mode keeps what a correction still needs — the objective part, and the intent, guidance or changed files that say what the corrections are about. */
function buildCodeRegenTask(input: OpencodeRunInput, guards: TaskGuards): TaskParts {
  const intent = input.intent;
  const lines: string[] = [];
  if (input.mode === "manual") {
    lines.push(
      `Re-generation pass for the UNIT/INTEGRATION tests of ${input.repo}, FOCUSED on:`,
      ``,
      sanitizeText(input.guidance ?? "(no guidance provided)").text,
    );
  } else if (input.mode === "complete" || input.mode === "exhaustive") {
    lines.push(`Re-generation pass for the ${input.mode} source-code test suite run of ${input.repo}.`);
  } else {
    lines.push(
      `Re-generation pass for the UNIT/INTEGRATION tests of commit ${input.sha} of ${input.repo}.`,
      ``,
      `## Change intent (Conventional Commits)`,
      `- Type: ${intent?.type ?? "unknown"}${intent?.breaking ? " (BREAKING)" : ""}`,
      ``,
      `## Commit message (the author's intent — derive each test's objective from this)`,
      renderCommitMessage(intent, false),
    );
  }
  if (intent?.changedFiles?.length) lines.push(``, changedFilesLine(input, "Changed files (derive the scope from these)"));
  const objective = objectivePart(input, guards);
  if (objective.text) lines.push(``, objective.text);
  return { text: lines.join("\n"), claims: objective.claims };
}

function buildCodeTask(input: OpencodeRunInput, guards: TaskGuards): TaskParts {
  if (isReGenTurn(input)) return buildCodeRegenTask(input, guards);
  const objective = objectivePart(input, guards);
  if (input.mode === "manual") {
    const text = [
      `Generate or update UNIT/INTEGRATION tests for the source code of ${input.repo}, FOCUSED on:`,
      ``,
      sanitizeText(input.guidance ?? "(no guidance provided)").text,
      ``,
      objective.text,
      ``,
      `Read the relevant source and the repo's existing tests (serena); match their framework and conventions.`,
      `Stay focused on the guidance; do not generate unrelated tests.`,
    ].join("\n");
    return { text, claims: [claim.directs("analyze-repo"), ...objective.claims] };
  }
  if (input.mode === "complete" || input.mode === "exhaustive") {
    const text = [
      input.mode === "exhaustive"
        ? `Audit and REGENERATE the source-code test suite of ${input.repo} from scratch.`
        : `Analyze the WHOLE repository ${input.repo} and grow its source-code test suite where it matters.`,
      ``,
      `Read the existing tests and the code (serena: activate_project, get_symbols_overview, find_symbol).`,
      `Test important, UNCOVERED logic; match the repo's existing test framework and conventions.`,
      input.mode === "exhaustive"
        ? `Re-evaluate every existing test for correctness, value and necessity; remove or rewrite the trivial, false-positive, redundant or obsolete.`
        : `Generate tests ONLY for important UNCOVERED logic (the delta). Do not duplicate existing coverage.`,
    ].join("\n");
    return { text, claims: [claim.directs("analyze-repo")] };
  }

  const intent = input.intent;
  const text = [
    `Generate or update UNIT/INTEGRATION tests for the source-code changes in commit ${input.sha} of ${input.repo}.`,
    ``,
    `## Change intent (Conventional Commits)`,
    `- Type: ${intent?.type ?? "unknown"}${intent?.breaking ? " (BREAKING)" : ""}`,
    changedFilesLine(input, "Changed files (derive the scope from these)"),
    ``,
    `## Commit message (the author's intent — derive each test's objective from this)`,
    renderCommitMessage(intent, true),
    ``,
    `Cross-check against the diff: if the code does more than the message claims, test what the code`,
    `actually changes, not just what the message promises.`,
    ``,
    COMMIT_DIFF_HEADING,
    "```diff",
    cappedDiffText(input.diff),
    "```",
    ``,
    `Test the changed logic DIRECTLY (no web, no browser, no Playwright): call the changed functions/`,
    `modules and assert behavior + edge cases. Match the repo's existing test framework and conventions.`,
    ``,
    objective.text,
  ].join("\n");
  return { text, claims: [claim.provides("diff"), ...objective.claims] };
}

function buildServiceBlock(input: OpencodeRunInput): string[] {
  if (!input.service) return [];
  const svcOpenapiHints = input.service.openapi
    ? Array.isArray(input.service.openapi)
      ? input.service.openapi
      : [input.service.openapi]
    : undefined;
  const svcOpenapi = svcOpenapiHints?.map((h) => `contracts/${h}`).join(", ");
  return [
    ``,
    `## Cross-repo change (microservice)`,
    `The commit under test belongs to the microservice ${input.service.repo}, NOT to this frontend repo.`,
    `- A READ-ONLY staged snapshot (its OpenAPI/contract files under contracts/, plus this commit's`,
    `  diff as CHANGE.patch and its changed files' post-change content under changed/ — NOT the`,
    `  service's full source) is at: ${input.service.mirrorDir}`,
    ...(svcOpenapi ? [`- The service's OpenAPI contract(s): ${svcOpenapi} (relative to that staged snapshot)`] : []),
    `- Use the architecture context below (operations whose service matches this repo) plus the`,
    `  staged contract and this commit's staged diff/changed files to find which frontend routes`,
    `  and flows this change affects.`,
  ];
}

/* Rendered whenever the classifier computed a reason, regardless of regen round (unlike the diff cross-check instruction of a first pass, this explains a decision already made, not evidence that may have shed). classificationReason is a MODEL-bound string (it only ever reaches the generation prompt, never an Issue body), so it is sanitized in "model" mode — matching the sibling model-bound calls on this path (domSnapshot). `contradiction` only toggles a STATIC literal suffix (no user/model text flows through it), so there is nothing to sanitize on that field. */
function classifierNoteLines(input: OpencodeRunInput): string[] {
  if (!input.classificationReason) return [];
  return [
    `## Classifier note`,
    `${sanitizeText(input.classificationReason, "model").text}${input.contradiction ? " (the commit message under-promised — trust the diff)" : ""}`,
    ``,
  ];
}

function buildRegenTask(input: OpencodeRunInput, guards: TaskGuards): TaskParts {
  const intent = input.intent;
  const opening =
    input.mode === "manual"
      ? [
          `Re-generation pass for the E2E tests of ${input.repo}, FOCUSED on the following guidance:`,
          ``,
          sanitizeText(input.guidance ?? "(no guidance provided)").text,
        ]
      : input.mode === "complete" || input.mode === "exhaustive"
      ? [`Re-generation pass for the ${input.mode} E2E suite run of ${input.repo}.`]
      : [
          `Re-generation pass for the E2E tests of commit ${input.sha} of ${input.repo}.`,
          ``,
          `## Change intent (Conventional Commits)`,
          `- Type: ${intent?.type ?? "unknown"}${intent?.breaking ? " (BREAKING)" : ""}`,
          changedFilesLine(input, "Changed files (derive the scope/area from these)"),
          ``,
          `## Commit message (the author's intent — derive each test's objective from this)`,
          renderCommitMessage(intent, false),
          ``,
          ...classifierNoteLines(input),
        ];
  const objective = objectivePart(input, guards);
  const text = [
    ...opening,
    ``,
    objective.text,
    ...buildServiceBlock(input),
  ].join("\n");
  return { text, claims: objective.claims };
}

/* What the prompt already supplies, so the task does not send the agent to fetch it again. */
interface TaskGuards {
  /* The architecture map is rendered in this prompt. */
  mapInjected: boolean;
  /* The prompt carries an explored blast radius: a brief that carries one, or a structural signal that names symbols. */
  blastRadiusGrounded: boolean;
  /* The listing of the specs that already exist is in this prompt, which the byte budget may have shed from it. */
  suiteListed: boolean;
  /* The turn asks for the outcome again: a spec under correction has no objective its lead declared, or a reviewer disputes one. Read on a regeneration only. */
  reaskObjective: boolean;
}

/* What a diff of each size asks of the agent. The effort is a ceiling on the work and never a floor: no tier asks for a spec, and declaring the no-op, for either of its reasons, is within every bound. `upperBound` counts focused specs for the whole change, or for each affected flow. The texts carry no figure and no word the lint counts, so the line adds nothing to the directive budget and declares no claim. */
export interface EffortTier {
  upperBound: { specs: number; per: "change" | "flow" };
  admitsNoOp: true;
  text: string;
}

/* The clause every tier ends with, so that what the data declares (the no-op is admitted) is what the text says. */
export const EFFORT_NO_OP_CLAUSE = "or none if nothing here is worth a test or the change cannot be observed on DEV in its current state";
const effortText = (tier: DiffTier, bound: string): string => `Expected effort (${tier} change): at most ${bound}, ${EFFORT_NO_OP_CLAUSE}.`;

export const EFFORT_BY_TIER: Record<DiffTier, EffortTier> = {
  tiny: { upperBound: { specs: 2, per: "change" }, admitsNoOp: true, text: effortText("tiny", "one or two focused specs") },
  focused: { upperBound: { specs: 4, per: "change" }, admitsNoOp: true, text: effortText("focused", "a few focused specs for the affected flows") },
  broad: { upperBound: { specs: 1, per: "flow" }, admitsNoOp: true, text: effortText("broad", "one focused spec per affected flow, not a suite rewrite") },
};

/* The change's real size, from the changed files and the diff's own lines. */
function sizeSentence({ files, added, removed }: DiffStat): string {
  return `The change touches ${files} file${files === 1 ? "" : "s"} with +${added}/-${removed} lines,`;
}

function buildTask(input: OpencodeRunInput, guards: TaskGuards): TaskParts {
  if (input.mode === "context") return { text: buildContextTask(input), claims: [claim.directs("analyze-repo")] };
  if (input.target === "code") return buildCodeTask(input, guards);
  if (isReGenTurn(input)) return buildRegenTask(input, guards);
  if (input.mode === "complete" || input.mode === "exhaustive") {
    const text = [
      input.mode === "exhaustive"
        ? `Audit and REGENERATE the entire E2E suite of ${input.repo} from scratch.`
        : `Analyze the WHOLE repository ${input.repo} and grow the E2E suite where it matters.`,
      ``,
      `1. Read the existing tests in ${input.e2eRelDir}/ and the app code (with ${CODE_TOOLS}) to`,
      `   build a COVERAGE + IMPORTANCE map: which user flows already have tests and which`,
      `   important/complex flows do NOT. Until real coverage instrumentation exists,`,
      `   estimate coverage by reading the existing specs and the code.`,
      `2. Persist this analysis in ${input.e2eRelDir}/.qa/analysis.json (flows, covered vs`,
      `   uncovered, importance, lastSha:"${input.sha}") so it need not be redone from`,
      `   scratch next time; if it already exists, update it incrementally.`,
      input.mode === "exhaustive"
        ? `3. Re-evaluate EVERY existing test for correctness, value and necessity (apply the test-value-review criteria): remove or rewrite tests that are trivial, false positives, redundant or obsolete. Ensure every important flow is covered — a fully re-evaluated suite, not a delta.`
        : `3. Generate tests ONLY for the important UNCOVERED flows (the delta over the existing suite). Do not duplicate existing coverage.`,
    ].join("\n");
    return { text, claims: [claim.directs("analyze-repo")] };
  }
  const objective = objectivePart(input, guards);
  if (input.mode === "manual") {
    const text = [
      `Generate/update E2E tests for ${input.repo}, FOCUSED on the following guidance:`,
      ``,
      sanitizeText(input.guidance ?? "(no guidance provided)").text,
      ``,
      objective.text,
      ``,
      /* The listing supplies the suite; the read of it is declared only where nothing lists it. */
      `Read the relevant code${guards.suiteListed ? "" : ` and the existing ${input.e2eRelDir}/ suite`} with ${CODE_TOOLS}.`,
      `Stay focused on the guidance; do not generate unrelated tests.`,
    ].join("\n");
    return {
      text,
      claims: [claim.directs("analyze-repo"), ...objective.claims, ...(guards.suiteListed ? [] : [claim.directs("read", "existing-suite")])],
    };
  }

  const intent = input.intent;
  const stat = diffStat({ diff: input.diff, changedFiles: input.intent?.changedFiles });
  const text = [
    `Generate/update E2E tests for the flows affected by commit ${input.sha} of ${input.repo}.`,
    ``,
    `## Change intent (Conventional Commits)`,
    `- Type: ${intent?.type ?? "unknown"}${intent?.breaking ? " (BREAKING)" : ""}`,
    changedFilesLine(input, "Changed files (derive the scope/area from these)"),
    ``,
    `## Commit message (the author's intent — derive each test's objective from this)`,
    renderCommitMessage(intent, true),
    ``,
    `Cross-check against the diff: cover what the code actually changes, not only what the message promises.`,
    ``,
    ...classifierNoteLines(input),
    objective.text,
    ``,
    ...(guards.mapInjected
      ? []
      : [
          `## ${PROMPT_HEADINGS.architectureContext}`,
          `If ${input.e2eRelDir}/.qa/context.json exists, READ it to understand which routes and`,
          `API operations the changed files belong to. Use the feBe links to widen the blast`,
          `radius across the frontend→backend boundary: a frontend change may affect the`,
          `backend behaviour and vice-versa. If the map is missing or stale, note the`,
          `limitation explicitly in your verdict note.`,
          ``,
        ]),
    `## Scope budget (diff mode)`,
    `The blast radius IS your budget. ${sizeSentence(stat)} so keep it focused:`,
    ...(guards.blastRadiusGrounded ? [] : [`- Read ONLY the changed symbols and their direct callers/callees, with ${CODE_TOOLS}.`]),
    `- Do NOT read the whole repository, the entire e2e suite, or unrelated flows/files.`,
    /* The listing supplies the suite; the read of it is declared only where nothing lists it. */
    ...(guards.suiteListed ? [] : [`- Read existing specs ONLY for the one or two flows this commit actually touches.`]),
    /* The bound holds in every diff cell. It names no exploration: where the live page is navigated is the working rules' to say, and only without a pack DOM and a tree. */
    `- Work ONLY on the page(s) the change affects — not the whole app.`,
    EFFORT_BY_TIER[diffTier(stat)].text,
    ...buildServiceBlock(input),
  ].join("\n");
  const claims: PromptClaim[] = [...objective.claims];
  if (!guards.mapInjected) claims.push(claim.directs("read", "arch-map"), claim.frames("arch-map", "unverified"));
  if (!guards.blastRadiusGrounded) claims.push(claim.directs("orient", "blast-radius"));
  if (!guards.suiteListed) claims.push(claim.directs("read", "existing-suite"));
  return { text, claims };
}

/* Returns empty string for all non-diff modes, code mode, and re-generation passes (where the diff is already distilled in the grounding above and repeating it burns tokens). */
function buildDiffSection(input: OpencodeRunInput): string {
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

/* ── Reviewer prompt assembly ────────────────────────── The prompt for the independent reviewer session. The contract-repair re-prompt and session lifecycle stay in reviewIndependently; only the BUILD of the initial prompt string lives here. */

export function reviewObjective(input: ReviewInput): { subject: string; heading: string; body: string[]; targetNoun: string } {
  if (input.mode === "manual") {
    const g = sanitizeText(((input.guidance ?? "").trim() || "(no guidance was provided)")).text;
    return {
      subject: "a guided (manual) run",
      heading: `## Objective — the requested behavior (judge against THIS, NOT any commit diff)`,
      body: [g],
      targetNoun: "the requested behavior",
    };
  }
  if (input.mode === "complete" || input.mode === "exhaustive") {
    return {
      subject: `a whole-repo ${input.mode} run`,
      heading: `## Objective — there is no single commit; judge each spec against its OWN stated objective`,
      body: [
        `Each spec declares the user flow it targets (in its header comment / the manifest). Judge`,
        `whether it meaningfully exercises that flow, or could the flow break while the test stays green.`,
      ],
      targetNoun: "the targeted user flow",
    };
  }
  const commitDiffObjective = () => ({
    subject: "this commit",
    heading: COMMIT_DIFF_HEADING,
    /* Cap BEFORE sanitizing: capDiff splits on diff file-header boundaries and must see the raw structure; sanitizeText only redacts secret-shaped substrings. */
    body: ["```diff", cappedDiffText(input.diff), "```"],
    targetNoun: "the change",
  });
  if (input.mode === "diff" || input.target === "code") return commitDiffObjective();
  console.warn(`[qa] reviewObjective: unhandled review mode ${JSON.stringify(input.mode)} — defaulting to the commit-diff objective`);
  return commitDiffObjective();
}

const REVIEW_SPECS_MAX_BYTES = 40_000;

export function renderReviewSpecs(input: ReviewInput): string {
  const rel = (s: string) => (input.e2eRelDir ? `${input.e2eRelDir}/${s}` : s);
  /* The specs are the names the generator reported: each is read through the confined reader, so one that leaves the spec directory is judged from the placeholder below, never from what it points at. */
  const root: SpecRoot = { mirrorDir: input.mirrorDir, specDir: join(input.mirrorDir, input.e2eRelDir) };
  const contents: string[] = [];
  let totalBytes = 0;
  for (const s of input.specs) {
    let content: string;
    try {
      content = readConfinedSpecFile(root, s);
    } catch (err) {
      /* A spec the independent reviewer NEVER sees can otherwise ship inside an approved batch — that silently bypasses the quality gate. Surface it loudly (CLAUDE.md: never swallow), like the byte-cap branch below does for its own mode switch. */
      console.warn(`[qa] WARNING: could not read spec '${rel(s)}' for review (${err instanceof Error ? err.message : String(err)}) — it will be judged from a placeholder, NOT its real content.`);
      contents.push(`### ${rel(s)}\n( could not read file — review skipped for this spec )`);
      continue;
    }
    const block = `### ${rel(s)}\n\`\`\`typescript\n${content}\n\`\`\``;
    totalBytes += Buffer.byteLength(block, "utf8");
    if (totalBytes > REVIEW_SPECS_MAX_BYTES) {
      console.warn(
        `[qa] WARNING: the combined contents of ${input.specs.length} spec(s) exceed the ${REVIEW_SPECS_MAX_BYTES}-byte inline cap — ` +
          `the reviewer will read files itself instead of judging inlined contents (weaker determinism).`,
      );
      return `## Specs to review\n\n${input.specs.map((n, i) => `${i + 1}. ${rel(n)}`).join("\n")}\n\n( spec contents exceed ${REVIEW_SPECS_MAX_BYTES} bytes — read each file with the read tool )`;
    }
    contents.push(block);
  }
  return `## Specs to review (${contents.length} file(s) — contents provided inline)\n\n${contents.join("\n\n")}`;
}

/** Renders a deterministic RUNTIME EXECUTION RESULT section from the orchestrator's evidence (HTTP status codes and final URLs captured during test execution). This is evidence the reviewer can use to distinguish an app defect (5xx) from a test defect — captured by the orchestrator, not inferred from the generator's reasoning, so reviewer independence is preserved. Output is bounded at 4000 chars total; per-case detail is capped at 500 chars. finalUrl is sanitized via sanitizeText before being included in the prompt (prevents secrets in redirect URLs from leaking to the reviewer model). */
export interface ExecutionResultCase {
  name: string;
  httpStatus?: number;
  finalUrl?: string;
  detail?: string;
}

export function renderExecutionResult(evidence: {
  verdict: string;
  cases: ExecutionResultCase[];
}): string {
  const CAP_TOTAL = 4000;
  const CAP_TOTAL_INTERNAL = CAP_TOTAL - 130;
  const CAP_DETAIL = 500;
  const CAP_DETAIL_INTERNAL = CAP_DETAIL - 130;

  const lines: string[] = [
    `## RUNTIME EXECUTION RESULT (captured by the orchestrator, not inferred)`,
    ``,
    `Verdict: ${evidence.verdict}`,
    ``,
  ];

  for (const c of evidence.cases) {
    lines.push(`- ${c.name}`);
    if (c.httpStatus !== undefined) {
      lines.push(`  httpStatus: ${c.httpStatus}`);
    }
    if (c.finalUrl !== undefined) {
      const { text: sanitized } = sanitizeText(c.finalUrl);
      lines.push(`  finalUrl: ${sanitized}`);
    }
    if (c.detail !== undefined) {
      const capped = capText(c.detail, CAP_DETAIL_INTERNAL);
      lines.push(`  detail: ${capped}`);
    }
  }

  const raw = lines.join("\n");
  if (raw.length <= CAP_TOTAL) return raw;
  return capText(raw, CAP_TOTAL_INTERNAL);
}

/* At most this many violations reach one prompt; the rest are counted so the agent knows the list is abridged. */
const CONTRACT_FEEDBACK_MAX = 6;

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

export function buildReviewerPromptAssembled(input: ReviewInput): AssembledPrompt {
  const changeType = input.intent?.type ?? input.mode;
  const specBlock = renderReviewSpecs(input);
  const kind = input.target === "code" ? "tests" : "E2E tests";
  const obj = reviewObjective(input);

  const roleFramingContent = [
    `<!-- reviewer-prompt-version: ${REVIEWER_PROMPT_VERSION} -->`,
    `## Independent review — judge these ${kind} WITHOUT the generator's reasoning`,
    ``,
    `You are reviewing tests written for ${obj.subject}, but you have NO access to the`,
    `generator's thought process. Judge the tests on their own merit using the`,
    `test-value-review skill.`,
    ``,
    `## Review context`,
    `- Run type: ${changeType}`,
    `- Base URL: ${input.baseUrl ?? "(not provided)"}`,
  ].join("\n");

  const rulesInstruction = input.learnedRules
    ? [`7. Also REJECT if any spec violates an app-specific reject-on-sight rule provided in this prompt.`]
    : [];
  const instructionsContent = [
    `## Instructions`,
    `1. The spec contents are provided in this prompt — no need to read files.`,
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

  const objectiveContent = [obj.heading, ...obj.body].join("\n");

  /* Live DEV DOM: actual roles + accessible names on the routes this spec targets. Captured by the orchestrator (reviewer independence). Model-mode sanitization — this is prompt text, never an Issue body. */
  const domContent = input.domSnapshot
    ? [
        `## Live DEV DOM — the ACTUAL roles + accessible names on the routes this spec targets`,
        `Captured by the orchestrator from ${input.baseUrl ?? "DEV"}. Judge EVERY concrete UI fact`,
        `(button/link labels, headings, routes) against THIS, never against prior knowledge of similar apps.`,
        "```",
        sanitizeText(input.domSnapshot, "model").text,
        "```",
      ].join("\n")
    : "";

  const specContent = specBlock;
  /* The existing suite is context, never a review target: the reviewer sees what already exists so
   * it does not mistake a pre-existing file for a missing part of this change. */
  const existingSpecsContent = input.existingSpecFiles?.length
    ? [
        `## Existing suite — context only`,
        `These files already exist in the suite. Do NOT judge them and do NOT raise corrections against them; judge only the specs in the "Specs under review" section.`,
        ...input.existingSpecFiles.map((file) => `- ${sanitizeText(file).text}`),
      ].join("\n")
    : "";

  const learnedRulesContent = input.learnedRules ? [``, input.learnedRules].join("\n") : "";

  const PRIOR_CORRECTIONS_MAX_BYTES = 8_000;
  const priorCorrectionsContent = (() => {
    if (!input.priorCorrections || input.priorCorrections.length === 0) return "";
    const lines = input.priorCorrections.map((c, i) => `${i + 1}. ${sanitizeText(c).text}`).join("\n");
    const raw = [
      `## Prior-round corrections (from YOUR previous verdict on these specs)`,
      ``,
      `Only the specs listed as materially changed in the next section are new to you; the spec`,
      `change is excerpted there. Judge that change, not the whole suite again.`,
      `- APPROVE if the previously-raised BLOCKING issues are resolved (do not re-raise them).`,
      `- Raise a NEW blocking correction only if the change introduced a new anti-pattern.`,
      `- Omit advisory nits; they are not worth a round.`,
      ``,
      lines,
    ].join("\n");
    if (Buffer.byteLength(raw, "utf8") > PRIOR_CORRECTIONS_MAX_BYTES) {
      const truncated = raw.slice(0, PRIOR_CORRECTIONS_MAX_BYTES);
      return truncated + "\n… (truncated — see spec contents for the full picture)";
    }
    return raw;
  })();

  /* Second-round focus: the spec lines that changed since the reviewer's own rejection, bounded and
   * sanitized like every other agent-authored text that becomes prompt text. */
  const SPEC_CHANGE_MAX_BYTES = 4_000;
  const specChangeContent = (() => {
    if (!input.specChanges || input.specChanges.trim() === "") return "";
    const raw = [
      `## Spec change since your last rejection (material change only)`,
      ``,
      `This is the change the generator made in response to your corrections. Anything not shown here`,
      `is unchanged since the specs you already judged.`,
      ``,
      sanitizeText(input.specChanges, "model").text,
    ].join("\n");
    return Buffer.byteLength(raw, "utf8") > SPEC_CHANGE_MAX_BYTES
      ? `${raw.slice(0, SPEC_CHANGE_MAX_BYTES)}\n… (change truncated)`
      : raw;
  })();

  /* VOLATILE: runtime execution evidence. Deterministic orchestrator evidence (HTTP status codes + final URLs captured via page.on('response')) injected BEFORE the spec contents so the reviewer can weigh the objective server-error signal before reading test code. Priority 1.5 — after DOM grounding (which grounds UI facts) but before specs themselves. Absent when the run produced no execution evidence (first-time generate, code mode, etc.). */
  const executionResultContent = input.executionResult ?? "";

  return assemble([
    section("reviewer-role-framing", "stable-prefix", roleFramingContent, { priority: 1, cacheable: true }),
    section("reviewer-instructions", "stable-prefix", instructionsContent, { priority: 2, cacheable: true }),
    section("reviewer-objective", "semi-stable", objectiveContent, { priority: 1, language: "verbatim", maxBytes: 56_000, overflow: "summarize" }),
    /* VOLATILE: DOM grounding (priority 1 — first in VOLATILE so it precedes the spec contents that reference it; the instructions refer to it position-independently as "the Live DEV DOM section"). 20,000B mirrors the reviewer-corrections idiom; overflow:"summarize" for a visible-marker truncation instead of a silent whole-section drop. */
    ...(domContent ? [section("reviewer-dom", "volatile", domContent, { priority: 1, maxBytes: 20_000, overflow: "summarize" })] : []),
    ...(executionResultContent ? [section("reviewer-execution-result", "volatile", executionResultContent, { priority: 1.5 })] : []),
    section("reviewer-specs", "volatile", specContent, { priority: 2, maxBytes: 44_000, overflow: "summarize" }),
    ...(existingSpecsContent ? [section("reviewer-existing-suite", "volatile", existingSpecsContent, { priority: 3, maxBytes: 8_000, overflow: "summarize" })] : []),
    ...(learnedRulesContent ? [section("reviewer-learned-rules", "volatile", learnedRulesContent, { priority: 3 })] : []),
    /* VOLATILE: prior-round corrections (priority 4 — convergence context; lowest priority in VOLATILE so it does not crowd out the spec contents or DOM grounding on budget overflow). */
    ...(priorCorrectionsContent ? [section("reviewer-prior-corrections", "volatile", priorCorrectionsContent, { priority: 4 })] : []),
    /* What the generator changed since the rejection this round answers: the smallest section in the
     * prompt, and the one the round is about. Shed first when the window is tight. */
    ...(specChangeContent ? [section("reviewer-spec-change", "volatile", specChangeContent, { priority: 5 })] : []),
    /* The cap the reviewer's session runs under, when the host resolved one: a fact of its own, placed before the verdict contract so that the contract still ends the prompt. */
    ...(input.stepLimit !== undefined ? [section(REVIEWER_STEP_LIMIT_SECTION_ID, "critical-recap", renderStepLimit(input.stepLimit), { priority: 0, claims: [claim.provides("step-limit")] })] : []),
    section("reviewer-output-contract", "critical-recap", outputContractContent, { priority: 1 }),
  ], { budgetBytes: roleWindowBytes("qa-reviewer") });
}

export function buildReviewerPrompt(input: ReviewInput): string {
  return buildReviewerPromptAssembled(input).text;
}
