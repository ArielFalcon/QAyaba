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
