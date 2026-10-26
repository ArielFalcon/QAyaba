/* Fail-closed on an unparseable verdict. Reviewer path forwards blockingCount + parsed so a parse miss is not treated as a rejection. */
import { sep } from "node:path";
import { scanSpecTree } from "../../../shared-infrastructure/spec-path-confinement.ts";
import type { VerdictParserPort } from "../application/ports/verdict-parser.port.ts";
import type { GeneratorDeliverable, ReviewJudgment } from "../domain/manifest-repository.ts";
import type { SpecMeta } from "@kernel/qa-case.ts";
import { GENERATION_NOTE_MAX_CHARS } from "../domain/generation-end.ts";
import { sanitizeText } from "./sanitize-text.ts";
import { boundReviewCorrections, boundReviewRationale, boundReviewText, reviewAnswerIsOversized, REVIEW_CORRECTION_MAX_CHARS, REVIEW_CORRECTIONS_MAX, REVIEW_RATIONALE_MAX_CHARS, REVIEW_RESPONSE_MAX_CHARS } from "../domain/review-output.ts";
import type { NoopKind } from "@kernel/noop-kind.ts";

/* Redacted at the earliest point, then cut to the note bound: the reason and the output tail end up persisted on the run, where no later stage redacts them. The reason keeps its start, the output keeps its end. */
function forNote(text: string, keep: "start" | "end"): string {
  const redacted = sanitizeText(text, "issue").text;
  return (keep === "start" ? redacted.slice(0, GENERATION_NOTE_MAX_CHARS) : redacted.slice(-GENERATION_NOTE_MAX_CHARS)).trim();
/* mutation-scope:begin parser-region */
}

/* Every *.spec.ts under specDir as a suite-relative, "/"-separated path — installed packages and dot-directories excluded, as Playwright excludes them. The suite is a directory the agent writes into, so it is walked by the one walk of the specs (spec-path-confinement): no link followed and no more entries looked at than its cap, which a caller that must not miss a spec cannot rely on and one that resolves a name can: what was not walked is not listed. */
export function listSuiteSpecFiles(specDir: string, maxEntries?: number): string[] {
/* mutation-scope:end parser-region */
  return scanSpecTree(specDir, maxEntries).specs.map((path) => path.split(sep).join("/"));
}

/* A reported spec as its suite-relative path: a bare file name that is not itself a suite path becomes the one suite spec with that name. A path, an unknown name or a name several specs share is kept as reported. */
function suitePath(reported: string, suite: () => readonly string[]): string {
  if (reported.includes("/") || reported.includes("\\")) return reported;
  const specs = suite();
  if (specs.includes(reported)) return reported;
  const named = specs.filter((path) => path.endsWith(`/${reported}`));
  return named.length === 1 ? named[0]! : reported;
}

interface ParsedVerdict {
  approved?: boolean;
  parsed: boolean;
  specs?: string[];
  note?: string;
  /* The reason the generator gave for writing nothing; approved is never a no-op signal. */
  noopReason?: string;
  /* The kind the no-op names, `unspecified` when it names none. */
  noopKind?: NoopKind;
  /* The plan the verdict carries, forwarded untouched: it is the orchestrator's admission that judges it. */
  plan?: Record<string, unknown>;
  /* The generator's typed test-correct claim, forwarded after sanitizing/bounding its reason. */
  testCorrect?: { cause: "env" | "app"; reason: string };
  /* The findings the generator disputes, forwarded so the run can check each one's basis. */
  rebuttals?: { finding: string; basis: "execution" | "contract"; ref: string; reason: string }[];
  /* specMetas drives the deterministic disk-reconciled manifest upsert; parsed (above) is the #1 fail-closed invariant. Both REQUIRED here so parseGenerator can forward them — dropping them would make the use-case misclassify a parse miss and lose the manifest-upsert signal. */
  specMetas?: SpecMeta[];
}
interface ParsedReviewerVerdict {
  approved: boolean;
  corrections: string[];
  rationale?: string;
  blockingCount?: number;
  parsed?: boolean;
  valid: boolean;
  issues: string[];
  /* The effective severity of each correction, in order, when the parser can tell them apart. */
  correctionSeverities?: ("blocking" | "advisory")[];
  /* The evidence each correction cites, in order; a hole means that entry cited none. */
  citations?: ({ kind: "contract" | "execution" | "dom"; ref: string } | undefined)[];
}

export interface VerdictParsers {
  parseVerdict(text: string): ParsedVerdict;
  parseReviewerVerdict(text: string): ParsedReviewerVerdict;
}

export class VerdictParserAdapter implements VerdictParserPort {
  constructor(
    private readonly p: VerdictParsers,
    private readonly listSuiteSpecs: (specDir: string) => readonly string[] = listSuiteSpecFiles,
  ) {}

  parseGenerator(text: string, specDir?: string): GeneratorDeliverable {
    const v = this.p.parseVerdict(text);
    /* The suite is listed at most once, and only when a bare name needs resolving. */
    let suite: readonly string[] | undefined;
    const suiteSpecs = (): readonly string[] => (suite ??= specDir === undefined ? [] : this.listSuiteSpecs(specDir));
    const resolve = (reported: string): string => suitePath(reported, suiteSpecs);
    /* specs ?? [] is the fail-closed default (a parse miss leaves specs undefined → never undefined out). parsed forwarded always (the #1 invariant the use-case branches on); specMetas only when present (drives the disk-reconciled manifest upsert — "disk over the agent's word"). */
    const noopReason = v.noopReason ? forNote(v.noopReason, "start") : "";
    const outputTail = forNote(text, "end");
    const testCorrectReason = v.testCorrect ? forNote(v.testCorrect.reason, "start") : "";
    /* A rebuttal reaches the run as evidence coordinates only: each text is redacted and bounded, and an entry that loses its coordinates on the way is dropped — it could withdraw nothing anyway. */
    const bounded = (v.rebuttals ?? [])
      .map((rebuttal) => ({
        finding: boundReviewText(sanitizeText(rebuttal.finding, "issue").text, REVIEW_CORRECTION_MAX_CHARS),
        basis: rebuttal.basis,
        ref: boundReviewText(sanitizeText(rebuttal.ref, "issue").text, REVIEW_CORRECTION_MAX_CHARS),
        reason: boundReviewText(sanitizeText(rebuttal.reason, "issue").text, REVIEW_CORRECTION_MAX_CHARS),
      }))
      .filter((rebuttal) => rebuttal.finding !== "" && rebuttal.ref !== "" && rebuttal.reason !== "")
      .slice(0, REVIEW_CORRECTIONS_MAX);
    return {
      specs: (v.specs ?? []).map(resolve),
      ...(v.note ? { note: v.note } : {}),
      ...(noopReason ? { noopReason, ...(v.noopKind ? { noopKind: v.noopKind } : {}) } : {}),
      ...(outputTail ? { outputTail } : {}),
      ...(v.plan ? { plan: v.plan } : {}),
      ...(v.testCorrect && testCorrectReason ? { testCorrect: { cause: v.testCorrect.cause, reason: testCorrectReason } } : {}),
      ...(bounded.length ? { rebuttals: bounded } : {}),
      ...(v.specMetas ? { specMetas: v.specMetas.map((meta) => ({ ...meta, file: resolve(meta.file) })) } : {}),
      parsed: v.parsed,
    };
  }

  parseReview(text: string): ReviewJudgment {
    const r = this.p.parseReviewerVerdict(text);
    /*
     * The verdict is the JSON; everything around it is prose the record does not need. A reviewer
     * that answers with a page of analysis still yields the same small verdict, and the caps make
     * the answer's size independent of how much the model wrote.
     */
    if (reviewAnswerIsOversized(text)) {
      console.warn(
        `[qa] WARNING: the reviewer answered ${text.length} chars (contract: ${REVIEW_RESPONSE_MAX_CHARS}) — keeping only the bounded verdict (rationale ≤ ${REVIEW_RATIONALE_MAX_CHARS} chars, ≤ ${REVIEW_CORRECTIONS_MAX} corrections)`,
      );
    }
    const rationale = boundReviewRationale(r.rationale);
    /* The caps keep the first REVIEW_CORRECTIONS_MAX entries (blocking first), so the parallel arrays
       are cut the same way and stay aligned with `corrections`. */
    const severities = r.correctionSeverities?.slice(0, REVIEW_CORRECTIONS_MAX);
    const citations = r.citations?.slice(0, REVIEW_CORRECTIONS_MAX);
    return {
      approved: r.approved,
      corrections: boundReviewCorrections(r.corrections, r.correctionSeverities),
      ...(severities ? { severities } : {}),
      ...(citations ? { citations } : {}),
      ...(rationale !== undefined ? { rationale } : {}),
      ...(r.blockingCount !== undefined ? { blockingCount: r.blockingCount } : {}),
      ...(r.parsed !== undefined ? { parsed: r.parsed } : {}),
      valid: r.valid,
      issues: r.issues,
    };
  }
}
