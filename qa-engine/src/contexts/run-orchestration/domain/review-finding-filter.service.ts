/*
 * The reviewer's findings, judged by the orchestrator instead of by the model's own severity. A finding
 * may block only when it cites evidence the orchestrator can check: a spec's contract clause, an
 * execution the run performed, or a DOM fact. Anything else is advisory telemetry — never sent to the
 * generator, never a gate. A finding that names an arm of the changed code no test ran is a missing case:
 * kept when the run's measurement lists that arm, recorded and shown, never a requirement or a gate.
 * A citation and the run's scope are compared in one canonical form (the suite-relative spec path), so the
 * way an agent spells a file never decides whether its finding counts.
 * Pure: no I/O. See docs and the D slice of the change spec.
 */

import { resolveCitedSpec, resolveSpecReference } from "@kernel/spec-path.ts";

export type ReviewCitationKind = "contract" | "execution" | "dom" | "arm";

/** What a finding claims to rest on. The ref names the spec (and, for a contract, its clause), or for an arm its `<file>:<line>`. */
export interface ReviewCitation {
  readonly kind: ReviewCitationKind;
  readonly ref: string;
}

export interface CitedFinding {
  readonly text: string;
  /** The reviewer's own severity. The orchestrator only honors it once the citation is verified. */
  readonly severity: "blocking" | "advisory";
  readonly citation?: ReviewCitation;
}

/** What the orchestrator knows about this run, the only facts that can verify a citation. */
export interface ReviewScope {
  /** The spec directory under the mirror: the prefix a citation may carry in front of the suite-relative path. */
  readonly specRelDir: string;
  /** Spec files this run delivered: the diff's own scope. Any spelling of a path; compared in canonical form. */
  readonly inScopeSpecs: ReadonlySet<string>;
  /** Spec files whose cases this run actually executed. Any spelling of a path; compared in canonical form. */
  readonly executedSpecs: ReadonlySet<string>;
}

/** Why a finding can never block: it cites nothing, an arm nobody checked, a reference that names no spec the suite can hold, a spec outside this run's scope, or an execution this run did not perform. */
export type DropReason = "uncited" | "arm" | "unresolved" | "out-of-scope" | "not-executed";

export interface FilteredReviewFindings {
  /** Verified, reviewer-blocking findings: the only ones that reach the generator or fail the gate. */
  readonly blocking: string[];
  /** Verified-but-advisory, plus every DOM-only finding: recorded, never a requirement. */
  readonly advisory: string[];
  /** No citation, an unverifiable one, or a citation outside this run's scope. */
  readonly dropped: string[];
  /** Per reason, the dropped findings the reviewer had marked blocking: a rejection that vanishes here is not a judgment the run made. */
  readonly droppedBlocking: Partial<Record<DropReason, number>>;
}

/** The suite-relative spec a citation's reference names, or undefined when it names none the suite can hold. A contract ref is `<spec>#<clause>`; the spec may carry the spec directory. */
export function citedSpec(ref: string, specRelDir: string): string | undefined {
  return resolveCitedSpec(ref, specRelDir);
}

/** A set of spec files in the canonical suite-relative form; what resolves to no spec is left out. */
function canonicalSpecs(files: ReadonlySet<string>, specRelDir: string): Set<string> {
  const canonical = new Set<string>();
  for (const file of files) {
    const spec = resolveSpecReference(file, specRelDir);
    if (spec !== undefined) canonical.add(spec);
  }
  return canonical;
}

/**
 * Sort findings by what the orchestrator can prove. `contract` and `execution` citations must name a
 * spec this run delivered (and, for an execution, one it executed); a `dom` citation is always
 * advisory; no citation is dropped.
 */
export function filterReviewFindings(
  findings: readonly CitedFinding[],
  scope: ReviewScope,
): FilteredReviewFindings {
  const blocking: string[] = [];
  const advisory: string[] = [];
  const dropped: string[] = [];
  const droppedBlocking: Partial<Record<DropReason, number>> = {};
  const inScope = canonicalSpecs(scope.inScopeSpecs, scope.specRelDir);
  const executed = canonicalSpecs(scope.executedSpecs, scope.specRelDir);

  const drop = (finding: CitedFinding, reason: DropReason): void => {
    dropped.push(finding.text);
    if (finding.severity === "blocking") droppedBlocking[reason] = (droppedBlocking[reason] ?? 0) + 1;
  };

  for (const finding of findings) {
    const citation = finding.citation;
    if (!citation) {
      drop(finding, "uncited");
      continue;
    }
    if (citation.kind === "arm") {
      /* Missing cases are taken out before this filter: an arm here was never checked against the run's list. */
      drop(finding, "arm");
      continue;
    }
    if (citation.kind === "dom") {
      /* A DOM fact can show a selector is wrong; it cannot prove what the test is for. */
      advisory.push(finding.text);
      continue;
    }
    const spec = citedSpec(citation.ref, scope.specRelDir);
    if (spec === undefined) {
      drop(finding, "unresolved");
      continue;
    }
    if (!inScope.has(spec)) {
      drop(finding, "out-of-scope");
      continue;
    }
    if (citation.kind === "execution" && !executed.has(spec)) {
      drop(finding, "not-executed");
      continue;
    }
    if (finding.severity === "blocking") blocking.push(finding.text);
    else advisory.push(finding.text);
  }

  return { blocking, advisory, dropped, droppedBlocking };
}

/**
 * The findings that cite an arm of the changed code no test ran (`<file>:<line>`, as the run's measurement lists them in
 * `untakenArms`): one whose arm is listed is a missing case, whatever severity the reviewer gave it; one whose arm is not
 * listed is dropped. Every other finding is returned as it came, for the evidence filter.
 */
export function takeMissingCases<T extends CitedFinding>(findings: readonly T[], untakenArms: ReadonlySet<string>): { missingCases: string[]; dropped: string[]; rest: T[] } {
  const missingCases: string[] = [];
  const dropped: string[] = [];
  const rest: T[] = [];
  for (const finding of findings) {
    if (finding.citation?.kind !== "arm") rest.push(finding);
    else if (untakenArms.has(finding.citation.ref.trim())) missingCases.push(finding.text);
    else dropped.push(finding.text);
  }
  return { missingCases, dropped, rest };
}
