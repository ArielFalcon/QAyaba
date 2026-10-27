/*
 * The section registries of the delegation briefs: what an author sidekick and an explore sidekick are handed. A brief states four
 * things, each in exactly one section: the objective (what the sidekick is for), the return shape, the boundary (what it may write
 * and must not do) and the tools it holds; the prompt-contract lint holds it to that (R17) and to stating only what its turn
 * grants (R18). Sections are ordered by priority alone: one tier.
 */
import { claim, harnessFactLines } from "@contexts/generation/application/index.ts";
import type { PromptSectionDef } from "@kernel/prompt-sections.ts";
import type { PromptClaim } from "@kernel/prompt-claim.ts";
import { ACCEPTANCE_STATUSES } from "../acceptance-report.ts";
import { briefTools, type BriefCandidate, type DelegationBrief } from "../delegation-brief.ts";
import { CANDIDATE_CLAIMS } from "../delegation-result.ts";
import { MAX_FINDINGS } from "../exploration.ts";
import { questionIdOf } from "./explore-ids.ts";

/* One brief and the scrub every free-form field of it passes at this egress. */
export interface BriefPromptContext {
  brief: DelegationBrief;
  scrub(text: string): string;
}

/* What each tool family lets the sidekick do, in the words the brief states it. A tool the table does not know is named alone. */
const TOOL_STATEMENT: Readonly<Record<string, string>> = {
  read: "read the files under readablePaths",
  write: "write the files under writablePaths and no other",
  run_spec: "run the spec you wrote",
  authbrowser: "read DEV through the authenticated browser (authbrowser_*); it never writes",
  set_geolocation: "move the authoring location",
  codegraph: "walk the code graph (codegraph_explore), read-only",
  playwright: "drive a browser against DEV",
};

const toolLine = (tool: string): string => (TOOL_STATEMENT[tool] ? `- ${tool}: ${TOOL_STATEMENT[tool]}` : `- ${tool}`);

const section = (def: Omit<PromptSectionDef<BriefPromptContext>, "tier" | "applies"> & { applies?: PromptSectionDef<BriefPromptContext>["applies"] }): PromptSectionDef<BriefPromptContext> => ({
  tier: "task",
  applies: () => true,
  ...def,
});

/* The objective: the sidekick's identity in the run and what it is for. */
const taskSection = (heading: string, lines: (ctx: BriefPromptContext) => string[]): PromptSectionDef<BriefPromptContext> =>
  section({ id: "task", priority: 10, render: (ctx) => ({ content: [heading, ...lines(ctx)].join("\n"), claims: [claim.statesContract("objective")] }) });

const toolsSection = section({
  id: "tools",
  priority: 95,
  render: ({ brief }) => {
    const tools = briefTools(brief);
    return {
      content: ["## Tools", tools.length > 0 ? "You hold only these tools:" : "You hold no tool.", ...tools.map(toolLine)].join("\n"),
      claims: [claim.statesContract("tools"), ...tools.map((tool) => claim.statesTool(tool))],
    };
  },
});

const optionalList = (heading: string, items: readonly string[]): string => (items.length === 0 ? `${heading}\n(none)` : [heading, ...items].join("\n"));

/* The use cases this flow must exercise: where the change reaches each, the changed code, and where the expected behavior comes from. */
function changeText(candidates: readonly BriefCandidate[], scrub: (text: string) => string): string {
  return [
    "## Change this flow must exercise",
    "Expected values come from the contract or the commit's stated intent, never from what the page shows: a page that already shows the new behavior proves nothing about the change.",
    ...candidates.flatMap((candidate) => [
      `### ${candidate.id}: ${scrub(candidate.entry)} (${candidate.tier})`,
      candidate.evidence.length > 0 ? `Reached through: ${candidate.evidence.map(scrub).join(" > ")}` : "",
      candidate.symbols.length > 0 ? `Changed symbols: ${candidate.symbols.map(scrub).join("; ")}` : "",
      `Expected behavior comes from: ${candidate.expectedFrom.map((source) => `${source.kind} (${scrub(source.ref)})`).join("; ")}`,
      ...candidate.hunks.map((hunk) => ["Changed code:", "```diff", scrub(hunk), "```"].join("\n")),
    ].filter(Boolean)),
  ].join("\n");
}

/* How many suite lines a brief lists, and the longest of them; the rest are counted. */
export const BRIEF_MAX_SUITE_LINES = 30;
export const BRIEF_MAX_SUITE_LINE_CHARS = 300;

const harnessLines = ({ brief, scrub }: BriefPromptContext): string[] => (brief.harnessFacts ? harnessFactLines(brief.harnessFacts, brief.specRelDir ?? "e2e", scrub) : []);

function suiteText({ brief, scrub }: BriefPromptContext): string {
  const suite = brief.suite ?? [];
  const shown = suite.slice(0, BRIEF_MAX_SUITE_LINES).map((line) => {
    const flat = scrub(line).replace(/\s+/g, " ").trim();
    return `- ${flat.length > BRIEF_MAX_SUITE_LINE_CHARS ? `${flat.slice(0, BRIEF_MAX_SUITE_LINE_CHARS - 1)}…` : flat}`;
  });
  const more = suite.length - shown.length;
  return ["## Specs the suite already holds", ...shown, ...(more > 0 ? [`(+${more} more)`] : [])].join("\n");
}

const withCandidates = (brief: DelegationBrief): boolean => brief.candidates !== undefined && brief.candidates.length > 0;

/* The author's answer: the DelegationResult JSON, one acceptance entry per numbered criterion and one candidate entry per use case of the Change section. */
function authorReturnShape({ brief }: BriefPromptContext): string {
  const candidates = withCandidates(brief);
  return [
    "## Output contract",
    "End with ONLY JSON:",
    `{"delegationId":"${brief.delegationId}","runId":"${brief.runId}","status":"completed"|"completed-with-concerns"|"blocked"|"needs-lead"|"failed","summary":"...","filesChanged":[{"path":"..."}],"evidence":[],"validation":[{"id":"...","ok":true}],"acceptance":[{"criterion":1,"status":${ACCEPTANCE_STATUSES.map((st) => JSON.stringify(st)).join("|")},"note":"..."}],${candidates ? `"candidates":[{"id":"uc-...","status":${CANDIDATE_CLAIMS.map((st) => JSON.stringify(st)).join("|")},"spec":"<test title>"}],` : ""}"assumptions":[],"concerns":[],"unresolvedQuestions":[],"recommendation":"accept"|"review"|"retry"|"escalate"}`,
    "acceptance: one entry for every numbered acceptance criterion, by its number: met only when you checked it holds, unmet when your work does not satisfy it, unverified when you could not check it; [] when there are none. Only an unmet entry reports a failure — concerns are notes.",
    ...(candidates ? ["candidates: one entry for every use case of the Change section, by its id: covered when a test of yours exercises it, not-covered when none does, blocked when you could not. It is your claim; the orchestrator's own run of the spec decides."] : []),
    "This is the only closing JSON of your turn: no other verdict object (such as one with a `specs` list) comes with or after it.",
  ].join("\n");
}

/* The flow author's brief, in the order its sections have always had. */
export const AUTHOR_BRIEF_SECTIONS: readonly PromptSectionDef<BriefPromptContext>[] = [
  taskSection("## Task", ({ brief, scrub }) => [`delegationId: ${brief.delegationId}`, `runId: ${brief.runId}`, `objective: ${scrub(brief.objective)}`, `task: ${scrub(brief.task)}`]),
  section({
    id: "acceptance",
    priority: 20,
    render: ({ brief, scrub }) => ({ content: optionalList("## Acceptance criteria", brief.acceptanceCriteria.map((c, i) => `${i + 1}. ${scrub(c)}`)) }),
  }),
  section({
    id: "scope",
    priority: 30,
    render: ({ brief }) => {
      const { scope, authority } = brief;
      const writes = scope.writablePaths.length > 0;
      const content = [
        [
          "## Scope",
          `- readablePaths: ${scope.readablePaths.join(", ") || "(none)"}`,
          `- writablePaths: ${scope.writablePaths.join(", ") || "(none)"}`,
          `- allowedCommands: ${scope.allowedCommands.join(", ") || "(none)"}`,
        ].join("\n"),
        [
          "## Authority (frozen)",
          `- canModifyArchitecture: ${authority.canModifyArchitecture}`,
          `- canChangeAcceptanceCriteria: ${authority.canChangeAcceptanceCriteria}`,
          `- canExpandScope: ${authority.canExpandScope}`,
          `- canChallengeBrief: ${authority.canChallengeBrief}`,
          "Do NOT write outside writablePaths. Do NOT change acceptance criteria. Prefer needs-lead over inventing architecture.",
        ].join("\n"),
      ].join("\n\n");
      const claims: PromptClaim[] = [claim.statesContract("boundary"), ...(writes ? [claim.statesWrite()] : [])];
      return { content, claims };
    },
  }),
  section({
    id: "facts",
    priority: 40,
    render: ({ brief, scrub }) => ({ content: optionalList("## Known facts", brief.knownFacts.map((f) => `- [${f.confidence}/${f.kind}] ${scrub(f.summary)}`)) }),
  }),
  section({
    id: "harness",
    priority: 42,
    applies: (ctx) => harnessLines(ctx).length > 0,
    render: (ctx) => ({ content: ["## Harness facts", ...harnessLines(ctx)].join("\n") }),
  }),
  section({
    id: "suite",
    priority: 44,
    applies: ({ brief }) => (brief.suite?.length ?? 0) > 0,
    render: (ctx) => ({ content: suiteText(ctx) }),
  }),
  section({
    id: "pages",
    priority: 50,
    applies: ({ brief }) => Boolean(brief.pages),
    render: ({ brief }) => ({ content: ["## Pages of this flow (from the run's Context Pack)", brief.pages!].join("\n") }),
  }),
  section({
    id: "proofs",
    priority: 60,
    applies: ({ brief }) => Boolean(brief.proofs?.length),
    render: ({ brief, scrub }) => ({ content: ["## How the change reaches this flow's pages (from the run's call graph)", ...brief.proofs!.map((proof) => `- ${scrub(proof)}`)].join("\n") }),
  }),
  section({
    id: "change",
    priority: 70,
    applies: ({ brief }) => withCandidates(brief),
    render: ({ brief, scrub }) => ({ content: changeText(brief.candidates!, scrub) }),
  }),
  section({
    id: "artifacts",
    priority: 80,
    render: ({ brief }) => ({ content: optionalList("## Artifacts", brief.artifactRefs.map((a) => `- ${a.id}: ${a.path}`)) }),
  }),
  section({
    id: "validation",
    priority: 90,
    render: ({ brief, scrub }) => ({ content: optionalList("## Validation plan", brief.validationPlan.map((v) => `- ${v.id}: ${scrub(v.description)}`)) }),
  }),
  toolsSection,
  section({ id: "contract", priority: 100, render: (ctx) => ({ content: authorReturnShape(ctx), claims: [claim.statesContract("return-shape")] }) }),
];

/* The explore sidekick's answer: one exploration result for the question, capped. */
function exploreReturnShape({ brief }: BriefPromptContext): string {
  const id = questionIdOf(brief.delegationId);
  return [
    "## Output contract",
    "End with ONLY JSON:",
    `{"id":"${id}","status":"answered"|"unanswered","findings":[{"claim":"...","kind":"page"|"element"|"symbol"|"data-state","ref":"...","evidence":"..."}]}`,
    `At most ${MAX_FINDINGS} findings. A symbol ref is <repo-relative file>#<symbol>; a page or data-state ref is the site-relative path.`,
  ].join("\n");
}

/* The explore sidekick's brief: one question, read-only. */
export const EXPLORE_BRIEF_SECTIONS: readonly PromptSectionDef<BriefPromptContext>[] = [
  section({
    id: "question",
    priority: 10,
    render: ({ brief, scrub }) => ({ content: ["## Question", `id: ${questionIdOf(brief.delegationId)}`, scrub(brief.objective)].join("\n"), claims: [claim.statesContract("objective")] }),
  }),
  section({ id: "task", priority: 20, render: ({ brief, scrub }) => ({ content: ["## Task", scrub(brief.task)].join("\n") }) }),
  section({
    id: "facts",
    priority: 30,
    applies: ({ brief }) => brief.knownFacts.length > 0,
    render: ({ brief, scrub }) => ({ content: ["## Known facts", ...brief.knownFacts.map((fact) => `- [${fact.confidence}/${fact.kind}] ${scrub(fact.summary)}`)].join("\n") }),
  }),
  section({
    id: "artifacts",
    priority: 40,
    applies: ({ brief }) => brief.artifactRefs.length > 0,
    render: ({ brief }) => ({ content: ["## Artifacts", ...brief.artifactRefs.map((ref) => `- ${ref.id}: ${ref.path}`)].join("\n") }),
  }),
  section({
    id: "boundary",
    priority: 50,
    render: ({ brief }) => {
      const writes = brief.scope.writablePaths.length > 0;
      return {
        content: ["## Boundary", `- readablePaths: ${brief.scope.readablePaths.join(", ") || "(none)"}`, writes ? `- writablePaths: ${brief.scope.writablePaths.join(", ")}` : "You write no file: you only read and report."].join("\n"),
        claims: [claim.statesContract("boundary"), ...(writes ? [claim.statesWrite()] : [])],
      };
    },
  }),
  { ...toolsSection, priority: 60 },
  section({ id: "contract", priority: 100, render: (ctx) => ({ content: exploreReturnShape(ctx), claims: [claim.statesContract("return-shape")] }) }),
];
