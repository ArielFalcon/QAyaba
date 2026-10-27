/*
 * The one application service every regeneration site shares (static-fix, fix-loop,
 * reviewer-correction, coverage): accept or reject the specs a regeneration changed. A regeneration
 * is accepted only after it validates and its changed specs execute green (or reuse a proof), and the
 * green bytes are fingerprinted into the run's proof ledger; a regeneration that is not accepted has
 * its pre-turn bytes restored and the files its turn created removed, so the bytes on disk always
 * equal the last bytes that executed green. A regeneration that changed spec files only
 * (`independentSpecs`) is judged file by file: when its execution fails, every spec file whose cases
 * all passed (or whose bytes already hold a proof) is kept and only the others are restored; with none
 * kept it is rejected whole. An iterative fix-loop round may adopt a failing execution
 * (`adoptFailures`): its bytes and cases stand while the loop repairs them, but only green bytes get a
 * proof, so nothing can publish them. Built once per run; the run's own counter caps how many
 * acceptance executions one run spends, and the run's deadline bounds each of them.
 */
import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { normalizeSpecPath } from "@kernel/spec-path.ts";
import { RunDeadlineExceededError } from "@kernel/run-deadline.ts";
import { MAX_ACCEPTANCE_EXECUTIONS } from "../../../shared-kernel/derive-cycle-backstop.ts";
import type { ContractFeedback } from "../domain/contract-feedback.ts";
import type { ClosedLoopHandle } from "@contexts/agent-tools/application/index.ts";
import type { ExecutionPort, ValidationPort } from "@contexts/test-execution/application/index.ts";
import type { RunDeadlinePort } from "./ports/run-deadline.port.ts";
import type { SuiteRestorePoint } from "../domain/suite-restore-point.ts";
import type { SuiteRestorePort } from "./ports/suite-restore.port.ts";

/** One accepted file's proof: its suite-relative path, the sha256 of its green bytes, and those bytes when they could be read, so a later restore has them. */
export interface AcceptanceProofEntry {
  file: string;
  sha256: string;
  bytes?: Uint8Array;
}

export type AcceptanceOutcome =
  | {
      kind: "accepted";
      /** The specs executed in this acceptance; empty when every change reused a proof. */
      executedSpecs: readonly string[];
      /** The execution's result; absent when nothing was executed (every change reused a proof). */
      execution?: { verdict: RunVerdict; cases: readonly QaCase[]; logs: string };
      /** path → sha256 of the accepted (green) bytes, for the proof ledger. */
      proof: readonly AcceptanceProofEntry[];
      /** The changed files whose new bytes stand: every one, unless the acceptance was judged per spec file. */
      kept: readonly string[];
      /** The changed files given their pre-turn bytes back (a created one removed) because a case of theirs did not pass; empty unless judged per spec file. */
      restored: readonly string[];
    }
  | {
      kind: "rejected";
      reason: string;
      /** The execution that rejected the round (an infra-error), when one ran. */
      execution?: { verdict: RunVerdict; cases: readonly QaCase[]; logs: string };
      /** The contract deltas that rejected the round, when the intent lock was the reason: the caller hands them to the next turn as facts (A-2b). */
      violations?: readonly ContractFeedback[];
    }
  | { kind: "cap" };

export interface RegenerationAcceptanceDeps {
  snapshot: SuiteRestorePort;
  /** sha256 of the accepted bytes; injected so the service never imports node:crypto. */
  fingerprint: (bytes: Uint8Array) => string;
  /** Records one accepted file's proof (its path, the sha256 of its green bytes, and those bytes). */
  ledger: (entry: AcceptanceProofEntry) => Promise<void>;
  /** The intent-lock contract check (a later task). Absent: always passes. */
  contractCheck?: (changedSpecFiles: readonly string[]) => Promise<{ ok: boolean; reason?: string; violations?: readonly ContractFeedback[] }>;
}

export interface AcceptanceInput {
  specDir: string;
  /** The specs the regeneration changed or created, relative to the spec directory. */
  changedSpecFiles: readonly string[];
  /** The execution namespace: `${runId}-acc<n>`. */
  namespace: string;
  /** The pre-turn snapshot the caller took before sending the turn. */
  snapshot: SuiteRestorePoint;
  /** The proof source: a changed file whose current bytes `isClosed([file])` is not executed. Absent: every change is executed. */
  closedLoop?: Pick<ClosedLoopHandle, "isClosed">;
  /**
   * An iterative fix-loop round adopts a failing or flaky execution: its bytes and cases stand
   * because the run is already failing and the loop repairs from them. Validation failures, an
   * infra-error and the cap still reject and restore, and only green bytes reach the proof ledger.
   */
  adoptFailures?: boolean;
  /**
   * The turn changed spec files only (no file they import), so each stands or falls on its own cases: a failing execution
   * keeps every spec file whose cases all passed and restores the others. Absent: the regeneration is accepted or rejected whole.
   */
  independentSpecs?: boolean;
  /** No time left: an execution that would start throws the run's deadline error. */
  deadline: RunDeadlinePort;
  validate: ValidationPort["validate"];
  execute: ExecutionPort["execute"];
}

export class RegenerationAcceptance {
  private executions = 0;

  constructor(private readonly deps: RegenerationAcceptanceDeps) {}

  /** Before the turn: capture the pre-turn bytes of the specs the regeneration may touch. */
  snapshot(specDir: string, specFiles: readonly string[]): Promise<SuiteRestorePoint> {
    return this.deps.snapshot.snapshot(specDir, specFiles);
  }

  /**
   * Claims one execution from the run's cap for an execution outside an acceptance (the one triage
   * re-execution). False when the cap is reached; the caller then stops without executing.
   */
  spendExecution(): boolean {
    if (this.executions >= MAX_ACCEPTANCE_EXECUTIONS) return false;
    this.executions += 1;
    return true;
  }

  /** After the turn finished (the caller reports it, so no session can still write): accept or reject the changed specs. */
  async accept(input: AcceptanceInput): Promise<AcceptanceOutcome> {
    const created = input.changedSpecFiles.filter((file) => !input.snapshot.files.has(file));
    const restore = (): Promise<void> => this.deps.snapshot.restore(input.specDir, input.snapshot, created);

    /* 1. Contract check (the intent lock, a later task): absent means it passes. */
    const contract = await this.deps.contractCheck?.(input.changedSpecFiles);
    if (contract && !contract.ok) {
      await restore();
      return {
        kind: "rejected",
        reason: contract.reason ?? "the contract check rejected the change",
        ...(contract.violations?.length ? { violations: contract.violations } : {}),
      };
    }

    /* 2. Validate. */
    const validation = await input.validate(input.specDir, [...input.changedSpecFiles]);
    if (!validation.ok) {
      await restore();
      return { kind: "rejected", reason: validation.errors.length > 0 ? validation.errors.join("; ") : "validation failed" };
    }

    /* 3. Proof reuse: a changed file whose current bytes are closed already executed green, so it is not executed again. */
    const toExecute: string[] = [];
    for (const file of input.changedSpecFiles) {
      if (input.closedLoop && (await input.closedLoop.isClosed([file]))) continue;
      toExecute.push(file);
    }

    /* 4. Cap: a further execution is not started; the prior verdict and bytes stand, restored. */
    if (toExecute.length > 0 && this.executions >= MAX_ACCEPTANCE_EXECUTIONS) {
      await restore();
      return { kind: "cap" };
    }

    /* 5. Deadline: no time left before an execution is the run's deadline, never a silent skip. */
    if (toExecute.length > 0) this.requireTime(input.deadline);

    /* 6. Execute only the changed/generated specs, once, under their own namespace. */
    let execution: { verdict: RunVerdict; cases: readonly QaCase[]; logs: string } | undefined;
    let kept: readonly string[] = input.changedSpecFiles;
    let restored: readonly string[] = [];
    let executedSpecs: readonly string[] = toExecute;
    if (toExecute.length > 0) {
      this.executions += 1;
      const result = await input.execute(input.specDir, { specFiles: toExecute, retries: 0, namespace: input.namespace });
      execution = { verdict: result.verdict, cases: result.cases, logs: result.logs };
      if (result.verdict !== "pass" && (!input.adoptFailures || result.verdict === "infra-error")) {
        const split = input.independentSpecs && result.verdict !== "infra-error" ? greenSpecFiles(input.changedSpecFiles, toExecute, result.cases) : undefined;
        if (!split) {
          await restore();
          return { kind: "rejected", reason: `execution ended ${result.verdict}`, execution };
        }
        /* 6b. Per spec file: the failing files get their pre-turn bytes back; the green ones stand on their own cases. */
        const back = new Map([...input.snapshot.files].filter(([file]) => split.restored.includes(file)));
        await this.deps.snapshot.restore(input.specDir, { files: back }, created.filter((file) => split.restored.includes(file)));
        ({ kept, restored } = split);
        executedSpecs = toExecute.filter((file) => kept.includes(file));
        const keptCases = result.cases.filter((c) => c.file !== undefined && executedSpecs.some((file) => sameSpec(file, c.file!)));
        execution = { verdict: "pass", cases: keptCases, logs: result.logs };
      }
    }

    /* 7. Fingerprint the accepted bytes and record the proof ledger. Only green bytes get a proof: a fix-loop round may adopt a failing execution, but nothing may publish it. */
    const proof: AcceptanceProofEntry[] = [];
    if (execution === undefined || execution.verdict === "pass") {
      const accepted = await this.deps.snapshot.snapshot(input.specDir, [...kept]);
      for (const file of kept) {
        const bytes = accepted.files.get(file);
        if (bytes !== undefined) proof.push({ file, sha256: this.deps.fingerprint(bytes), bytes });
      }
      for (const entry of proof) await this.deps.ledger(entry);
    }

    return {
      kind: "accepted",
      executedSpecs,
      ...(execution ? { execution } : {}),
      proof,
      kept,
      restored,
    };
  }

  private requireTime(deadline: RunDeadlinePort): void {
    const left = deadline.remainingMs?.();
    if (left === undefined || left > 0) return;
    const described = deadline.describe?.();
    throw new RunDeadlineExceededError(described?.budgetMs ?? 0, described?.label ?? "unarmed", "acceptance", "before-turn");
  }
}

const sameSpec = (a: string, b: string): boolean => normalizeSpecPath(a) === normalizeSpecPath(b);

/*
 * The changed spec files a failing execution leaves standing: a file whose proof was reused (not executed here) and an executed
 * file with at least one case, every one of them passed. Undefined when the failure cannot be laid on spec files (a case that did
 * not pass names no executed file, or no case failed at all) or when no file is left standing: the regeneration is then rejected whole.
 */
function greenSpecFiles(changed: readonly string[], executed: readonly string[], cases: readonly QaCase[]): { kept: string[]; restored: string[] } | undefined {
  const failing = cases.filter((c) => c.status !== "pass");
  if (failing.length === 0 || failing.some((c) => c.file === undefined || !executed.some((file) => sameSpec(file, c.file!)))) return undefined;
  const green = (file: string): boolean => {
    if (!executed.includes(file)) return true;
    const own = cases.filter((c) => c.file !== undefined && sameSpec(file, c.file));
    return own.length > 0 && own.every((c) => c.status === "pass");
  };
  const kept = changed.filter(green);
  if (kept.length === 0) return undefined;
  return { kept, restored: changed.filter((file) => !kept.includes(file)) };
}
