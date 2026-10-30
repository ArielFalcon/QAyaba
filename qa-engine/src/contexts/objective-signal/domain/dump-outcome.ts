/*
 * How the read of a folder of dumps (the coverage dumps decoded for a measurement, the dumps a suite run left rebuilt for harvest) ended.
 * One closed vocabulary for the reader and the harvest, so a trace and a record say the same thing: the executor's own outcomes
 * (`aborted` at its deadline, `heap-limit`, `crashed`, `unavailable`), a read that `completed`, a folder that was `absent`, and the two
 * ways files of a folder are not used whole, `over-cap` (a dump larger than one may be, the files together past the budget, more entries
 * than are looked at) and `unusable` (anything else that could not be read). Pure.
 */

export const DUMP_OUTCOMES = ["completed", "absent", "aborted", "heap-limit", "crashed", "unavailable", "over-cap", "unusable"] as const;
export type DumpOutcome = (typeof DUMP_OUTCOMES)[number];

/* What the strict reader says of a file or a folder it left out because of a cap (`run-output-reader.ts`, `spec-path-confinement.ts`); the cases that read a real oversize file pin these words. */
const OVER_CAP_REASONS: readonly RegExp[] = [/^the file is larger than \d+ bytes$/, /^the files of this directory already read hold more than the budget$/];

/* Why files of a folder were not all used: a cap when the folder was cut or any file was left out for one, otherwise unusable. */
export function unusedOutcome(input: { cut: boolean; leftOut: readonly string[] }): "over-cap" | "unusable" {
  return input.cut || input.leftOut.some((reason) => OVER_CAP_REASONS.some((pattern) => pattern.test(reason))) ? "over-cap" : "unusable";
}

/* The reasons a measurement can be unmeasured for because its evidence could not be read, one per way a read does not complete. */
export const COVERAGE_READ_FAULTS = ["decode-aborted", "decode-heap-limit", "decode-crashed", "decode-unavailable", "dumps-over-cap", "dumps-unusable"] as const;
export type CoverageReadFault = (typeof COVERAGE_READ_FAULTS)[number];

/* The fault a read's outcome is, or undefined for an outcome that is no fault (a read that completed, a folder that was not there). */
export function faultOfOutcome(outcome: DumpOutcome): CoverageReadFault | undefined {
  switch (outcome) {
    case "completed":
    case "absent":
      return undefined;
    case "aborted":
    case "heap-limit":
    case "crashed":
    case "unavailable":
      return `decode-${outcome}`;
    case "over-cap":
      return "dumps-over-cap";
    case "unusable":
      return "dumps-unusable";
  }
}

/* Whether a measurement's unmeasured reason is about the evidence not being read (a fault, or no dump at all), and not about the change or the assembler. */
export function isReadTrouble(reason: string): reason is CoverageReadFault | "no-dumps" {
  return reason === "no-dumps" || (COVERAGE_READ_FAULTS as readonly string[]).includes(reason);
}
