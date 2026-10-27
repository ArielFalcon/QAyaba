/*
 * The run, read top to bottom: every step in the order it runs, the phase it opens (15 phases, 48 steps) and when it is skipped.
 * The steps before the working copy is prepared see only the run's context; the rest also see its workspace and live services.
 * Each step names the class it has for the failure policy (`class`, absent for `required`) and the top-level fields of the
 * state it may write (`writes`); the runner refuses an update outside them, and the reducers are the only code that writes a
 * shared field. A repair loop (the static fix, the corrective regeneration before execution, the fix loop, the coverage
 * regeneration, the review rounds) is a run of steps of its own: the step that ends a round names the next one with `goto`, so
 * the table also holds the loops' entries and exits.
 */

import type { FlowStep } from "./run-flow.ts";
import type { RunContext, WorkspaceRunContext } from "./run-context.ts";
import { runOf, type RunState } from "./run-state.ts";
import { cleanPriorRun, openAuthoringHandles, prepareLogin, restoreAcceptedSuite, setUpProject } from "./phases/setup.steps.ts";
import { assembleEnrichment, computeChangeScope, groundRepository, readDiffShapes, resolveBlastRadius, resolveCrossRepoImpact, resolveServiceLinks, retrieveRules, selectExemplars } from "./phases/ground.steps.ts";
import {
  generateFirstPass,
  groundBeforeExecution,
  preExecRegenerate,
  settleGenerationEnd,
} from "./phases/generate.steps.ts";
import { announceExecution, checkHealth, executeSpecs, prepareExecuteAuth, staticFixRound, validateStatically } from "./phases/execute.steps.ts";
import { fingerprintGreenSuite, fixAccept, fixAdjudicate, fixReexecute, fixRegenerate, fixTriage, runFixLoop, settleFixLoop } from "./phases/fix-loop.steps.ts";
import { triageFlakyCases, triagesFlaky } from "./phases/flaky.steps.ts";
import { announceCoverage,announcesCoverage, measureCoverage, measuresCoverage, regenerateForBranchCases, regenerateForCoverage, regeneratesForBranchCases, regeneratesForCoverage } from "./phases/coverage.steps.ts";
import { releaseCoordinatedPass, remeasureStaleCoverage, remeasuresStaleCoverage, reviewCorrect, reviewInProgress, reviewResolve, reviewRound, reviewSettle, reviewTests, reviewsRun } from "./phases/review.steps.ts";
import { decideRun, guardFinalProof, guardsFinalProof } from "./phases/decide.steps.ts";
import { armRunDeadline, classifyChange, indexMirror, waitForDeploy } from "./phases/opening.steps.ts";

export const BEFORE_WORKSPACE: ReadonlyArray<FlowStep<RunState, RunContext>> = [
  { id: "wait-for-deploy", writes: [], phase: "gate", run: waitForDeploy },
];

export const IN_WORKSPACE: ReadonlyArray<FlowStep<RunState, WorkspaceRunContext>> = [
  { id: "classify-change", writes: ["classification"], phase: "classify", runs: (_state, ctx) => ctx.input.mode === "diff", run: classifyChange },
  { id: "arm-run-deadline", writes: [], run: armRunDeadline },
  { id: "index-mirror", writes: [], run: indexMirror },
  { id: "restore-accepted-suite", writes: ["setup"], phase: "setup", run: restoreAcceptedSuite },
  { id: "set-up-project", writes: [], run: setUpProject },
  { id: "prepare-login", writes: ["setup"], run: prepareLogin },
  { id: "clean-prior-run", writes: [], run: cleanPriorRun },
  { id: "open-authoring-handles", writes: [], run: openAuthoringHandles },
  { id: "read-diff-shapes", writes: ["grounding"], run: readDiffShapes },
  { id: "retrieve-rules", writes: ["grounding"], phase: "ground", run: retrieveRules },
  { id: "select-exemplars", writes: ["grounding"], run: selectExemplars },
  /* The links and the cross-repo impact come before the grounding: the change's pages are joined over them (S10). */
  { id: "resolve-blast-radius", writes: ["grounding"], run: resolveBlastRadius },
  { id: "resolve-service-links", writes: ["grounding"], run: resolveServiceLinks },
  { id: "resolve-cross-repo-impact", writes: ["grounding"], run: resolveCrossRepoImpact },
  { id: "compute-change-scope", writes: ["grounding"], run: computeChangeScope },
  { id: "ground-repository", writes: ["grounding"], run: groundRepository },
  { id: "assemble-enrichment", writes: ["grounding"], run: assembleEnrichment },
  { id: "generate-first-pass", writes: ["generation", "loops"], phase: "generate", run: generateFirstPass },
  { id: "settle-generation-end", writes: [], run: settleGenerationEnd },
  { id: "ground-before-execution", writes: ["generation"], run: groundBeforeExecution },
  { id: "pre-exec-regenerate", writes: ["generation", "loops"], run: preExecRegenerate },
  { id: "validate-statically", writes: ["execution"], phase: "validate", run: validateStatically },
  { id: "static-fix-round", writes: ["execution", "loops"], run: staticFixRound },
  { id: "check-health", writes: [], phase: "health", run: checkHealth },
  { id: "prepare-execute-auth", writes: ["execution"], runs: (_state, ctx) => ctx.input.mode !== "context" && !ctx.cfg.isCode, run: prepareExecuteAuth },
  { id: "announce-execution", writes: [], phase: "execute", runs: (_state, ctx) => ctx.input.mode !== "context", run: announceExecution },
  { id: "execute-specs", writes: ["execution"], run: executeSpecs },
  { id: "run-fix-loop", writes: ["fixLoop", "loops"], phase: "fix_loop", runs: (state) => runOf(state).verdict === "fail", run: runFixLoop },
  { id: "fix-triage", writes: ["fixLoop", "loops"], runs: (state) => state.fixLoop.session?.stage === "triage", run: fixTriage },
  { id: "fix-adjudicate", writes: ["fixLoop", "loops"], runs: (state) => state.fixLoop.session?.stage === "adjudicate", run: fixAdjudicate },
  { id: "fix-regenerate", writes: ["fixLoop", "loops"], runs: (state) => state.fixLoop.session?.stage === "regenerate", run: fixRegenerate },
  { id: "fix-accept", writes: ["fixLoop", "loops"], runs: (state) => state.fixLoop.session?.stage === "accept", run: fixAccept },
  { id: "fix-reexecute", writes: ["fixLoop", "loops"], runs: (state) => state.fixLoop.session?.stage === "reexecute", run: fixReexecute },
  { id: "settle-fix-loop", writes: ["execution", "fixLoop"], runs: (state) => state.fixLoop.session !== undefined, run: settleFixLoop },
  { id: "fingerprint-green-suite", writes: [], run: fingerprintGreenSuite },
  { id: "announce-coverage", writes: [], phase: "coverage", runs: announcesCoverage, run: announceCoverage },
  { id: "measure-coverage", writes: ["coverage"], runs: measuresCoverage, run: measureCoverage },
  { id: "regenerate-for-coverage", writes: ["coverage", "degraded", "execution", "loops"], class: "proven", runs: regeneratesForCoverage, run: regenerateForCoverage },
  { id: "regenerate-for-branch-cases", writes: ["coverage", "degraded", "execution", "loops"], class: "proven", runs: regeneratesForBranchCases, run: regenerateForBranchCases },
  { id: "triage-flaky-cases", writes: ["coverage", "degraded", "execution", "loops"], class: "proven", runs: triagesFlaky, run: triageFlakyCases },
  { id: "review-tests", writes: ["degraded", "loops", "review"], class: "proven", phase: "review", runs: reviewsRun, run: reviewTests },
  { id: "review-round", writes: ["degraded", "execution", "loops"], class: "proven", runs: reviewInProgress, run: reviewRound },
  { id: "review-correct", writes: ["coverage", "degraded", "loops"], class: "proven", runs: reviewInProgress, run: reviewCorrect },
  { id: "review-resolve", writes: ["coverage", "degraded", "execution", "loops"], class: "proven", runs: reviewInProgress, run: reviewResolve },
  { id: "review-settle", writes: ["degraded", "review"], class: "proven", runs: reviewInProgress, run: reviewSettle },
  { id: "release-coordinated-pass", writes: [], run: releaseCoordinatedPass },
  { id: "remeasure-stale-coverage", writes: ["coverage", "degraded", "execution"], class: "proven", runs: remeasuresStaleCoverage, run: remeasureStaleCoverage },
  { id: "guard-final-proof", writes: [], runs: guardsFinalProof, run: guardFinalProof },
  { id: "decide-run", writes: ["decided"], phase: "decide", run: decideRun },
];
