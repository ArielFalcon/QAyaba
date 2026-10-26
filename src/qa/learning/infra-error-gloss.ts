/*
 * One plain sentence for an infra-error run, by the class that closed it. An infra-error is not
 * always the DEV environment: the agent can run out of steps or decide nothing, which is the engine's
 * own condition and never the app's. Every operator surface words an infra-error through this, so a
 * class it does not know (or no class at all) reads as the neutral "could not reach a verdict".
 */
const ENGINE_SIDE_GLOSS: Readonly<Record<string, string>> = {
  "E-STEP-BUDGET": "the agent ran out of steps without reporting any spec — an engine-side condition, not a fault of the app",
  "E-NO-DECISION": "the agent returned no specs and no decision to skip — an engine-side condition, not a fault of the app",
  "E-TIME-BUDGET": "the agent ran out of time without reporting any spec — an engine-side condition, not a fault of the app",
};
/*
 * A login the run could not complete is neither the engine's condition nor the DEV environment's: it
 * is a precondition of the run, worded apart from the engine-side classes and with no fault assigned.
 */
const PRECONDITION_GLOSS: Readonly<Record<string, string>> = {
  "E-PRECONDITION": "the app's login could not be completed before testing began — a precondition of the run, not a fault in the code under test",
};
/*
 * An unavailable reviewer is a collaborator the run could not reach: the tests passed but were never judged. It is neither the
 * engine's own condition nor a rejection, so it is worded apart and with no fault assigned to the app.
 */
const COLLABORATOR_GLOSS: Readonly<Record<string, string>> = {
  "E-REVIEWER-UNAVAILABLE": "the reviewer could not be reached or returned nothing, so the passing tests were never judged — a reviewer-runtime problem, not a rejection and not a fault of the app",
  "E-REVIEW-DISPUTED": "the reviewer's verified blocking finding survived every round while the generator's rebuttal stayed unverified, so the engine could not settle it — a judgment dispute, not a fault of the app",
};
/*
 * A run that could not execute agent-influenced code safely (no sandbox uid under QA_EXEC_SANDBOX=required, or the egress filter
 * down under QA_EGRESS_MODE=enforce) is a condition of the deployment: worded apart, with no fault assigned to the app.
 */
const SANDBOX_GLOSS: Readonly<Record<string, string>> = {
  "E-SANDBOX": "the execution sandbox was unavailable, so the tests were not run (no sandbox uid, or the egress filter is down) — a deployment condition, not a fault of the app",
};
/*
 * The shell's own classes, for a run it had to end itself: an unexpected internal error is a defect to investigate (never worded as
 * infrastructure), and an untrusted git tree is refused before anything runs. Neither is a fault of the app.
 */
const SHELL_END_GLOSS: Readonly<Record<string, string>> = {
  "internal-error": "an unexpected internal error in the orchestrator — a defect to investigate, not infrastructure and not a fault of the app",
  "security-refusal": "the working copy's git directory is not the orchestrator's own, so no git ran — refused for safety, not a fault of the app",
};
const NEUTRAL_INFRA_GLOSS = "the run could not reach a verdict — infrastructure, not a code fault";

export function infraErrorGloss(errorClass: string | null | undefined): string {
  return (errorClass ? (ENGINE_SIDE_GLOSS[errorClass] ?? PRECONDITION_GLOSS[errorClass] ?? COLLABORATOR_GLOSS[errorClass] ?? SANDBOX_GLOSS[errorClass] ?? SHELL_END_GLOSS[errorClass]) : undefined) ?? NEUTRAL_INFRA_GLOSS;
}
