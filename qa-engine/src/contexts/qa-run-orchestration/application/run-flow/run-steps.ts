/*
 * The run, read top to bottom: every step in the order it runs, the phase it opens and when it is skipped. The steps before the
 * working copy is prepared see only the run's context; the rest also see its workspace and live services.
 */

import type { FlowStep } from "./run-flow.ts";
import type { RunContext, WorkspaceRunContext } from "./run-context.ts";
import type { RunState } from "./run-state.ts";
import { cleanPriorRun, openAuthoringHandles, prepareLogin, restoreAcceptedSuite, setUpProject } from "./phases/setup.steps.ts";
import { assembleEnrichment, groundRepository, readDiffShapes, resolveBlastRadius, resolveCrossRepoImpact, resolveServiceLinks, retrieveRules, selectExemplars } from "./phases/ground.steps.ts";
import { generateFirstPass, groundBeforeExecution, preExecRegenerate, settleGenerationEnd } from "./phases/generate.steps.ts";
import { announceExecution, checkHealth, executeSpecs, prepareExecuteAuth, staticFixRound, validateStatically } from "./phases/execute.steps.ts";
import { fingerprintGreenSuite, fixAccept, fixAdjudicate, fixReexecute, fixRegenerate, fixTriage, runFixLoop, settleFixLoop } from "./phases/fix-loop.steps.ts";
import { announceCoverage, announcesCoverage, measureCoverage, measuresCoverage, regenerateForCoverage, regeneratesForCoverage } from "./phases/coverage.steps.ts";
import { releaseCoordinatedPass, remeasureStaleCoverage, remeasuresStaleCoverage, reviewTests, reviewsRun } from "./phases/review.steps.ts";
import { decideRun, guardFinalProof, guardsFinalProof } from "./phases/decide.steps.ts";
import { armRunDeadline, classifyChange, indexMirror, waitForDeploy } from "./phases/opening.steps.ts";

export const BEFORE_WORKSPACE: ReadonlyArray<FlowStep<RunState, RunContext>> = [
  { id: "wait-for-deploy", phase: "gate", run: waitForDeploy },
];

export const IN_WORKSPACE: ReadonlyArray<FlowStep<RunState, WorkspaceRunContext>> = [
  { id: "classify-change", phase: "classify", runs: (_state, ctx) => ctx.input.mode === "diff", run: classifyChange },
  { id: "arm-run-deadline", run: armRunDeadline },
  { id: "index-mirror", run: indexMirror },
  { id: "restore-accepted-suite", phase: "setup", run: restoreAcceptedSuite },
  { id: "set-up-project", run: setUpProject },
  { id: "prepare-login", run: prepareLogin },
  { id: "clean-prior-run", run: cleanPriorRun },
  { id: "open-authoring-handles", run: openAuthoringHandles },
  { id: "read-diff-shapes", run: readDiffShapes },
  { id: "retrieve-rules", phase: "ground", run: retrieveRules },
  { id: "select-exemplars", run: selectExemplars },
  /* The links and the cross-repo impact come before the grounding: the change's pages are joined over them (S10). */
  { id: "resolve-blast-radius", run: resolveBlastRadius },
  { id: "resolve-service-links", run: resolveServiceLinks },
  { id: "resolve-cross-repo-impact", run: resolveCrossRepoImpact },
  { id: "ground-repository", run: groundRepository },
  { id: "assemble-enrichment", run: assembleEnrichment },
  { id: "generate-first-pass", phase: "generate", run: generateFirstPass },
  { id: "settle-generation-end", run: settleGenerationEnd },
  { id: "ground-before-execution", run: groundBeforeExecution },
  { id: "pre-exec-regenerate", run: preExecRegenerate },
  { id: "validate-statically", phase: "validate", run: validateStatically },
  { id: "static-fix-round", run: staticFixRound },
  { id: "check-health", phase: "health", run: checkHealth },
  { id: "prepare-execute-auth", runs: (_state, ctx) => ctx.input.mode !== "context" && !ctx.cfg.isCode, run: prepareExecuteAuth },
  { id: "announce-execution", phase: "execute", runs: (_state, ctx) => ctx.input.mode !== "context", run: announceExecution },
  { id: "execute-specs", run: executeSpecs },
  { id: "run-fix-loop", phase: "fix_loop", runs: (state) => state.execution.run.verdict === "fail", run: runFixLoop },
  { id: "fix-triage", runs: (state) => state.fixLoop.session?.loop.stage === "triage", run: fixTriage },
  { id: "fix-adjudicate", runs: (state) => state.fixLoop.session?.loop.stage === "adjudicate", run: fixAdjudicate },
  { id: "fix-regenerate", runs: (state) => state.fixLoop.session?.loop.stage === "regenerate", run: fixRegenerate },
  { id: "fix-accept", runs: (state) => state.fixLoop.session?.loop.stage === "accept", run: fixAccept },
  { id: "fix-reexecute", runs: (state) => state.fixLoop.session?.loop.stage === "reexecute", run: fixReexecute },
  { id: "settle-fix-loop", runs: (state) => state.fixLoop.session !== undefined, run: settleFixLoop },
  { id: "fingerprint-green-suite", run: fingerprintGreenSuite },
  { id: "announce-coverage", phase: "coverage", runs: announcesCoverage, run: announceCoverage },
  { id: "measure-coverage", runs: measuresCoverage, run: measureCoverage },
  { id: "regenerate-for-coverage", runs: regeneratesForCoverage, run: regenerateForCoverage },
  { id: "review-tests", phase: "review", runs: reviewsRun, run: reviewTests },
  { id: "release-coordinated-pass", run: releaseCoordinatedPass },
  { id: "remeasure-stale-coverage", runs: remeasuresStaleCoverage, run: remeasureStaleCoverage },
  { id: "guard-final-proof", runs: guardsFinalProof, run: guardFinalProof },
  { id: "decide-run", phase: "decide", run: decideRun },
];
