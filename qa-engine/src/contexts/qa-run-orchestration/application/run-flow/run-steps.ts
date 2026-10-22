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
  { name: "ground the repository before generating", run: groundRepository },
  { name: "resolve the blast radius and its structural signal", run: resolveBlastRadius },
  { name: "resolve the service links", run: resolveServiceLinks },
  { name: "resolve the cross-repo impact", run: resolveCrossRepoImpact },
  { name: "assemble the enrichment every generation starts from", run: assembleEnrichment },
  { name: "generate the first pass", phase: "generate", run: generateFirstPass },
  { name: "decide from how the generation ended", run: settleGenerationEnd },
  { name: "ground the specs before they run, with one corrective regeneration", run: groundBeforeExecution },
  { name: "validate the specs, repairing the static gate's errors", phase: "validate", run: validateStatically },
  { name: "check DEV is healthy before executing", phase: "health", run: checkHealth },
  { name: "sign in just before the specs run", runs: (_state, ctx) => ctx.input.mode !== "context" && !ctx.cfg.isCode, run: prepareExecuteAuth },
  { name: "open the execute phase", phase: "execute", runs: (_state, ctx) => ctx.input.mode !== "context", run: announceExecution },
  { name: "execute the specs", run: executeSpecs },
];
