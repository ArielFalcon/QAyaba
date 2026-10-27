/*
 * The maintenance flow: the one flow the orchestrator opens for findings a correction turn left with no flow because the spec they
 * name belongs to none of the plan's flows (a static-gate error or a failing case in a spec the suite already held). It is an ordinary
 * flow, authored by a fresh sidekick on the spec it names, and the only path it may write is that spec. Pure: no clock, no file,
 * no model; the spec path is confined here, before anything is opened.
 */

import { resolveSpecReference } from "@kernel/spec-path.ts";
import { SIDEKICK_KIND } from "./sidekick-kinds.ts";
import type { AdmittedFlow } from "./lead-plan.ts";
import { sameFile, type CorrectionFinding } from "./lead-correction.ts";
import { entryKey } from "@kernel/change-reach.ts";
import { candidatePagesOf, type UseCaseCandidate } from "@kernel/use-case-candidate.ts";

/* A path ending in `.spec.ts` inside a text: it ends where the characters of a path do. */
const SPEC_IN_TEXT = /[A-Za-z0-9._/-]+\.spec\.ts(?![A-Za-z0-9_])/g;
const MAX_ID_CHARS = 60;

/* The spec a path names, relative to the spec directory, or undefined when it is not a spec file inside it (absolute, climbing, hidden directories such as the probe directory, any other extension). */
export function confinedSpecFile(raw: string, specRelDir: string): string | undefined {
  return resolveSpecReference(raw, specRelDir);
}

/* The one spec a finding names: the file it cites, or failing that the one spec its text names. Undefined when it names none, several, or one outside the spec directory. */
export function specNamedBy(finding: CorrectionFinding, specRelDir: string): string | undefined {
  if (finding.spec) return confinedSpecFile(finding.spec, specRelDir);
  const named = [...finding.text.matchAll(SPEC_IN_TEXT)].map((m) => confinedSpecFile(m[0], specRelDir));
  if (named.length === 0 || named.some((spec) => spec === undefined)) return undefined;
  const distinct = new Set(named);
  return distinct.size === 1 ? named[0] : undefined;
}

/* The id of the maintenance flow of a spec, distinct from the ids already taken. */
export function maintenanceFlowId(specFile: string, taken: ReadonlySet<string>): string {
  const slug = specFile.replace(/\.spec\.ts$/, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_ID_CHARS);
  const base = `maint-${slug || "spec"}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

export interface MaintenanceFlowInput {
  id: string;
  specFile: string;
  specRelDir: string;
  /* The texts of the findings the flow is to correct, and what the sidekick is told they are. */
  findings: readonly string[];
  preamble: string;
  routes: readonly string[];
  candidates: readonly string[];
  /* The budget and tool shares of a flow of the plan: a maintenance flow takes the same. */
  share: Pick<AdmittedFlow, "runSpecCalls" | "runSpecDevWrites" | "browserCalls">;
  budgetMs: number;
}

export function maintenanceFlowOf(input: MaintenanceFlowInput): AdmittedFlow {
  return {
    id: input.id,
    kind: SIDEKICK_KIND.AUTHOR,
    objective: `Keep ${input.specFile} correct: the orchestrator's checks raised findings on it that no flow of this run's plan owns.`,
    acceptance: ["Every finding is corrected in this spec without weakening an assertion."],
    routes: [...input.routes],
    candidates: [...input.candidates],
    specFile: input.specFile,
    writablePaths: [`${input.specRelDir.replace(/\/+$/, "")}/${input.specFile}`],
    budgetMs: input.budgetMs,
    runSpecCalls: input.share.runSpecCalls,
    runSpecDevWrites: input.share.runSpecDevWrites,
    browserCalls: input.share.browserCalls,
    maintenance: { findings: [...input.findings], preamble: input.preamble },
  };
}

/*
 * The use case a finding about a changed source file belongs to when no flow of the pass covers it: the first candidate, in the
 * order the change derived them, one of whose seeds is that file. Undefined when the finding names no file, the file seeds no
 * candidate, or a flow already covers every candidate it seeds (that flow owns the finding, not a new one).
 */
export function uncoveredCandidateOf(finding: CorrectionFinding, candidates: readonly UseCaseCandidate[], covered: (candidate: UseCaseCandidate) => boolean): UseCaseCandidate | undefined {
  if (finding.file === undefined) return undefined;
  return candidates.find((candidate) => candidate.seeds.some((seed) => sameFile(seed.file, finding.file!)) && !covered(candidate));
}

/* Whether the finding names a changed file that seeds no use case of the change: no flow can own it and none can be opened for it. */
export function seedsNoCandidate(finding: CorrectionFinding, candidates: readonly UseCaseCandidate[]): boolean {
  return finding.file !== undefined && !candidates.some((candidate) => candidate.seeds.some((seed) => sameFile(seed.file, finding.file!)));
}

/* The id of the flow opened for an uncovered use case, distinct from the ids already taken. */
export function candidateFlowId(candidate: UseCaseCandidate, taken: ReadonlySet<string>): string {
  const slug = candidate.id.replace(/^uc-/, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_ID_CHARS);
  const base = `cand-${slug || "case"}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

export interface CandidateFlowInput {
  id: string;
  candidate: UseCaseCandidate;
  /* The spec file, relative to the spec directory, that the flow's id names; confined here before anything is opened. */
  specFile: string;
  specRelDir: string;
  findings: readonly string[];
  preamble: string;
  share: MaintenanceFlowInput["share"];
  budgetMs: number;
}

/* The flow the orchestrator opens for a use case the plan did not cover: a new spec, written by a fresh sidekick, whose only writable path is that spec. */
export function candidateFlowOf(input: CandidateFlowInput): AdmittedFlow | undefined {
  const specFile = confinedSpecFile(input.specFile, input.specRelDir);
  if (specFile === undefined) return undefined;
  return {
    id: input.id,
    kind: SIDEKICK_KIND.AUTHOR,
    objective: `Exercise the changed code of use case ${input.candidate.id} (${entryKey(input.candidate.entry)}): the run measured changed lines of it that no test of the plan ran.`,
    acceptance: ["Each finding is exercised by a test that asserts the outcome the change decides, through the pages of the use case."],
    routes: candidatePagesOf(input.candidate),
    candidates: [input.candidate.id],
    specFile,
    writablePaths: [`${input.specRelDir.replace(/\/+$/, "")}/${specFile}`],
    budgetMs: input.budgetMs,
    runSpecCalls: input.share.runSpecCalls,
    runSpecDevWrites: input.share.runSpecDevWrites,
    browserCalls: input.share.browserCalls,
    maintenance: { findings: [...input.findings], preamble: input.preamble, newSpec: true },
  };
}
