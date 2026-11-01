/*
 * The change-coverage measurement as a span: `qayaba.coverage.measure`, a child of the phase that is open, with the decision, what it counted
 * and why a measurement that decides nothing did not (the mutation pass that follows a measurement by execution is a measurement too, with the
 * mutants it judged and the coverage they verified); a recount over dumps already on disk is `qayaba.coverage.recount`, with what it counted;
 * the surviving mutants applied again after a regeneration answered them are `qayaba.coverage.survivor_recheck`, with how many it judged and
 * how many a test now notices. A decorator: what the port returns, and what it throws, is returned and thrown as it was, and a port that
 * cannot recount or re-apply survivors stays one that cannot.
 */

import { startRunChildSpan } from "../../../../shared-infrastructure/telemetry/run-spans.ts";
import { guardTelemetry } from "../../../../shared-kernel/telemetry/guarded-telemetry.ts";
import type { SpanHandle, TelemetryPort } from "../../../../shared-kernel/telemetry/telemetry.port.ts";
import type { Attrs } from "../../../../shared-kernel/telemetry/attribute-registry.ts";
import type { CandidateCoverage } from "../../domain/per-candidate-coverage.ts";
import type { CoverageRead } from "../../domain/coverage-collector.ts";
import type { BundleMutationOutcome, CoverageMeasurement, MutantSelectionRecord } from "../../domain/objective-signal.ts";
import type { CoverageSignal, ObjectiveSignalPort } from "../../application/ports/objective-signal.port.ts";
import { engineLog } from "@kernel/ports/process-logger.ts";

import type { AssertNever, MissingForwards } from "@kernel/forwarding.ts";
/* How many candidates were measured and, per reason, how many were not: `reason: count`, once each. */
function candidateAttrs(perCandidate: readonly CandidateCoverage[]) {
  const reasons = new Map<string, number>();
  for (const c of perCandidate) if (c.unmeasured) reasons.set(c.unmeasured, (reasons.get(c.unmeasured) ?? 0) + 1);
  return {
    "qayaba.coverage.candidates": perCandidate.length,
    "qayaba.coverage.candidates_measured": perCandidate.filter((c) => c.ratio !== null).length,
    "qayaba.coverage.candidates_unmeasured": [...reasons].map(([reason, count]) => `${reason}: ${count}`),
  };
}

/* How many mutants were judged and noticed, how many survivors a spec reached (so they can reach its flow) and how many none did, and, when the survivors were observed, how many moved an observable, moved none and could not be compared. */
function survivorAttrs(m: BundleMutationOutcome): Attrs {
  const routed = m.survived.filter((s) => (s.specFiles?.length ?? 0) > 0).length;
  const observed = m.survived.filter((s) => s.moved !== undefined);
  const kindOf = (kind: "moved" | "unmoved" | "unobserved"): number => observed.filter((s) => s.moved?.kind === kind).length;
  return {
    "qayaba.mutation.applied": m.applied,
    "qayaba.mutation.killed": m.killed,
    ...(m.unreadable ? { "qayaba.mutation.unreadable": m.unreadable } : {}),
    ...(m.leftOut ? { "qayaba.mutation.mutants_left_out": m.leftOut.mutants, "qayaba.mutation.observations_left_out": m.leftOut.observations } : {}),
    "qayaba.mutation.survivors_routed": routed,
    "qayaba.mutation.survivors_without_spec": m.survived.length - routed,
    ...(observed.length > 0 ? { "qayaba.mutation.survivors_moved": kindOf("moved"), "qayaba.mutation.survivors_unmoved": kindOf("unmoved"), "qayaba.mutation.survivors_unobserved": kindOf("unobserved") } : {}),
  };
}

/* How the mutants were chosen: the sites left out (`reason: count`, once each) and how each mutant's re-run was scoped. */
function selectionAttrs(m: MutantSelectionRecord) {
  return {
    "qayaba.mutation.sites_skipped": m.skippedSites?.count ?? 0,
    ...(m.skippedSites ? { "qayaba.mutation.sites_skipped_reasons": Object.entries(m.skippedSites.reasons).map(([reason, count]) => `${reason}: ${count}`) } : {}),
    "qayaba.mutation.reruns_by_test": m.rerunsByTest,
    "qayaba.mutation.reruns_by_spec_file": m.rerunsBySpecFile,
  };
}

/*
 * A read of dumps as a span of its own under `parent`: from when the read began for as long as it took, with the dumps and bytes it was
 * given, how long the worker took to begin and to work, and how it ended. Made after the fact from the record the collection kept, so the
 * collection itself has no telemetry. Total: a fault in it is the trace's and never the measurement's.
 */
function recordRead(telemetry: TelemetryPort, parent: SpanHandle, read: CoverageRead): void {
  try {
    const span = guardTelemetry(telemetry).startSpan("qayaba.coverage.decode", {
      kind: "internal",
      parent,
      startTime: read.startedAt,
      attrs: {
        "qayaba.dumps.namespace": read.namespace,
        "qayaba.dumps.count": read.dumps,
        "qayaba.dumps.bytes": read.bytes,
        "qayaba.dumps.outcome": read.outcome,
        ...(read.startMs !== null ? { "qayaba.dumps.start_ms": Math.round(read.startMs) } : {}),
        "qayaba.dumps.work_ms": Math.round(read.workMs),
      },
    });
    span.end(read.startedAt + Math.round(read.durationMs));
  } catch (err) {
    engineLog.error(`[telemetry] a coverage read could not be recorded as a span (the measurement goes on): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* What a measurement counted, as span attributes. */
function countsOf(m: CoverageMeasurement | undefined): Attrs {
  if (!m) return {};
  return {
    "qayaba.coverage.changed_lines": m.changedLines,
    "qayaba.coverage.covered_lines": m.coveredChanged,
    "qayaba.coverage.changed_files": m.changedFiles,
    "qayaba.coverage.mapped_files": m.mappedFiles,
    ...(m.changedBranches !== undefined ? { "qayaba.coverage.changed_branches": m.changedBranches, "qayaba.coverage.taken_branches": m.takenBranches ?? 0 } : {}),
    ...(m.noCodeFiles?.length ? { "qayaba.coverage.no_code_files": m.noCodeFiles } : {}),
    ...(m.skippedDecisions ? { "qayaba.coverage.decisions_skipped": m.skippedDecisions.count, "qayaba.coverage.decisions_skipped_reasons": Object.entries(m.skippedDecisions.reasons).map(([reason, count]) => `${reason}: ${count}`) } : {}),
    ...(m.unmeasured ? { "qayaba.coverage.unmeasured": m.unmeasured } : {}),
    ...(m.evidenceLeftOut?.length ? { "qayaba.coverage.evidence_left_out": m.evidenceLeftOut } : {}),
    ...(m.perCandidate ? candidateAttrs(m.perCandidate) : {}),
  };
}

/* What a measurement decided, judged and counted, as the attributes of its span. */
function measureAttrs(result: CoverageSignal): Attrs {
  return {
    "qayaba.coverage.status": result.status,
    ...(result.bundleMutation ? survivorAttrs(result.bundleMutation) : {}),
    ...(result.mutantSelection ? selectionAttrs(result.mutantSelection) : {}),
    ...(result.ratio !== null ? { "qayaba.coverage.ratio": result.ratio } : {}),
    ...countsOf(result.measurement),
  };
}

export class TracedObjectiveSignalPort implements ObjectiveSignalPort {
  readonly recount?: ObjectiveSignalPort["recount"];
  readonly recheckSurvivors?: ObjectiveSignalPort["recheckSurvivors"];
  readonly measureMutation?: ObjectiveSignalPort["measureMutation"];
  readonly holdsChangedCode?: ObjectiveSignalPort["holdsChangedCode"];

  constructor(
    private readonly inner: ObjectiveSignalPort,
    private readonly telemetry: TelemetryPort,
  ) {
    const holdsChangedCode = inner.holdsChangedCode;
    if (holdsChangedCode) this.holdsChangedCode = (diff) => holdsChangedCode.call(inner, diff);
    const recount = inner.recount;
    if (recount) {
      this.recount = async (...args) => {
        const span = startRunChildSpan(this.telemetry, "qayaba.coverage.recount");
        try {
          const [br, specDir, diff, reruns, opts] = args;
          const result = await recount.call(inner, br, specDir, diff, reruns, { ...opts, onRead: (read) => { recordRead(this.telemetry, span, read); opts?.onRead?.(read); } });
          span.setAttrs(result ? { "qayaba.coverage.status": result.status, ...(result.ratio !== null ? { "qayaba.coverage.ratio": result.ratio } : {}), ...countsOf(result.measurement) } : {});
          span.end();
          return result;
        } catch (err) {
          span.recordError(err);
          span.end();
          throw err;
        }
      };
    }
    const recheckSurvivors = inner.recheckSurvivors;
    if (recheckSurvivors) {
      this.recheckSurvivors = async (...args) => {
        const span = startRunChildSpan(this.telemetry, "qayaba.coverage.survivor_recheck");
        try {
          const result = await recheckSurvivors.apply(inner, args);
          span.setAttrs({
            "qayaba.mutation.survivors_rechecked": args[0].length,
            "qayaba.mutation.survivors_judged": result?.applied ?? 0,
            "qayaba.mutation.survivors_closed": result?.killed ?? 0,
          });
          span.end();
          return result;
        } catch (err) {
          span.recordError(err);
          span.end();
          throw err;
        }
      };
    }
    const measureMutation = inner.measureMutation;
    if (measureMutation) {
      this.measureMutation = async (pass, specDir, opts) => {
        const span = startRunChildSpan(this.telemetry, "qayaba.coverage.measure");
        try {
          const result = await measureMutation.call(inner, pass, specDir, { ...opts, onRead: (read) => { recordRead(this.telemetry, span, read); opts?.onRead?.(read); } });
          span.setAttrs(measureAttrs(result));
          span.end();
          return result;
        } catch (err) {
          span.recordError(err);
          span.end();
          throw err;
        }
      };
    }
  }

  async measure(...args: Parameters<ObjectiveSignalPort["measure"]>): ReturnType<ObjectiveSignalPort["measure"]> {
    const span = startRunChildSpan(this.telemetry, "qayaba.coverage.measure");
    try {
      const [br, specDir, diff, baselineCases, opts] = args;
      const result = await this.inner.measure(br, specDir, diff, baselineCases, { ...opts, onRead: (read) => { recordRead(this.telemetry, span, read); opts?.onRead?.(read); } });
      span.setAttrs(measureAttrs(result));
      span.end();
      return result;
    } catch (err) {
      span.recordError(err);
      span.end();
      throw err;
    }
  }

  blocks(status: "pass" | "fail" | "unknown"): boolean {
    return this.inner.blocks(status);
  }
}

/* A method ObjectiveSignalPort gains is a compile error here until TracedObjectiveSignalPort forwards it. */
type _TracedObjectiveSignalPortForwards = AssertNever<MissingForwards<ObjectiveSignalPort, TracedObjectiveSignalPort>>;
