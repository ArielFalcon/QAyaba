/*
 * The section registry of the author sidekick's delegation brief. A brief states four
 * things, each in exactly one section: the objective (what the sidekick is for), the return shape, the boundary (what it may write
 * and must not do) and the tools it holds; the prompt-contract lint holds it to that (R17) and to stating only what its turn
 * grants (R18). One tier: the static sections (the tools) open the brief, then the run's facts by priority.
 */
import { claim, countByDirectory, harnessFactLines, NOT_SHOWN, pagesDegrade, stepsDegrade, suiteEntryFile } from "@contexts/generation/application/index.ts";
import type { PromptSectionDef, SectionRender } from "@kernel/prompt-sections.ts";
import type { PromptClaim } from "@kernel/prompt-claim.ts";
import { SIDEKICK_CAPABILITY, type SidekickCapability } from "../sidekick-authoring.ts";
import { ACCEPTANCE_STATUSES } from "../acceptance-report.ts";
import type { DelegationBrief } from "../delegation-brief.ts";
import type { EvidenceRef } from "../evidence-ref.ts";
import { CANDIDATE_CLAIMS } from "../delegation-result.ts";
import { decisionText } from "@kernel/changed-decision.ts";

export const BRIEF_DECISIONS_SECTION_ID = "decisions";

/* One brief and the scrub every free-form field of it passes at this egress. */
export interface BriefPromptContext {
  brief: DelegationBrief;
  scrub(text: string): string;
}

/* What each capability the orchestrator grants lets the sidekick do, in the words the brief states it. */
const TOOL_STATEMENT: Readonly<Record<SidekickCapability, string>> = {
  [SIDEKICK_CAPABILITY.RUN_SPEC]: "run the spec you wrote",
  [SIDEKICK_CAPABILITY.AUTHBROWSER]: "read DEV through the authenticated browser (authbrowser_*); it never writes",
  [SIDEKICK_CAPABILITY.SET_GEOLOCATION]: "move the authoring location",
  [SIDEKICK_CAPABILITY.PLAYWRIGHT]: "drive a browser against DEV",
};

const section = (def: Omit<PromptSectionDef<BriefPromptContext>, "tier" | "applies"> & { applies?: PromptSectionDef<BriefPromptContext>["applies"] }): PromptSectionDef<BriefPromptContext> => ({
  tier: "task",
  applies: () => true,
  ...def,
});

/* The objective: the sidekick's identity in the run and what it is for. */
const taskSection = (heading: string, lines: (ctx: BriefPromptContext) => string[]): PromptSectionDef<BriefPromptContext> =>
  section({ id: "task", priority: 10, stability: "run", reason: "The sidekick's identity in the run and its objective (R17 objective) (9adce82f)", render: (ctx) => ({ content: [heading, ...lines(ctx)].join("\n"), claims: [claim.statesContract("objective")] }) });

const toolsSection = section({
  id: "tools",
  priority: 95, stability: "static", reason: "What the orchestrator grants and withholds this turn, derived from the grants that deny the session's tools (R18) (07d8f70b)",
  render: ({ brief }) => {
    const { granted = [], withheld = [] } = brief.grants ?? {};
    return {
      content: [
        "## Tools",
        granted.length > 0 ? "Granted by this run:" : "Granted by this run: none.",
        ...granted.map((tool) => `- ${tool}: ${TOOL_STATEMENT[tool]}`),
        ...(withheld.length > 0 ? [`Not granted: ${withheld.join(", ")}.`] : []),
      ].join("\n"),
      claims: [claim.statesContract("tools"), ...granted.map((tool) => claim.statesTool(tool))],
    };
  },
});

/* The change this flow must exercise: the use cases (how the change reaches each, the changed symbols, where the expected behavior comes from), the flow's files, the owned hunks the brief preloads in rank order and the rest by file and range. */
function changeText(brief: DelegationBrief, scrub: (text: string) => string): string {
  const candidates = brief.candidates ?? [];
  const files = brief.change?.files ?? [];
  const hunks = brief.change?.hunks ?? [];
  const references = brief.change?.references ?? [];
  return [
    "## Change this flow must exercise",
    "Expected values come from the contract or the commit's stated intent, never from what the page shows: a page that already shows the new behavior proves nothing about the change.",
    ...candidates.flatMap((candidate) => [
      `### ${candidate.id}: ${scrub(candidate.entry)} (${candidate.tier})`,
      candidate.evidence.length > 0 ? `Reached through: ${candidate.evidence.map(scrub).join(" > ")}` : "",
      candidate.symbols.length > 0 ? `Changed symbols: ${candidate.symbols.map(scrub).join("; ")}` : "",
      `Expected behavior comes from: ${candidate.expectedFrom.map((source) => `${source.kind} (${scrub(source.ref)})`).join("; ")}`,
    ].filter(Boolean)),
    ...(files.length > 0 ? ["### Changed files", ...files.map((file) => `- ${scrub(file.path)} (${file.kind}, +${file.added} -${file.removed}, ${file.origins.join(", ")})`)] : []),
    ...(hunks.length > 0
      ? ["### Changed code", ...hunks.map((hunk) => ["```diff", `${scrub(hunk.path)}:${hunk.start}-${hunk.end} (${hunk.kind}, ${hunk.candidateIds.join(", ")})`, scrub(hunk.text), "```"].join("\n"))]
      : []),
    ...(references.length > 0 ? ["### Changed code not shown (read it in the repository when you need it)", ...references.map((ref) => `- ${scrub(ref)}`)] : []),
  ].join("\n");
}

/* A fact the run holds, with where it was read and how sure the run is of it. */
const plainFacts = (brief: DelegationBrief): EvidenceRef[] => brief.knownFacts.filter((fact) => fact.kind !== "lesson");
const lessonFacts = (brief: DelegationBrief): EvidenceRef[] => brief.knownFacts.filter((fact) => fact.kind === "lesson");
const factLine = (scrub: (text: string) => string) => (fact: EvidenceRef): string => `- ${scrub(fact.summary)} (read by ${fact.source}, ${fact.confidence})`;

const harnessLines = ({ brief, scrub }: BriefPromptContext): string[] => (brief.harnessFacts ? harnessFactLines(brief.harnessFacts, brief.specRelDir ?? "e2e", scrub) : []);

const SUITE_HEADING = "## Specs the suite already holds";

/* Every spec the suite holds, one scrubbed line each. The lines come from the grounding, which already sanitizes and bounds them (suite-listing.ts). */
function suiteRender({ brief, scrub }: BriefPromptContext): SectionRender {
  const lines = (brief.suite ?? []).map((line) => scrub(line).replace(/\s+/g, " ").trim());
  const files = lines.map(suiteEntryFile);
  /* Over the window: each spec by its file, then the files counted by directory. */
  const byFile = [SUITE_HEADING, `What each spec checks is ${NOT_SHOWN}; the specs by file:`, ...files.map((file) => `- ${file}`)].join("\n");
  const byDirectory = [SUITE_HEADING, `The ${files.length} spec(s) are ${NOT_SHOWN}; by directory:`, ...countByDirectory(files)].join("\n");
  return {
    content: [SUITE_HEADING, ...lines.map((line) => `- ${line}`)].join("\n"),
    /* The listing keeps the author from duplicating a spec: the first thing to give way, before the pages it writes from. */
    shedAs: "volatile",
    degrade: stepsDegrade([{ content: byFile, items: lines.length }, { content: byDirectory, items: lines.length }]),
  };
}

const withCandidates = (brief: DelegationBrief): boolean => brief.candidates !== undefined && brief.candidates.length > 0;

/* The author's answer: the DelegationResult JSON, one acceptance entry per numbered criterion and one candidate entry per use case of the Change section. */
function authorReturnShape({ brief }: BriefPromptContext): string {
  const candidates = withCandidates(brief);
  return [
    "## Output contract",
    "End with ONLY JSON:",
    `{"delegationId":"${brief.delegationId}","runId":"${brief.runId}","status":"completed"|"completed-with-concerns"|"blocked"|"needs-lead"|"failed","summary":"...","filesChanged":[{"path":"..."}],"acceptance":[{"criterion":1,"status":${ACCEPTANCE_STATUSES.map((st) => JSON.stringify(st)).join("|")},"note":"..."}],${candidates ? `"candidates":[{"id":"uc-...","status":${CANDIDATE_CLAIMS.map((st) => JSON.stringify(st)).join("|")},"spec":"<test title>"}],` : ""}"concerns":[],"unresolvedQuestions":[]}`,
    "acceptance: one entry for every numbered acceptance criterion, by its number: met only when you checked it holds, unmet when your work does not satisfy it, unverified when you could not check it; [] when there are none. Only an unmet entry reports a failure — concerns are notes.",
    "An unmet that DEV's state causes (DEV cannot be brought to the state the criterion needs, as pages you read in this turn show) takes `\"cause\":\"dev-state\",\"pages\":[\"/path\"]` in its entry. The orchestrator checks the pages against what its own browser and run_spec calls saw you read; an unmet without them, or that it cannot confirm, blocks the flow.",
    ...(candidates ? ["candidates: one entry for every use case of the Change section, by its id: covered when a test of yours exercises it, not-covered when none does, blocked when you could not. It is your claim; the orchestrator's own run of the spec decides."] : []),
    "This is the only closing JSON of your turn: no other verdict object (such as one with a `specs` list) comes with or after it.",
  ].join("\n");
}

/* The flow author's brief: the tools its turn grants, then its facts in priority order, the return shape last. */
export const AUTHOR_BRIEF_SECTIONS: readonly PromptSectionDef<BriefPromptContext>[] = [
  taskSection("## Task", ({ brief, scrub }) => [`delegationId: ${brief.delegationId}`, `runId: ${brief.runId}`, `objective: ${scrub(brief.objective)}`, `task: ${scrub(brief.task)}`]),
  section({
    id: "acceptance",
    priority: 20, stability: "run", reason: "Numbered criteria the author answers with one acceptance entry each (9adce82f)",
    applies: ({ brief }) => brief.acceptanceCriteria.length > 0,
    render: ({ brief, scrub }) => ({ content: ["## Acceptance criteria", ...brief.acceptanceCriteria.map((c, i) => `${i + 1}. ${scrub(c)}`)].join("\n") }),
  }),
  section({
    id: "scope",
    priority: 30, stability: "run", reason: "The boundary: what it may read and write, and its frozen authority (R17 boundary) (9adce82f)",
    render: ({ brief }) => {
      const { scope, authority } = brief;
      const writes = scope.writablePaths.length > 0;
      const content = [
        [
          "## Scope",
          `- readablePaths: ${scope.readablePaths.join(", ") || "(none)"}`,
          `- writablePaths: ${scope.writablePaths.join(", ") || "(none)"}`,
          ...(scope.allowedCommands.length > 0 ? [`- allowedCommands: ${scope.allowedCommands.join(", ")}`] : []),
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
    priority: 40, stability: "run", reason: "Facts the run already holds, with source and confidence, so the sidekick does not re-derive them (9adce82f)",
    applies: ({ brief }) => plainFacts(brief).length > 0,
    render: ({ brief, scrub }) => ({ content: ["## Known facts", ...plainFacts(brief).map(factLine(scrub))].join("\n") }),
  }),
  section({
    id: "lessons",
    priority: 41, stability: "run", reason: "What earlier runs read of DEV's data on this flow's pages, stated apart from the facts of this run and given up to the window as a count (RFC-0013)",
    applies: ({ brief }) => lessonFacts(brief).length > 0,
    render: ({ brief, scrub }) => {
      const lines = lessonFacts(brief).map(factLine(scrub));
      const wrap = (body: string[]): string => ["## Lessons from earlier runs", ...body].join("\n");
      return { content: wrap(lines), degrade: stepsDegrade([{ content: wrap([`- ${lines.length} lesson(s) from earlier runs on this flow's pages ${NOT_SHOWN}`]), items: lines.length }]) };
    },
  }),
  section({
    id: "harness",
    priority: 42, stability: "run", reason: "Authors read the fixtures and config files the run already held (f67ef0c3)",
    applies: (ctx) => harnessLines(ctx).length > 0,
    render: (ctx) => ({ content: ["## Harness facts", ...harnessLines(ctx)].join("\n") }),
  }),
  section({
    id: "suite",
    priority: 44, stability: "run", reason: "The specs the suite holds, so a flow author does not duplicate one (f67ef0c3)",
    applies: ({ brief }) => (brief.suite?.length ?? 0) > 0,
    render: suiteRender,
  }),
  section({
    /* The flow's slice of the run's Context Pack, under the id the prompt-contract lint knows that artifact by. */
    id: "context-pack",
    priority: 50, stability: "run", reason: "The flow's pages from the run's Context Pack, so selectors are transcribed (fee9fc05)",
    applies: ({ brief }) => Boolean(brief.pages),
    render: ({ brief }) => {
      const wrap = (pages: string): string => ["## Pages of this flow (from the run's Context Pack)", pages].join("\n");
      /* Whole pages; over the window the last page gives way first, named by its route, then the requests those pages made, last fact first. */
      return { content: wrap(brief.pages!), degrade: pagesDegrade({ dom: brief.pages!, wrap }) };
    },
  }),
  section({
    id: "change",
    priority: 70, stability: "run", reason: "Suites asserted render smoke: the author gets the use cases and the slice of the change it must exercise (78fc29b1)",
    applies: ({ brief }) => withCandidates(brief),
    render: ({ brief, scrub }) => ({ content: changeText(brief, scrub) }),
  }),
  section({
    /* The static listing's decisions in the flow's owned hunks: the cases a suite that only renders the page would leave untested. */
    id: BRIEF_DECISIONS_SECTION_ID,
    priority: 72, stability: "run", reason: "The arms of the flow's changed decisions: the cases a render-only suite leaves untested (3a643989)",
    applies: ({ brief }) => withCandidates(brief) && (brief.change?.decisions?.length ?? 0) > 0,
    render: ({ brief, scrub }) => ({
      content: [
        "## Decisions in this flow's changed code",
        "Each arm is a case of the change: write a test for every arm the page can be brought to through the UI.",
        ...brief.change!.decisions!.map((decision) => `- ${scrub(decisionText(decision))}`),
      ].join("\n"),
    }),
  }),
  section({
    id: "artifacts",
    priority: 80, stability: "run", reason: "Artifacts the lead hands the sidekick by path (9adce82f)",
    applies: ({ brief }) => brief.artifactRefs.length > 0,
    render: ({ brief }) => ({ content: ["## Artifacts", ...brief.artifactRefs.map((a) => `- ${a.id}: ${a.path}`)].join("\n") }),
  }),
  toolsSection,
  section({ id: "contract", priority: 100, stability: "run", reason: "The DelegationResult JSON the author closes with, one closing object (R17 return shape) (2d319787)", render: (ctx) => ({ content: authorReturnShape(ctx), claims: [claim.statesContract("return-shape")] }) }),
];
