/*
 * Step-budget exhaustion detection, shared by the fine
 * in-session tracker (on the SANITIZED live output) and the
 * coarse post-hoc classifier (reading persisted `agent_turns.output_text`).
 *
 * The matcher recognises the step-limit notice OpenCode injects when a session
 * reaches its step cap ("CRITICAL - MAXIMUM STEPS REACHED … The maximum number
 * of steps allowed for this task has been reached …", recorded verbatim in
 * `qa-engine/test/contexts/generation/domain/fixtures/opencode-max-steps-instruction.txt`)
 * and the way models restate it in their own turn ("Maximum steps for this agent
 * have been reached", "I've reached the maximum number of steps").
 *
 * The three words must sit close together, joined only by plain words: a gap is a
 * bounded run of words separated by single spaces, so punctuation, quotes, brackets
 * and line breaks end it. That keeps a generator verdict ("…maximum length validation…",
 * "steps":[…"assert the page is reached"]) or ordinary prose that merely mentions the
 * words apart from reading as exhaustion, and keeps the scan linear: every repetition
 * is bounded and a word can only be split one way, so nothing backtracks over the text.
 * Greedy bounded repetition of a word is fine; a lazy or nested unbounded quantifier is
 * not, because the scan runs synchronously over model output of any size.
 *
 * The notice only says something about a turn when it sits in the turn's FINAL step: an
 * earlier step's reasoning may recall or quote it while the agent went on to finish. The
 * verdict of `stepExhaustionState` is therefore read from `finalStepText`, and combined
 * with the step count when the observation of that count was complete.
 */

const GAP_WORD = "[a-z0-9'’-]+";
const MAX = "max(?:imum)?";
const REACHED = "(?:reached|hit|exceeded)";

/** "maximum [number of] steps [allowed for this task has been] reached". */
const MAX_THEN_REACHED = `\\b${MAX}(?: ${GAP_WORD}){0,3} steps(?: ${GAP_WORD}){0,6} ${REACHED}\\b`;
/** "reached [the] maximum [number of] steps". */
const REACHED_THEN_MAX = `\\b${REACHED}(?: ${GAP_WORD}){0,6} ${MAX}(?: ${GAP_WORD}){0,3} steps\\b`;

const STEP_LIMIT_NOTICE = new RegExp(`${MAX_THEN_REACHED}|${REACHED_THEN_MAX}`, "i");

export function detectStepExhaustion(text: string): boolean {
  return STEP_LIMIT_NOTICE.test(text);
}

/** One part of an agent turn's response. Only `text` parts carry the turn's spoken output. */
export interface TurnPart {
  type: string;
  text?: string;
}

const STEP_START = "step-start";
const TEXT = "text";

/**
 * The text the agent produced in its final step: the `text` parts after the last `step-start`.
 * Reasoning is excluded; code and JSON are kept as written. A response with no `step-start`
 * part has one undivided step, so every text part counts. A final step that produced no text
 * is empty — it never falls back to what an earlier step said.
 */
export function finalStepText(parts: readonly TurnPart[]): string {
  let lastStepStart = -1;
  parts.forEach((part, index) => {
    if (part.type === STEP_START) lastStepStart = index;
  });
  return parts
    .slice(lastStepStart + 1)
    .filter((part) => part.type === TEXT)
    .map((part) => part.text ?? "")
    .join("");
}

export interface StepExhaustionInput {
  /** The limit the turn is judged against: the number its prompt stated, else the agent's configured limit; null when neither exists. */
  maxSteps: number | null;
  /** Steps the turn used; null unless the count was observed completely. */
  stepsUsed: number | null;
  finalStepText: string;
}

/**
 * Whether the turn exhausted its step budget: true when the notice ends the turn or a complete
 * count reached the limit, false only when a complete count is below the limit and there is no
 * notice, null when neither is known. Callers treat only `true` as exhausted.
 */
export function stepExhaustionState(input: StepExhaustionInput): boolean | null {
  if (detectStepExhaustion(input.finalStepText)) return true;
  if (input.maxSteps === null || input.stepsUsed === null) return null;
  return input.stepsUsed >= input.maxSteps;
}
