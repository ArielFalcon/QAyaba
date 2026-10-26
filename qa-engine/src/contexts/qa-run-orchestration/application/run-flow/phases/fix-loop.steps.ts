/* The fix_loop phase of a run: the bounded repair of a failing primary execution, and the fingerprint the suite store takes of a green one. */

import { CORRECTION_ORIGIN } from "../../coordination/lead-correction.ts";
import { createHash } from "node:crypto";
import type { QaCase } from "@kernel/qa-case.ts";
import { readConfinedSpecFile, listSpecFiles, readOwnedSpecFile, MAX_SPEC_SOURCE_BYTES, type SpecRoot } from "../../../../../shared-infrastructure/spec-path-confinement.ts";
import { FixLoop, type FixLoopInput, type FixLoopAcceptancePort, type FixLoopExecutionPort, type FixLoopGenerationPort, type FixLoopSelectorCheckPort } from "../../../domain/fix-loop.aggregate.ts";
import { checkSpecSelectors, contradictionOrigins } from "../../../domain/helpers/selector-check.ts";
import { attributeContradictions } from "../../../domain/helpers/contradiction-attribution.ts";
import type { SpecSnapshot } from "../../ports/spec-snapshot.port.ts";
import { goto, type StepOutcome } from "../run-flow.ts";
import type { StepId } from "../step-ids.ts";
import type { FixLoopStep } from "../../../domain/fix-loop-action.ts";
import type { WorkspaceRunContext } from "../run-context.ts";
import type { FixLoopSession, RunState } from "../run-state.ts";
import { checkDevHealth, executeAccepted, liveExecutionOptions, validateAccepted } from "./execute.steps.ts";
import { loopClosedNow, regenerate } from "./generation-services.ts";
import { carryOn } from "../failure-policy.ts";

type Result = Promise<StepOutcome<RunState>>;

/*
 * Renders every failing case's failureDom into one prompt-facing block.
 * Distinct from the aggregate's per-case line splitter. Undefined when no
 * failing case carries a failureDom.
 */
function buildFailureDomSnapshot(cases: readonly QaCase[]): string | undefined {
  const parts: string[] = [];
  for (const c of cases) {
    if (c.status !== "fail" || !c.failureDom) continue;
    const lines = c.failureDom.split("\n").filter((l) => l.trim());
    if (lines.length === 0) continue;
    parts.push(`### ${c.name}\n${lines.join("\n")}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/* One digest for a whole spec set, so the fix loop can say whether it changed the files. Sorted, sha256 over `file + "\0" + bytes`; undefined when the set is empty or any file cannot be read. */
function specSetDigest(specRoot: SpecRoot, files: readonly string[]): string | undefined {
  const unique = [...new Set(files)].sort();
  if (unique.length === 0) return undefined;
  const hash = createHash("sha256");
  for (const file of unique) {
    try {
      const bytes = readConfinedSpecFile(specRoot, file);
      hash.update(file).update("\0").update(bytes);
    } catch {
      return undefined;
    }
  }
  return hash.digest("hex");
}

/*
 * Prefer FixLoop's final specMetas when present; otherwise lastGenerated's.
 * Undefined when neither source has anything — the "tested" section is omitted.
 */
export function resolveTested(state: Readonly<RunState>): { flow?: string; objective?: string }[] | undefined {
  const { fixLoopFinalSpecMetas } = state.fixLoop;
  return fixLoopFinalSpecMetas?.length ? fixLoopFinalSpecMetas : state.execution.lastGenerated.specMetas;
}

/* The ports of the fix loop, over the working copy and the services of this run; the loop's own state lives in its session, so a step rebuilds them each time. */
function fixLoopFor(state: Readonly<RunState>, ctx: WorkspaceRunContext, pending: FixLoopSession["pending"]): FixLoop {
  const { deps, workspace, signal, services, trail, startedAt, wallClockBudget } = ctx;
  const { closedLoop } = trail;
  const { lastGenerated } = state.execution;
  const { snapshotSuite, acceptanceScope, suiteChangedFiles, acceptance, integrityCounters, runDeadlinePort, snapshotPort } = services;
  const liveExecutionOpts = liveExecutionOptions(ctx);
  const fixLoopExecution: FixLoopExecutionPort = {
    /*
     * Filtered retry scopes to failing spec files. Per-attempt namespace
     * (`${runId}-rN`) isolates Playwright test-data so a retry cannot collide with
     * its prior attempt on apps with no delete.
     */
    execute: async (fixLoopInput) => {
      const r = await deps.execution.execute(workspace.specDir, {
        ...liveExecutionOpts,
        ...(fixLoopInput.specFiles ? { specFiles: fixLoopInput.specFiles } : {}),
        ...(fixLoopInput.namespace ? { namespace: fixLoopInput.namespace } : {}),
        ...(fixLoopInput.retries !== undefined ? { retries: fixLoopInput.retries } : {}),
      });
      return { verdict: r.verdict, cases: r.cases };
    },
  };
  const fixLoopGeneration: FixLoopGenerationPort = {
    /* Forward FixLoopGenerateInput so a retry prompt sees what failed. */
    generate: async (fixLoopInput) => {
      /* A spent wall-clock budget starts no further agent turn: the round returns nothing and the loop ends on what it has. */
      if (wallClockBudget.exhausted(Date.now() - startedAt)) {
        return { specs: [], approved: lastGenerated.approved, note: "wall-clock budget exhausted: no further regeneration" };
      }
      /*
       * Merge leftover pre-exec selector contradictions with FixLoop's post-failure
       * check — independent evidence; neither suppresses the other.
       */
      /* mutation-scope:begin lever2-contradictions */
      const lever2Contradictions = fixLoopInput.selectorContradictions ?? [];
      const mergedSelectorContradictions = [...pending.selectorContradictions, ...lever2Contradictions];
      /* The pre-exec ones come with the files they were attributed to when found; Lever-2's are attributed now, to the specs the check says raised them. */
      const attributedSpecFiles = [
        ...new Set([...pending.attributedSpecFiles, ...attributeContradictions(lever2Contradictions, fixLoopInput.selectorContradictionOrigins, pending.latestSpecs)]),
      /* mutation-scope:end lever2-contradictions */
      ];
      /* mutation-scope:begin regenerate-round */

      const r = await regenerate(state, ctx, signal, {
        fixCases: fixLoopInput.fixCases,
        ...(mergedSelectorContradictions.length ? { selectorContradictions: mergedSelectorContradictions } : {}),
      /* mutation-scope:end regenerate-round */
        ...(attributedSpecFiles.length ? { attributedSpecFiles } : {}),
        ...(fixLoopInput.domSnapshot ? { domSnapshot: fixLoopInput.domSnapshot } : {}),
        /* The intent lock's deltas on the round it refused: the next round repairs the weakening it introduced. */
        ...(fixLoopInput.contractFeedback?.length ? { contractFeedback: fixLoopInput.contractFeedback } : {}),
      }, CORRECTION_ORIGIN.EXECUTION);
      /* mutation-scope:begin confinement-and-clear-corrections */
      await services.confinement.enforce();
      /* Pre-exec corrections are one-shot — clear after the first FixLoop regen. */
      pending.selectorContradictions = [];
      /* mutation-scope:end confinement-and-clear-corrections */
      pending.attributedSpecFiles = [];
      /* The next Lever-2 check reads this generation's sources: its contradictions will be raised by these specs. */
      pending.latestSpecs = r.specs;
      /* Forward just-generated specSources so the next Lever-2 check is not empty. */
      return {
        specs: r.specs,
        approved: r.approved,
        note: r.note,
        specSources: r.specSources,
        ...(r.specMetas ? { specMetas: r.specMetas } : {}),
        ...(r.testCorrect ? { testCorrect: r.testCorrect } : {}),
      };
    /* mutation-scope:begin round-result-tail */
    },
    /* mutation-scope:end round-result-tail */
  };
  const fixLoopSelectorCheck: FixLoopSelectorCheckPort = {
    check: (specSources, trees) => ({ ...checkSpecSelectors(specSources, trees), origins: contradictionOrigins(specSources, trees) }),
  };
  /*
   * The run's acceptance of a fix-loop round: the snapshot the turn may change, the validation and
   * execution of the changed specs (a failing round is adopted so the loop repairs from it), and
   * the bytes of the round that produced the best run. Always wired: the byte restore is a
   * correctness fix, never behind the review-loop switch.
   */
  const fixLoopAcceptance: FixLoopAcceptancePort = {
    begin: () => snapshotSuite(),
    accept: async ({ round, specs, namespace }) => {
      const snapshot = round as SpecSnapshot;
      /* A round that changed anything the specs import is accepted over the whole suite, never over its specs alone. */
      const changedSpecFiles = acceptanceScope(await suiteChangedFiles(snapshot, specs));
      if (changedSpecFiles.length === 0) {
        /* The turn changed no bytes: nothing to accept, and the round's current bytes are its token. */
        return { kind: "accepted", changedSpecFiles, accepted: snapshot };
      }
      const outcome = await acceptance.accept({
        specDir: workspace.specDir,
        changedSpecFiles,
        namespace,
        snapshot,
        adoptFailures: true,
        ...(closedLoop ? { closedLoop } : {}),
        deadline: runDeadlinePort,
        validate: validateAccepted(ctx),
        execute: executeAccepted(ctx),
      });
      if (outcome.kind === "accepted") {
        integrityCounters.acceptances += 1;
        if (outcome.executedSpecs.length === 0) integrityCounters.proofReused += 1;
        /* The bytes this round leaves behind are the token a later, worse round is measured against. */
        const accepted = await snapshotSuite();
        return {
          kind: "accepted",
          changedSpecFiles,
          ...(outcome.execution ? { execution: { verdict: outcome.execution.verdict, cases: [...outcome.execution.cases] } } : {}),
          accepted,
        };
      }
      if (outcome.kind === "cap") {
        integrityCounters.capHit = true;
        return { kind: "cap" };
      }
      integrityCounters.rejected += 1;
      return {
        kind: "rejected",
        reason: outcome.reason,
        /* The contract's deltas are the next round's facts: without them the loop would end on a rejection the generator could repair. */
        ...(outcome.violations?.length ? { violations: outcome.violations } : {}),
        ...(outcome.execution
          ? { execution: { verdict: outcome.execution.verdict, cases: [...outcome.execution.cases] } }
          : {}),
      };
    },
    restore: async (token) => {
      const snapshot = token as SpecSnapshot;
      /* Every file created after the best round goes, and its own bytes go back: the suite is exactly the best round's. */
      const created = listSpecFiles(workspace.specDir).filter((file) => !snapshot.files.has(file));
      await snapshotPort.restore(workspace.specDir, snapshot, created);
    },
  };
  return new FixLoop({
    execution: fixLoopExecution,
    generation: fixLoopGeneration,
    selectorCheck: fixLoopSelectorCheck,
    acceptance: fixLoopAcceptance,
  });
}

/* The step a stage of the loop is. */
const STAGE_STEP = {
  triage: "fix-triage",
  adjudicate: "fix-adjudicate",
  regenerate: "fix-regenerate",
  accept: "fix-accept",
  reexecute: "fix-reexecute",
} as const satisfies Record<FixLoopStep, StepId>;

/* Where the run goes after a stage: the step of the next stage, or the settle step once the loop stopped. */
function routeTo(session: FixLoopSession, state: Readonly<RunState>): StepOutcome<RunState> {
  const stage = session.loop.stage;
  return goto(stage === "done" ? "settle-fix-loop" : STAGE_STEP[stage], {
    fixLoop: { ...state.fixLoop, session },
    loops: { ...state.loops, fixLoop: session.loop.retry },
  });
}

/* FixLoop only when the initial verdict is "fail". Context mode's synthetic pass never enters. */
export async function runFixLoop(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, input, cfg, workspace, trail } = ctx;
  const { closedLoop } = trail;
  const { generating } = state.classification;
  const { lastGenerated, run: initialRun } = state.execution;
  const { acceptance, runDeadlinePort, proofLedger } = ctx.services;
  deps.observer?.onStep("retry", "fix-loop engaged after a failing execute()");
  /*
   * coverageLikelyMeasured omits the cross-repo conjunct on purpose: a false
   * positive only disables filtered-retry (widens the safety net). Threading true
   * prevents filtered-retry from undercounting change-coverage's denominator.
   */
  const coverageWillMeasure = generating && input.mode === "diff" && cfg.coveragePolicyMode !== "off";
  /*
   * The objective a failure is judged against: the change's own files on a diff run, the guidance
   * a manual run was asked to cover. Feeds the adjudicator's objective_gap rule; empty when the
   * run has neither (manual without guidance).
   */
  const objectiveSource = input.mode === "manual"
    ? (input.guidance ? [input.guidance] : [])
    : (state.classification.intent?.changedFiles ?? []);
  /* Round 0 Lever-2 seed. Absent when the adapter has no readSpecSource — never fabricated. */
  const initialSpecSources = lastGenerated.specSources;
  /* Failure-point DOM from the initial failing cases, before any FixLoop re-execute. */
  const failureDomSnapshot = buildFailureDomSnapshot(initialRun.cases);
  /* The generator saw every delivered spec pass against DEV in these very bytes: a failure now is not one a rewrite is likely to cure, so it is adjudicated for its Issue and not regenerated. */
  const fixLoopRetired = await loopClosedNow(ctx);
  if (fixLoopRetired) {
    deps.observer?.onEvent({ type: "log.line", level: "info", text: "[qa] the suite failed, but every delivered spec was seen passing through run_spec: the failure is adjudicated and not regenerated" });
  }
  /* The failing set and the spec-set digest before the loop, so the phase span can carry what the loop changed. */
  const fixLoopSpecRoot: SpecRoot = { mirrorDir: workspace.mirrorDir, specDir: workspace.specDir };
  const failingBefore = initialRun.cases.filter((c) => c.status === "fail").length;
  const specShaBefore = specSetDigest(fixLoopSpecRoot, initialRun.cases.map((c) => c.file).filter((f): f is string => !!f));
  const loopInput: FixLoopInput = {
    initialRun: { verdict: initialRun.verdict, cases: initialRun.cases },
    isCode: cfg.isCode,
    generating,
    mode: input.mode,
    objectiveSource,
    maxRetries: cfg.maxRetries,
    ...(fixLoopRetired ? { regenerate: false } : {}),
    cycleBudget: ctx.cycleBudget,
    wallClockBudget: ctx.wallClockBudget,
    devHealthy: async () => (await checkDevHealth(ctx)).healthy,
    namespace: input.runId,
    coverageWillMeasure,
    ...(initialSpecSources?.length ? { initialSpecSources } : {}),
    ...(failureDomSnapshot ? { failureDomSnapshot } : {}),
    ...(state.grounding.confirmedDataRoutes?.length ? { packConfirmedDataRoutes: state.grounding.confirmedDataRoutes } : {}),
    specDir: workspace.specDir,
    ...(cfg.reviewLoopIntegrity
      ? {
          integrity: {
            hasGreenProof: async (file: string) => {
              if (proofLedger.has(file)) return true;
              if (!closedLoop) return false;
              try {
                return await closedLoop.isClosed([file]);
              } catch (err) {
                console.error(`[qa] could not read the green proof of ${file} (triage treats it as unproven): ${err instanceof Error ? err.message : String(err)}`);
                return false;
              }
            },
            spendExecution: () => acceptance.spendExecution(),
            remainingMs: () => runDeadlinePort.remainingMs?.(),
          },
        }
      : {}),
  };
  /* Pre-exec corrections, and the files they were attributed to, still feed later FixLoop regens until the first of them consumes them. */
  /* mutation-scope:begin pending-contradictions */
  const pending: FixLoopSession["pending"] = {
    selectorContradictions: state.generation.groundingCorrections,
    attributedSpecFiles: state.generation.groundingAttribution,
    /* The specs of the latest lead generation: the next Lever-2 check reads their sources, by index, so the contradictions it finds were raised by these specs. */
    latestSpecs: lastGenerated.specs,
  };
  /* mutation-scope:end pending-contradictions */
  const loop = fixLoopFor(state, ctx, pending).begin(loopInput);
  const session: FixLoopSession = { loop, pending, failingBefore, specShaBefore };
  return routeTo(session, state);
}

function stageStep(): (state: Readonly<RunState>, ctx: WorkspaceRunContext) => Result {
  return async (state, ctx) => {
    const session = state.fixLoop.session;
    if (!session) throw new Error("a fix-loop stage ran without a fix-loop session");
    await fixLoopFor(state, ctx, session.pending).step(session.loop);
    return routeTo(session, state);
  };
}

export const fixTriage = stageStep();
export const fixAdjudicate = stageStep();
export const fixRegenerate = stageStep();
export const fixAccept = stageStep();
export const fixReexecute = stageStep();

/* The fix loop has stopped: the best round's bytes go back, and the run takes what the loop came to. */
export async function settleFixLoop(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, workspace, trail } = ctx;
  const { run: initialRun } = state.execution;
  const session = state.fixLoop.session;
  if (!session) throw new Error("the fix loop was settled without a fix-loop session");
  const loop = fixLoopFor(state, ctx, session.pending);
  await loop.settle(session.loop);
  const fixLoopResult = loop.result(session.loop);
  const { failingBefore, specShaBefore } = session;
  const fixLoopSpecRoot: SpecRoot = { mirrorDir: workspace.mirrorDir, specDir: workspace.specDir };
  const run = { verdict: fixLoopResult.run.verdict, cases: fixLoopResult.run.cases, logs: initialRun.logs };
  /* The fix_loop phase span carries what the loop came to, so a false positive (a failed run the loop changed nothing in) is queryable. */
  const failingAfter = run.cases.filter((c) => c.status === "fail").length;
  const specShaAfter = specSetDigest(fixLoopSpecRoot, run.cases.map((c) => c.file).filter((f): f is string => !!f));
  try {
    trail.spans.annotate({
      "qayaba.phase.outcome": run.verdict,
      "qayaba.fix_loop.rounds": fixLoopResult.retries,
      "qayaba.fix_loop.failing_before": failingBefore,
      "qayaba.fix_loop.failing_after": failingAfter,
      "qayaba.fix_loop.absent_selectors": fixLoopResult.absentSelectors,
      ...(fixLoopResult.triage
        ? {
            "qayaba.fix_loop.triage_trigger": fixLoopResult.triage.trigger,
            "qayaba.fix_loop.triage_outcome": fixLoopResult.triage.outcome,
            "qayaba.fix_loop.triage_files": fixLoopResult.triage.files,
          }
        : {}),
      ...(specShaBefore !== undefined && specShaAfter !== undefined
        ? {
            "qayaba.fix_loop.spec_sha_before": specShaBefore,
            "qayaba.fix_loop.spec_sha_after": specShaAfter,
            "qayaba.fix_loop.specs_changed": specShaBefore !== specShaAfter,
          }
        : {}),
    });
  } catch (err) {
    console.error(`[qa] the fix-loop phase outcome could not be traced (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (fixLoopResult.rejectedClaims > 0) {
    deps.observer?.onEvent({ type: "log.line", level: "info", text: `[qa] ${fixLoopResult.rejectedClaims} test-correct claim(s) rejected as unverified; the loop kept repairing` });
  }
  return {
    update: {
      /* Accumulate onto the shared retries; a reassignment would drop static-fix rounds. */
      execution: { ...state.execution, run, retries: state.execution.retries + fixLoopResult.retries },
      fixLoop: {
        session: undefined,
        coverageNamespace: fixLoopResult.coverageNamespace,
        /* Undefined when the loop never reached adjudicate() — never fabricated. */
        lastAdjudicatorVerdict: fixLoopResult.lastAdjudicatorVerdict,
        fixLoopFinalSpecMetas: fixLoopResult.lastSpecMetas,
        devNotRenderedConclusive: fixLoopResult.preconditionFailed,
      },
    },
  };
}

/*
 * The suite store admits a spec only with the bytes that executed green, so those bytes are fingerprinted here and read into
 * the proof ledger, before the reviewer's correction rounds or the coverage regeneration can rewrite a file that is never
 * executed again. Off-path: a fault leaves no evidence, and a capture without evidence admits no spec.
 */
export async function fingerprintGreenSuite(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, workspace, services } = ctx;
  if (!deps.suiteStore || !state.setup.suiteRestored || state.execution.run.verdict !== "pass") return;
  try {
    /* The green run executed the whole suite: every delivered spec on disk at this instant has run in these bytes. The store
     * leaves out a spec it cannot read confined, which seeds no proof (the final guard then refuses to publish it). */
    const fingerprints = await deps.suiteStore.fingerprint(
      { mirrorDir: workspace.mirrorDir, specDir: workspace.specDir },
      ctx.generation.delivered.map((d) => d.file),
    );
    /* The ledger holds the green bytes themselves when they can be read, so a later restore has them. */
    for (const [file, sha256] of fingerprints) {
      const read = readOwnedSpecFile(services.specRoot, file, MAX_SPEC_SOURCE_BYTES);
      services.proofLedger.set(file, "bytes" in read ? { sha256, bytes: read.bytes } : { sha256 });
    }
  } catch (fingerprintErr) {
    carryOn(fingerprintErr);
    ctx.host.announceSuite(`[qa] suite store fingerprint failed (off-path; no spec is admitted): ${fingerprintErr instanceof Error ? fingerprintErr.message : String(fingerprintErr)}`, "warn");
  }
}
