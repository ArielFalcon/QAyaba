import { GENERATION_END, type GenerationEndKind } from "@kernel/generation-end.ts";
import { ERROR_CLASS, type ErrorClass } from "./error-class.ts";

/**
 * What a generation end does to the run. `end` closes it with the infra-error verdict (never an
 * Issue in the watched repo); `persisted` says whether that outcome is written to the run
 * history (a generation with no readable verdict has always ended unpersisted).
 */
export type GenerationTerminal =
  | { action: "continue" }
  | { action: "skip" }
  | { action: "end"; verdict: "infra-error"; errorClass: ErrorClass; persisted: boolean };

/** The single mapping from how generation ended to how the run proceeds. */
export function terminalForGenerationEnd(end: GenerationEndKind): GenerationTerminal {
  switch (end) {
    case GENERATION_END.DELIVERED:
      return { action: "continue" };
    case GENERATION_END.DECLARED_NOOP:
      return { action: "skip" };
    case GENERATION_END.EXHAUSTED:
      return { action: "end", verdict: "infra-error", errorClass: ERROR_CLASS.STEP_BUDGET, persisted: true };
    case GENERATION_END.UNDECIDED_EMPTY:
      return { action: "end", verdict: "infra-error", errorClass: ERROR_CLASS.NO_DECISION, persisted: true };
    case GENERATION_END.NO_VERDICT:
      return { action: "end", verdict: "infra-error", errorClass: ERROR_CLASS.INFRA, persisted: false };
  }
}
