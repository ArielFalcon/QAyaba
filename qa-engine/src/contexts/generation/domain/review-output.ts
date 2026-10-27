/*
 * What a reviewer verdict may cost the record and the next prompt: a verdict is a judgment, not a
 * report. Every field the orchestrator keeps from the reviewer's answer passes through these bounds,
 * so a model that answers with a page of prose around its JSON leaves the same small verdict as one
 * that answers with the object alone. The bounds never change the verdict: `approved` is read as the
 * reviewer wrote it, and a correction dropped by the count cap was already beyond what a generator
 * can act on in one round (and a blocking one still leaves `approved:false` standing).
 */

/* The version of the reviewer's instructions (static role file + assembled output contract). It is
 * stamped into both prompts so a run's verdict can be tied to the wording that produced it. Bump it
 * whenever the reviewer's contract changes. */
export const REVIEWER_PROMPT_VERSION = 7;

/* One or two sentences: the durable WHY of the verdict, not an essay. */
export const REVIEW_RATIONALE_MAX_CHARS = 320;

/* One actionable correction: what to change, where, and why — never a pasted spec. */
export const REVIEW_CORRECTION_MAX_CHARS = 400;

/* A generator can act on a handful of corrections in one round; a longer list is the same finding
 * repeated. Blocking entries come first in the contract, so the cap keeps them. */
export const REVIEW_CORRECTIONS_MAX = 6;

/* A verdict answer longer than this is mostly prose. It is still parsed (the JSON is what counts),
 * but the stored verdict is bounded to the fields above. */
export const REVIEW_RESPONSE_MAX_CHARS = 6_000;

/* The closed correction vocabulary the reviewer prompt requires. The first tag of a blocking
 * correction is the class the telemetry records; `none` means the round carried no correction and
 * `other` means a correction arrived without a class tag (a contract miss, still bounded). */
export const REVIEW_CORRECTION_CLASSES = ["false-positive", "wrong-objective", "fragile-selector", "no-cleanup", "other"] as const;
export type ReviewCorrectionClass = (typeof REVIEW_CORRECTION_CLASSES)[number] | "none";
const CORRECTION_CLASS_TAG = /^\s*\[(false-positive|wrong-objective|fragile-selector|no-cleanup|other)\]/;

/** The class of the first tagged correction, `other` for untagged corrections, `none` when there are none. */
export function correctionClassOf(corrections: readonly string[]): ReviewCorrectionClass {
  if (corrections.length === 0) return "none";
  for (const correction of corrections) {
    const match = CORRECTION_CLASS_TAG.exec(correction);
    if (match) return match[1] as ReviewCorrectionClass;
  }
  return "other";
}

/* Collapse whitespace and cut at a sentence or word boundary, marking a cut with an ellipsis. */
export function boundReviewText(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) return oneLine;
  /* Leave one character for the ellipsis. */
  const cut = oneLine.slice(0, Math.max(0, maxChars - 1));
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  const atEnd = sentenceEnd > cut.length / 2 ? sentenceEnd + 1 : cut.lastIndexOf(" ");
  const body = (atEnd > 0 ? cut.slice(0, atEnd) : cut).trimEnd();
  return `${body}…`;
}

/** A rationale the record can keep: empty is absent, anything longer is cut at the cap. */
export function boundReviewRationale(rationale: string | undefined): string | undefined {
  if (rationale === undefined) return undefined;
  const bounded = boundReviewText(rationale, REVIEW_RATIONALE_MAX_CHARS);
  return bounded === "" ? undefined : bounded;
}

/**
 * The corrections the generator will be handed (at most REVIEW_CORRECTIONS_MAX, each bounded), with the severity and citation the reviewer gave each, bounded and ordered as one
 * list, so the three stay aligned by index. A parallel list the reviewer did not give stays absent.
 */
export function boundReviewFindings<C>(
  corrections: readonly string[],
  severities?: readonly ("blocking" | "advisory")[],
  citations?: readonly C[],
): { corrections: string[]; severities?: ("blocking" | "advisory")[]; citations?: C[] } {
  const bounded = corrections.map((correction, index) => ({
    text: boundReviewText(correction, REVIEW_CORRECTION_MAX_CHARS),
    severity: severities?.[index],
    citation: citations?.[index],
  }));
  /* A count cap must never hide the blocking finding the generator has to fix: blocking entries
   * come first, whatever order the model wrote them in. */
  const blocking = (c: (typeof bounded)[number]): boolean => c.severity === "blocking";
  const kept = [...bounded.filter(blocking), ...bounded.filter((c) => !blocking(c))]
    .filter((c) => c.text !== "")
    .slice(0, REVIEW_CORRECTIONS_MAX);
  return {
    corrections: kept.map((c) => c.text),
    ...(severities ? { severities: kept.map((c) => c.severity ?? "advisory") } : {}),
    ...(citations ? { citations: kept.map((c) => c.citation as C) } : {}),
  };
}

/** Whether an answer exceeded the contract's size, so a caller can say so without keeping the prose. */
export function reviewAnswerIsOversized(answer: string): boolean {
  return answer.length > REVIEW_RESPONSE_MAX_CHARS;
}
