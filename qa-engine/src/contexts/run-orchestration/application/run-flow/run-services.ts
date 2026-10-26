/*
 * The live services of one run, built once its working copy is prepared: the proof ledger, the test-intent lock, regeneration
 * acceptance, the suite snapshots it judges by and the write-confinement totals. They are objects, not state: several phases
 * use them, and a checkpoint of the run's state never holds them.
 */

import { engineLog } from "@kernel/ports/process-logger.ts";
import type { SpecRoot } from "@kernel/ports/spec-files.port.ts";
import { sha256Hex } from "../../../../shared-kernel/content-hash.ts";
import { specSetDigest } from "./spec-set-digest.ts";
import { suiteRestorePort } from "../suite-restore.ts";
import { RegenerationAcceptance } from "../regeneration-acceptance.ts";
import type { SuiteRestorePoint } from "../../domain/suite-restore-point.ts";
import type { ContractFeedback } from "../../domain/contract-feedback.ts";
import { EMPTY_TOKEN_SET, type ChangeTokenSet } from "@contexts/objective-signal/application/index.ts";
import { diffContracts, type IntentViolation, type SpecIntent } from "@contexts/objective-signal/application/index.ts";
import type { RunQaConfig, RunQaUseCaseDeps } from "./run-types.ts";
import { carryOn } from "./failure-policy.ts";
import type { WorkspaceHandle } from "../../domain/workspace-handle.ts";
import type { FixLoopState } from "../../domain/fix-loop.aggregate.ts";

export interface ConfinementTotals {
  strays: number;
  dangerous: number;
  reverted: string[];
}

export type RunServices = ReturnType<typeof createRunServices>;

export function createRunServices(deps: RunQaUseCaseDeps, cfg: RunQaConfig, workspace: WorkspaceHandle, signal: AbortSignal | undefined, recordProof: (file: string, sha256: string) => void) {
  /*
   * The run's proof: for every delivered spec file, the bytes that executed green — either in the first pass or in an accepted
   * regeneration — keyed by suite-relative path. The state holds their sha256 (`state.proof`, written through the callback); the bytes, which a restore needs,
   * are held here. A delivered file with no entry has no proof, and the final guard fails the run closed rather than publish its
   * unexecuted bytes. Seeded after the first execution; every accepted regeneration adds or replaces its changed files' entries.
   */
  const specRoot: SpecRoot = deps.workspace.readRoots(workspace);
  const proofBytes = new Map<string, Uint8Array>();
  const keepProof = (file: string, sha256: string, bytes?: Uint8Array): void => {
    recordProof(file, sha256);
    if (bytes === undefined) proofBytes.delete(file);
    else proofBytes.set(file, bytes);
  };
  /* The fix loop in progress: its ports and scratch are live objects, so the state holds only where it stands. */
  const fixLoopHandle: { current: FixLoopState | undefined } = { current: undefined };
  const integrityCounters = { acceptances: 0, rejected: 0, proofReused: 0, capHit: false };
  const snapshotPort = suiteRestorePort(specRoot, deps.specFiles);
  /* Built once per run; the deadline, validation, execution and the closed-loop proof source are each passed per call. */
  /*
   * The test-intent lock. A primary pass fixes each spec's contract against the change's own tokens
   * (the literals on added diff lines); a later regeneration is diffed against that baseline and a
   * generic weakening is rejected under `enforce`, recorded under `signal`. Baseline and tokens live
   * for this run only: a new primary pass is never bound by a previous run's contract.
   */
  const intentLockPolicy = cfg.intentLock ?? { mode: "signal", opacityFlagRatio: 0.5 };
  /* The master switch grants the A slice: with it off the lock is not read at all, whatever the app configured (B6). */
  const intentLock = cfg.reviewLoopIntegrity ? intentLockPolicy : { ...intentLockPolicy, mode: "off" as const };
  const intentState: {
    tokens: ChangeTokenSet;
    baselines: Map<string, readonly SpecIntent[]>;
    violations: number;
    wouldReject: number;
    clauses: number;
    opaque: number;
    opacityHigh: boolean;
  } = { tokens: EMPTY_TOKEN_SET, baselines: new Map(), violations: 0, wouldReject: 0, clauses: 0, opaque: 0, opacityHigh: false };
  /** The primary pass's bytes, read once after its execution: the contract a regeneration may not weaken. */
  const primeIntentBaseline = async (): Promise<void> => {
    const extractor = deps.intentContract;
    if (!extractor || intentLock.mode === "off") return;
    const current = await snapshotPort.snapshot(workspace.specDir, deps.specFiles.list(workspace.specDir));
    const decoder = new TextDecoder();
    for (const [file, bytes] of current.files) {
      if (intentState.baselines.has(file)) continue;
      const extraction = extractor.extract(file, decoder.decode(bytes));
      intentState.clauses += extraction.clauseCount;
      intentState.opaque += extraction.opaqueCount;
      if (extraction.clauseCount > 0 && extraction.opacityRatio > intentLock.opacityFlagRatio) intentState.opacityHigh = true;
      intentState.baselines.set(file, extraction.specs);
    }
  };
  const contractCheck = async (files: readonly string[]): Promise<{ ok: boolean; reason?: string; violations?: readonly ContractFeedback[] }> => {
    const extractor = deps.intentContract;
    if (!extractor || intentLock.mode === "off" || files.length === 0) return { ok: true };
    const current = await snapshotPort.snapshot(workspace.specDir, [...files]);
    const decoder = new TextDecoder();
    const deltas: IntentViolation[] = [];
    for (const file of files) {
      const bytes = current.files.get(file);
      /* A file the turn deleted is judged by the delta rules of its tests, not re-read here. */
      if (bytes === undefined) continue;
      const extraction = extractor.extract(file, decoder.decode(bytes));
      intentState.clauses += extraction.clauseCount;
      intentState.opaque += extraction.opaqueCount;
      if (extraction.clauseCount > 0 && extraction.opacityRatio > intentLock.opacityFlagRatio) intentState.opacityHigh = true;
      const previous = intentState.baselines.get(file);
      if (previous === undefined) {
        /* The primary pass establishes the contract; a regeneration never re-baselines (A5). */
        intentState.baselines.set(file, extraction.specs);
        continue;
      }
      deltas.push(...diffContracts(previous, extraction.specs, intentState.tokens));
    }
    if (deltas.length === 0) return { ok: true };
    intentState.violations += deltas.length;
    const reason = `contract: ${deltas.map((delta) => `${delta.rule} (${delta.clauseId})`).join(", ")}`;
    /* The deltas travel with the refusal: the site that sent the turn hands them to the next one as facts (A-2b). */
    if (intentLock.mode === "enforce") return { ok: false, reason, violations: deltas };
    /* Signal: the regeneration is accepted and the would-be rejection is recorded. */
    intentState.wouldReject += 1;
    deps.observer?.onEvent({ type: "log.line", level: "info", text: `[qa] intent lock would reject this regeneration — ${reason}` });
    return { ok: true };
  };
  const acceptance = new RegenerationAcceptance({
    snapshot: snapshotPort,
    fingerprint: (bytes) => sha256Hex(Buffer.from(bytes).toString("utf8")),
    ledger: async (entry) => {
      keepProof(entry.file, entry.sha256, entry.bytes);
    },
    contractCheck,
  });
  const runDeadlinePort = deps.runDeadline ?? { arm: () => {}, describe: () => undefined, remainingMs: () => undefined, allowance: () => null };

  /*
   * The suite's files a turn may change — the specs and the support files they import, both read by name
   * through the confined reader — so a spec rewritten without the turn reporting it is covered, and so is
   * a fixture the specs now read differently.
   */
  const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
  const suiteChangedFiles = async (before: SuiteRestorePoint, regenSpecs: readonly string[]): Promise<string[]> => {
    const listing = deps.specFiles.listSuite(workspace.specDir);
    /* A listing the walk could not finish cannot say what changed: the caller then judges the whole suite. */
    if (listing.cut) return [...new Set([...before.files.keys(), ...regenSpecs.map((file) => file.replaceAll("\\", "/"))])];
    const current = listing.files;
    const after = await snapshotPort.snapshot(workspace.specDir, current);
    const changed = new Set<string>();
    /* Created, rewritten and deleted alike: a file that was there before and is gone now is a change acceptance must judge. */
    for (const file of before.files.keys()) {
      if (!after.files.has(file)) changed.add(file);
    }
    for (const file of current) {
      const beforeBytes = before.files.get(file);
      const afterBytes = after.files.get(file);
      if (beforeBytes === undefined || afterBytes === undefined || !sameBytes(beforeBytes, afterBytes)) changed.add(file);
    }
    for (const file of regenSpecs) {
      const normalized = file.replaceAll("\\", "/");
      if (normalized.endsWith(".spec.ts") && after.files.has(normalized)) changed.add(normalized);
    }
    return [...changed];
  };
  /*
   * What one acceptance must execute: the specs the turn changed, and — when the turn touched anything the
   * specs import (a fixture, a helper, the login setup), or the suite could not be listed — every spec, since
   * a spec whose own bytes did not change can still read differently now (B-4, and the proof it rests on).
   */
  const snapshotSuite = (): Promise<SuiteRestorePoint> => snapshotPort.snapshot(workspace.specDir, deps.specFiles.listSuite(workspace.specDir).files);
  const acceptanceScope = (changed: readonly string[]): string[] => {
    const specs = changed.filter((file) => file.endsWith(".spec.ts"));
    const supportChanged = specs.length !== changed.length;
    return supportChanged ? deps.specFiles.list(workspace.specDir) : specs;
  };

  let confinementAcc: ConfinementTotals | undefined;
  const enforceConfinement = async (): Promise<void> => {
    if (!deps.confinement) return;
    try {
      const result = await deps.confinement.enforce(workspace, signal);
      confinementAcc = {
        strays: (confinementAcc?.strays ?? 0) + result.strays,
        dangerous: (confinementAcc?.dangerous ?? 0) + result.dangerous,
        reverted: [...(confinementAcc?.reverted ?? []), ...result.reverted],
      };
    } catch (err) {
      /* A git dir that is not the orchestrator's is a security refusal, never a fault to isolate. */
      carryOn(err);
      /*
       * Log loudly, never throw, never alter the verdict or block publish. A thrown
       * enforce() means this call's counts are unknowable — increment dangerous
       * without fabricating a reverted path.
       */
      engineLog.error(
        `[qa] write-confinement enforcement FAILED (fault-isolated — run continues, never blocks publish): ${err instanceof Error ? err.message : String(err)}`,
      );
      confinementAcc = {
        strays: confinementAcc?.strays ?? 0,
        dangerous: (confinementAcc?.dangerous ?? 0) + 1,
        reverted: confinementAcc?.reverted ?? [],
      };
    }
  };

  return {
    specRoot,
    specFiles: deps.specFiles,
    /** The digest of these spec files as the working copy holds them now (see `specSetDigest`). */
    specDigest: (files: readonly string[]) => specSetDigest((file) => deps.specFiles.read(specRoot, file), files),
    proofBytes,
    keepProof,
    fixLoopHandle,
    integrityCounters,
    snapshotPort,
    intentLock,
    intentState,
    primeIntentBaseline,
    contractCheck,
    acceptance,
    runDeadlinePort,
    suiteChangedFiles,
    snapshotSuite,
    acceptanceScope,
    /*
     * The write-confinement totals stay undefined until the first enforce() completes, so an unwired or never-called
     * confinement never persists a fabricated {strays:0}. Publication adds its own reverts through `add`.
     */
    confinement: {
      get totals(): ConfinementTotals | undefined {
        return confinementAcc;
      },
      enforce: enforceConfinement,
      add(more: ConfinementTotals): void {
        confinementAcc = {
          strays: (confinementAcc?.strays ?? 0) + more.strays,
          dangerous: (confinementAcc?.dangerous ?? 0) + more.dangerous,
          reverted: [...(confinementAcc?.reverted ?? []), ...more.reverted],
        };
      },
    },
  };
}
