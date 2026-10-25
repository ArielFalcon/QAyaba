/*
 * The run, read top to bottom: every step in the order it runs, the phase it opens and when it is skipped. The steps before the
 * working copy is prepared see only the run's context; the rest also see its workspace and live services.
 */

import type { RunQaResult } from "../run-qa.use-case.ts";
import type { FlowStep } from "./run-flow.ts";
import type { RunContext, WorkspaceRunContext } from "./run-context.ts";
import type { RunState } from "./run-state.ts";
import { cleanPriorRun, openAuthoringHandles, prepareLogin, restoreAcceptedSuite, setUpProject } from "./phases/setup.steps.ts";
import { assembleEnrichment, groundRepository, readDiffShapes, resolveBlastRadius, resolveCrossRepoImpact, resolveServiceLinks, retrieveRules, selectExemplars } from "./phases/ground.steps.ts";
import { generateFirstPass, groundBeforeExecution, settleGenerationEnd } from "./phases/generate.steps.ts";
import { announceExecution, checkHealth, executeSpecs, prepareExecuteAuth, validateStatically } from "./phases/execute.steps.ts";
import { fingerprintGreenSuite, runFixLoop } from "./phases/fix-loop.steps.ts";
import { announceCoverage, announcesCoverage, measureCoverage, measuresCoverage, regenerateForCoverage, regeneratesForCoverage } from "./phases/coverage.steps.ts";
import { releaseCoordinatedPass, remeasureStaleCoverage, remeasuresStaleCoverage, reviewTests, reviewsRun } from "./phases/review.steps.ts";
import { decideRun, guardFinalProof, guardsFinalProof, recordCoordinationOutcome } from "./phases/decide.steps.ts";
import { captureContextMap, enforceConfinement, keepAcceptedSuite, keepsSuite, publishDecision, publishes, pruneAfterPublish } from "./phases/publish.steps.ts";
import { finishRun, learnFromOutcome, learnsFromRun, persistOutcome } from "./phases/persist.steps.ts";
import { armRunDeadline, classifyChange, indexMirror, stopIfAbortedBeforeGate, waitForDeploy } from "./phases/opening.steps.ts";

export const BEFORE_WORKSPACE: ReadonlyArray<FlowStep<RunState, RunContext, RunQaResult>> = [
  { name: "stop a run aborted before it started", run: stopIfAbortedBeforeGate },
  { name: "wait until DEV serves the commit", phase: "gate", run: waitForDeploy },
];

export const IN_WORKSPACE: ReadonlyArray<FlowStep<RunState, WorkspaceRunContext, RunQaResult>> = [
  { name: "classify the change", phase: "classify", runs: (_state, ctx) => ctx.input.mode === "diff", run: classifyChange },
  { name: "arm the run deadline", run: armRunDeadline },
  { name: "bring the code index up to the commit", run: indexMirror },
  { name: "restore the accepted suite", phase: "setup", run: restoreAcceptedSuite },
  { name: "set the project up", run: setUpProject },
  { name: "prepare the app's login", run: prepareLogin },
  { name: "clean the data of a prior interrupted run", run: cleanPriorRun },
  { name: "open the authoring location, run_spec loop and agent browser", run: openAuthoringHandles },
  { name: "read the diff's structural shapes", run: readDiffShapes },
  { name: "retrieve the learned rules", phase: "ground", run: retrieveRules },
  { name: "select the curriculum's exemplars", run: selectExemplars },
  /* The links and the cross-repo impact come before the grounding: the change's pages are joined over them (S10). */
  { name: "resolve the blast radius and its structural signal", run: resolveBlastRadius },
  { name: "resolve the service links", run: resolveServiceLinks },
  { name: "resolve the cross-repo impact", run: resolveCrossRepoImpact },
  { name: "ground the repository before generating", run: groundRepository },
  { name: "assemble the enrichment every generation starts from", run: assembleEnrichment },
  { name: "generate the first pass", phase: "generate", run: generateFirstPass },
  { name: "decide from how the generation ended", run: settleGenerationEnd },
  { name: "ground the specs before they run, with one corrective regeneration", run: groundBeforeExecution },
  { name: "validate the specs, repairing the static gate's errors", phase: "validate", run: validateStatically },
  { name: "check DEV is healthy before executing", phase: "health", run: checkHealth },
  { name: "sign in just before the specs run", runs: (_state, ctx) => ctx.input.mode !== "context" && !ctx.cfg.isCode, run: prepareExecuteAuth },
  { name: "open the execute phase", phase: "execute", runs: (_state, ctx) => ctx.input.mode !== "context", run: announceExecution },
  { name: "execute the specs", run: executeSpecs },
  { name: "repair a failing execution with the fix loop", phase: "fix_loop", runs: (state) => state.execution.run.verdict === "fail", run: runFixLoop },
  { name: "fingerprint the green suite for the suite store", run: fingerprintGreenSuite },
  { name: "open the coverage phase", phase: "coverage", runs: announcesCoverage, run: announceCoverage },
  { name: "measure the change-coverage of the green run", runs: measuresCoverage, run: measureCoverage },
  { name: "regenerate once at the uncovered lines", runs: regeneratesForCoverage, run: regenerateForCoverage },
  { name: "review the green run's specs with the independent reviewer", phase: "review", runs: reviewsRun, run: reviewTests },
  { name: "release the coordinated pass once nothing can correct through it", run: releaseCoordinatedPass },
  { name: "re-measure a coverage that an accepted regeneration made stale", runs: remeasuresStaleCoverage, run: remeasureStaleCoverage },
  { name: "prove the delivered bytes are the ones that executed green", runs: guardsFinalProof, run: guardFinalProof },
  { name: "decide from the run's evidence", phase: "decide", run: decideRun },
  { name: "record how a coordinated run ended", run: recordCoordinationOutcome },
  { name: "enforce write-confinement before publishing", run: enforceConfinement },
  { name: "capture the context map before publication", phase: "publish", run: captureContextMap },
  { name: "keep the accepted suite before publication", runs: keepsSuite, run: keepAcceptedSuite },
  { name: "publish the pull request or Issue the decision calls for", runs: publishes, run: publishDecision },
  { name: "prune the mirror once the git write is done", run: pruneAfterPublish },
  { name: "derive and save the run's outcome", run: persistOutcome },
  { name: "learn from the saved outcome", phase: "learn", runs: learnsFromRun, run: learnFromOutcome },
  { name: "end the run with its result", run: finishRun },
];
