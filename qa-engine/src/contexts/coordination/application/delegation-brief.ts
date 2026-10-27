import type { HarnessFacts } from "@kernel/grounding.ts";
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import type { AcceptanceCriterion } from "./coordination-context.ts";
import type { EvidenceRef } from "./evidence-ref.ts";
import { SIDEKICK_AUTHORITY, type SidekickAuthority } from "./authority.ts";
import type { FileKind } from "@kernel/change-map.ts";

export interface DelegationScope {
  readonly readablePaths: readonly string[];
  readonly writablePaths: readonly string[];
  readonly allowedCommands: readonly string[];
}

export interface ArtifactReference {
  readonly id: string;
  readonly path: string;
}

/* Where a candidate's expected behavior comes from: the declared contract operation, the commit's stated intent, or the diff itself. */
export interface ExpectedSource {
  readonly kind: "contract" | "commit-message" | "diff";
  readonly ref: string;
}

/* A use case of the change a flow must exercise: how the change reaches it, the changed symbols with their ranges, and where its expected behavior comes from. Its changed code is the brief's `change`. */
export interface BriefCandidate {
  readonly id: string;
  /* The entry point: `page /route` or `VERB /path`. */
  readonly entry: string;
  readonly tier: string;
  /* The reach path, from the change to the entry point. */
  readonly evidence: readonly string[];
  readonly symbols: readonly string[];
  readonly expectedFrom: readonly ExpectedSource[];
}

/* How a file came to be one of the flow's: the context map links it to a page, the call graph reaches the page from it, or it is a hub's code the page shares with others. */
export type ChangeOrigin = "map-link" | "graph" | "shared";

export interface BriefChangeFile {
  path: string;
  kind: FileKind;
  added: number;
  removed: number;
  origins: ChangeOrigin[];
}

/* An owned hunk as the brief preloads it. */
export interface BriefHunk {
  path: string;
  start: number;
  end: number;
  added: number;
  removed: number;
  kind: FileKind;
  /* Whether the hunk is code of a declared language: the last owned content to be referenced instead of preloaded. */
  code: boolean;
  candidateIds: string[];
  /* The hunk's header and lines. */
  text: string;
}

export interface BriefChange {
  files: BriefChangeFile[];
  /* Preloaded, in rank order. */
  hunks: BriefHunk[];
  /* What is not preloaded, one line each: `path:start-end (+a -r, kind, why)`. */
  references: string[];
}

export interface DelegationBrief {
  readonly delegationId: string;
  readonly runId: string;
  readonly objective: string;
  readonly task: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly scope: DelegationScope;
  readonly knownFacts: readonly EvidenceRef[];
  readonly artifactRefs: readonly ArtifactReference[];
  readonly authority: SidekickAuthority;
  /* The Live DOM of the flow's pages, cut from the run's Context Pack. */
  readonly pages?: string;
  /* The use cases the flow must exercise: ids to report on, how the change reaches them, their symbols and where the expected behavior comes from. */
  readonly candidates?: readonly BriefCandidate[];
  /* The flow's slice of the change: its files, the owned hunks the brief preloads and the rest by file and range. */
  readonly change?: BriefChange;
  /* What the suite's harness declares, as the run grounded it (facts, never source). */
  readonly harnessFacts?: HarnessFacts;
  /* The suite directory the facts name files under, relative to the repository. */
  readonly specRelDir?: string;
  /* The specs the suite holds, one line each (path, flow, objective), never source. */
  readonly suite?: readonly string[];
  /* The tool families the turn grants the sidekick, as the kind table names them (`read`, `write`, `run_spec`, `authbrowser`, `codegraph`, ...). Absent: what the scope alone grants (see `briefTools`). */
  readonly tools?: readonly string[];
}

/* The tools a brief states: those the turn named, or the ones its scope grants by itself (read where something is readable, write where something is writable). */
export function briefTools(brief: Pick<DelegationBrief, "scope" | "tools">): readonly string[] {
  if (brief.tools) return brief.tools;
  return [...(brief.scope.readablePaths.length > 0 ? ["read"] : []), ...(brief.scope.writablePaths.length > 0 ? ["write"] : [])];
}

export function createDelegationBrief(input: {
  /* Where every free-form field is redacted before it enters the brief. */
  redaction: RedactionPort;
  delegationId: string;
  runId: string;
  objective: string;
  task: string;
  acceptanceCriteria?: readonly AcceptanceCriterion[];
  scope: DelegationScope;
  knownFacts?: readonly EvidenceRef[];
  artifactRefs?: readonly ArtifactReference[];
  pages?: string;
  candidates?: readonly BriefCandidate[];
  change?: BriefChange;
  harnessFacts?: HarnessFacts;
  specRelDir?: string;
  suite?: readonly string[];
  tools?: readonly string[];
}): DelegationBrief {
  const scrub = (text: string): string => input.redaction.redact(text);
  if (!input.delegationId) throw new Error("DelegationBrief requires delegationId");
  if (!input.runId) throw new Error("DelegationBrief requires runId");
  return {
    delegationId: input.delegationId,
    runId: input.runId,
    objective: scrub(input.objective),
    task: scrub(input.task),
    acceptanceCriteria: (input.acceptanceCriteria ?? []).map(scrub),
    scope: input.scope,
    knownFacts: (input.knownFacts ?? []).map((fact) => ({ ...fact, summary: scrub(fact.summary) })),
    artifactRefs: input.artifactRefs ?? [],
    authority: SIDEKICK_AUTHORITY,
    ...(input.tools ? { tools: [...input.tools] } : {}),
    ...(input.pages ? { pages: scrub(input.pages) } : {}),
    ...(input.harnessFacts ? { harnessFacts: input.harnessFacts, ...(input.specRelDir ? { specRelDir: input.specRelDir } : {}) } : {}),
    ...(input.suite?.length ? { suite: input.suite.map(scrub) } : {}),
    ...(input.candidates?.length
      ? {
          candidates: input.candidates.map((c) => ({
            id: c.id,
            entry: scrub(c.entry),
            tier: c.tier,
            evidence: c.evidence.map(scrub),
            symbols: c.symbols.map(scrub),
            expectedFrom: c.expectedFrom.map((source) => ({ kind: source.kind, ref: scrub(source.ref) })),
          })),
        }
      : {}),
    ...(input.change ? { change: scrubChange(input.change, scrub) } : {}),
  };
}

function scrubChange(change: BriefChange, scrub: (text: string) => string): BriefChange {
  return {
    files: change.files.map((file) => ({ ...file, path: scrub(file.path), origins: [...file.origins] })),
    hunks: change.hunks.map((hunk) => ({ ...hunk, path: scrub(hunk.path), candidateIds: [...hunk.candidateIds], text: scrub(hunk.text) })),
    references: change.references.map(scrub),
  };
}
