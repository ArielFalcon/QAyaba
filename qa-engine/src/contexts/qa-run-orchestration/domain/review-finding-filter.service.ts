/*
 * The reviewer's findings, judged by the orchestrator instead of by the model's own severity. A finding
 * may block only when it cites evidence the orchestrator can check: a spec's contract clause, an
 * execution the run performed, or a DOM fact. Anything else is advisory telemetry — never sent to the
 * generator, never a gate. Pure: no I/O. See docs and the D slice of the change spec.
 */

export type ReviewCitationKind = "contract" | "execution" | "dom";

/** What a finding claims to rest on. The ref names the spec (and, for a contract, its clause). */
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
  /** Spec files this run delivered (suite-relative): the diff's own scope. */
  readonly inScopeSpecs: ReadonlySet<string>;
  /** Spec files whose cases this run actually executed. */
  readonly executedSpecs: ReadonlySet<string>;
}

export interface FilteredReviewFindings {
  /** Verified, reviewer-blocking findings: the only ones that reach the generator or fail the gate. */
  readonly blocking: string[];
  /** Verified-but-advisory, plus every DOM-only finding: recorded, never a requirement. */
  readonly advisory: string[];
  /** No citation, an unverifiable one, or a citation outside this run's scope. */
  readonly dropped: string[];
}

const SPEC_PATH = /([\w./-]+\.spec\.ts)/;

/** The spec a citation names, or undefined when it names none. A contract ref is `<spec>#<clause>`. */
/* The spec a citation's reference names, when it names one. */
export function citedSpec(ref: string): string | undefined {
  return SPEC_PATH.exec(ref)?.[1];
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

  for (const finding of findings) {
    const citation = finding.citation;
    if (!citation) {
      dropped.push(finding.text);
      continue;
    }
    if (citation.kind === "dom") {
      /* A DOM fact can show a selector is wrong; it cannot prove what the test is for. */
      advisory.push(finding.text);
      continue;
    }
    const spec = citedSpec(citation.ref);
    const verified =
      spec !== undefined &&
      scope.inScopeSpecs.has(spec) &&
      (citation.kind !== "execution" || scope.executedSpecs.has(spec));
    if (!verified) {
      dropped.push(finding.text);
      continue;
    }
    if (finding.severity === "blocking") blocking.push(finding.text);
    else advisory.push(finding.text);
  }

  return { blocking, advisory, dropped };
}
