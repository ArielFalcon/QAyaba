/*
 * How a generation attempt ended, and the note that says so. Pure: the use case gathers the
 * facts (spec count, whether a verdict was read, the declared no-op reason, whether the agent
 * ran out of steps) and this module turns them into exactly one kind and, for the kinds that
 * end a run without specs, the note that explains it.
 */
import { GENERATION_END, type GenerationEndKind } from "@kernel/generation-end.ts";

export interface GenerationEndFacts {
  specCount: number;
  /** Whether a closing verdict could be read from the output. */
  parsed: boolean;
  /** The reason the generator gave for writing nothing; absent when it declared no no-op. */
  noopReason: string | null | undefined;
  /** Whether any of the generation's turns ran out of steps. */
  exhausted: boolean;
}

/**
 * Specs decide first: with any spec the run continues, and exhaustion is only recorded. Without
 * specs, exhaustion outranks everything the output says, because a turn cut off by its budget
 * cannot be trusted to have decided. Then a verdict that could not be read, a declared no-op, and
 * finally the parsed empty verdict that decided nothing.
 */
export function classifyGenerationEnd(facts: GenerationEndFacts): GenerationEndKind {
  if (facts.specCount > 0) return GENERATION_END.DELIVERED;
  if (facts.exhausted) return GENERATION_END.EXHAUSTED;
  if (!facts.parsed) return GENERATION_END.NO_VERDICT;
  if (facts.noopReason?.trim()) return GENERATION_END.DECLARED_NOOP;
  return GENERATION_END.UNDECIDED_EMPTY;
}

/** The most characters a generation note may hold: it is persisted on the run and shown in the operator surfaces. */
export const GENERATION_NOTE_MAX_CHARS = 600;

/** What the generation's main turn measured; each figure is null when it could not be. */
export interface GenerationTurnFacts {
  maxSteps: number | null;
  stepsUsed: number | null;
  writeCount: number | null;
  /** Whether the tool calls of the turn were all observed, so the counts are exact rather than lower bounds. */
  observationComplete: boolean;
}

export type GenerationNoteInput =
  | {
      end: typeof GENERATION_END.DECLARED_NOOP;
      /** The generator's own reason. */
      noopReason: string;
    }
  | {
      end: typeof GENERATION_END.EXHAUSTED | typeof GENERATION_END.UNDECIDED_EMPTY;
      turn?: GenerationTurnFacts;
      /** The end of the agent's output, already sanitized. */
      outputTail: string;
      /** Whether the repair turn (not the main one) ran out of steps. */
      repairExhausted?: boolean;
    };

type NoteWithoutSpecs = Exclude<GenerationNoteInput, { end: typeof GENERATION_END.DECLARED_NOOP }>;

const TAIL_LABEL = " Output tail: ";

function stepsFact(turn: GenerationTurnFacts | undefined): string {
  if (turn?.stepsUsed == null) return "steps count unavailable";
  return turn.maxSteps === null ? `steps ${turn.stepsUsed}` : `steps ${turn.stepsUsed}/${turn.maxSteps}`;
}

function writesFact(turn: GenerationTurnFacts | undefined): string {
  if (turn?.writeCount == null) return "writes unavailable";
  return turn.observationComplete ? `writes ${turn.writeCount}` : `writes >=${turn.writeCount}`;
}

function leadFor(input: NoteWithoutSpecs): string {
  if (input.end === GENERATION_END.UNDECIDED_EMPTY) {
    return "The generator returned no specs and no no-op decision, even after one repair";
  }
  return input.repairExhausted
    ? "Step budget exhausted in the repair turn with no spec written"
    : "Step budget exhausted with no spec written";
}

/**
 * The note persisted for a generation that ends a run. A declared no-op's note is its reason. The
 * others state what happened, what the turn measured and the end of the output, cut from the start
 * of the tail so the end of the output survives the bound. The lead and the facts are a few dozen
 * characters, far inside the bound, so the tail always has room.
 */
export function renderGenerationNote(input: GenerationNoteInput): string {
  if (input.end === GENERATION_END.DECLARED_NOOP) {
    return input.noopReason.trim().slice(0, GENERATION_NOTE_MAX_CHARS);
  }
  const head = `${leadFor(input)} (${stepsFact(input.turn)}; ${writesFact(input.turn)}).`;
  const tail = input.outputTail.replace(/\s+/g, " ").trim();
  if (tail === "") return head;
  const room = GENERATION_NOTE_MAX_CHARS - head.length - TAIL_LABEL.length;
  return `${head}${TAIL_LABEL}${tail.slice(-room)}`;
}
