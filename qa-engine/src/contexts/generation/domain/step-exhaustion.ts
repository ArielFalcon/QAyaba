/*
 * Step-budget exhaustion detection (design D10), shared by the fine
 * in-session tracker (task 2.6/2.7, on the SANITIZED live output) and the
 * coarse post-hoc classifier (reading persisted `agent_turns.output_text`).
 *
 * The pattern is pinned against OpenCode 1.17.7's own literal step-limit
 * instruction ("CRITICAL - MAXIMUM STEPS REACHED … The maximum number of
 * steps allowed for this task has been reached …"), extracted directly from
 * the compiled server binary — see
 * `qa-engine/test/contexts/generation/domain/fixtures/opencode-max-steps-instruction.txt`
 * for the exact recorded text and its provenance.
 */

/** Case-insensitive: "maximum" … "steps" … "reached", in order, anywhere in the text. */
export const MAX_STEPS_MARKER = /maximum[\s\S]*?steps[\s\S]*?reached/i;

export function detectStepExhaustion(text: string): boolean {
  return MAX_STEPS_MARKER.test(text);
}
