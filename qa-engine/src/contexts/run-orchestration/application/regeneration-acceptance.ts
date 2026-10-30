/*
 * The one application service every regeneration site shares (static-fix, fix-loop,
 * reviewer-correction, coverage): accept or reject the specs a regeneration changed. A regeneration
 * is accepted only after it validates and every changed spec executes green, and the green bytes are
 * fingerprinted into the run's proof ledger; no changed file is accepted on a proof an earlier call
 * left, so the outcome carries the cases of every file it keeps. A regeneration that is not accepted has
 * its pre-turn bytes restored and the files its turn created removed, so the bytes on disk always
 * equal the last bytes that executed green. A regeneration that changed spec files only
 * (`independentSpecs`) is judged file by file: when its execution fails, every spec file whose cases
 * all passed is kept and only the others are restored; with none kept it is rejected whole. A spec file that still exists and that the execution reported nothing of
 * (no case and no skipped test: it did not load) is never kept, whatever the verdict (a file whose tests all skipped loaded and stands;
 * a deleted file has no case by nature, and its deletion stands). An iterative fix-loop round may adopt a failing execution
 * (`adoptFailures`): its bytes and cases stand while the loop repairs them, but only green bytes get a
 * proof, so nothing can publish them. Built once per run; the run's own counter caps how many
 * acceptance executions one run spends, and the run's deadline bounds each of them.
 */
import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { normalizeSpecPath } from "@kernel/spec-path.ts";
import { RunDeadlineExceededError } from "@kernel/run-deadline.ts";
import { MAX_ACCEPTANCE_EXECUTIONS } from "../../../shared-kernel/derive-cycle-backstop.ts";
import type { ExecutionPort, SkippedTest, ValidationPort } from "@contexts/test-execution/application/index.ts";
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
      /** The specs executed in this acceptance: every kept file. */
      executedSpecs: readonly string[];
      /** The execution's result; absent only when the regeneration changed no spec file. */
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
    }
  | { kind: "cap" };

export interface RegenerationAcceptanceDeps {
  snapshot: SuiteRestorePort;
  /** sha256 of the accepted bytes; injected so the service never imports node:crypto. */
  fingerprint: (bytes: Uint8Array) => string;
  /** Records one accepted file's proof (its path, the sha256 of its green bytes, and those bytes). */
  ledger: (entry: AcceptanceProofEntry) => Promise<void>;
  /** Reads the changed specs against the contract the primary pass fixed and records what moved. It judges nothing. Absent: no contract is observed. */
  observeContract?: (changedSpecFiles: readonly string[]) => Promise<void>;
}

export interface AcceptanceInput {
  specDir: string;
  /** The specs the regeneration changed or created, relative to the spec directory. */
  changedSpecFiles: readonly string[];
  /** The execution namespace: `${runId}-acc<n>`. */
  namespace: string;
  /** The pre-turn snapshot the caller took before sending the turn. */
  snapshot: SuiteRestorePoint;
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

    /* 1. The intent lock observes the changed specs; it never rejects them. */
    await this.deps.observeContract?.(input.changedSpecFiles);

    /* 2. Validate. */
    const validation = await input.validate(input.specDir);
    if (!validation.ok) {
      await restore();
      return { kind: "rejected", reason: validation.errors.length > 0 ? validation.errors.join("; ") : "validation failed" };
    }

    /* 3. Cap: a further execution is not started; the prior verdict and bytes stand, restored. */
    const executes = input.changedSpecFiles.length > 0;
    if (executes && this.executions >= MAX_ACCEPTANCE_EXECUTIONS) {
      await restore();
      return { kind: "cap" };
    }

    /* 4. Deadline: no time left before an execution is the run's deadline, never a silent skip. */
    if (executes) this.requireTime(input.deadline);

    /* 5. Execute every changed spec, once, under their own namespace: a pass an earlier call recorded says the bytes ran, not which cases they hold. */
    let execution: { verdict: RunVerdict; cases: readonly QaCase[]; logs: string } | undefined;
    let kept: readonly string[] = input.changedSpecFiles;
    let restored: readonly string[] = [];
    let executedSpecs: readonly string[] = input.changedSpecFiles;
    if (executes) {
      this.executions += 1;
      const result = await input.execute(input.specDir, { specFiles: [...input.changedSpecFiles], retries: 0, namespace: input.namespace });
      execution = { verdict: result.verdict, cases: result.cases, logs: result.logs };
      const failed = result.verdict !== "pass" && (!input.adoptFailures || result.verdict === "infra-error");
      /* 5b. A file that is still there and that the execution reported nothing of (no case, no skipped test) did not load and has no result to stand on, whatever the verdict; a deleted file has no case by nature. */
      const silent = failed ? [] : await this.silentFiles(input, result);
      if (failed || silent.length > 0) {
        const split =
          input.independentSpecs && result.verdict !== "infra-error"
            ? failed
              ? greenSpecFiles(input.changedSpecFiles, result)
              : standingSpecFiles(input.changedSpecFiles, silent)
            : undefined;
        if (!split) {
          await restore();
          return {
            kind: "rejected",
            reason: failed ? `execution ended ${result.verdict}` : `execution reported nothing of ${silent.join(", ")}`,
            execution,
          };
        }
        /* 5c. Per spec file: the files that do not stand get their pre-turn bytes back; the others stand on their own cases. */
        const back = new Map([...input.snapshot.files].filter(([file]) => split.restored.includes(file)));
        await this.deps.snapshot.restore(input.specDir, { files: back }, created.filter((file) => split.restored.includes(file)));
        ({ kept, restored } = split);
        executedSpecs = kept;
        const keptCases = result.cases.filter((c) => c.file !== undefined && kept.some((file) => sameSpec(file, c.file!)));
        execution = { verdict: failed ? "pass" : result.verdict, cases: keptCases, logs: result.logs };
      }
    }

    /* 6. Fingerprint the accepted bytes and record the proof ledger. Only green bytes get a proof: a fix-loop round may adopt a failing execution, but nothing may publish it. */
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

  /* The changed spec files that exist after the turn and that the execution reported nothing of: no case and no skipped test, so the file did not load. */
  private async silentFiles(input: AcceptanceInput, result: ReportedFiles): Promise<string[]> {
    const now = await this.deps.snapshot.snapshot(input.specDir, [...input.changedSpecFiles]);
    return input.changedSpecFiles.filter((file) => now.files.has(file) && !reports(file, result));
  }

  private requireTime(deadline: RunDeadlinePort): void {
    const left = deadline.remainingMs?.();
    if (left === undefined || left > 0) return;
    const described = deadline.describe?.();
    throw new RunDeadlineExceededError(described?.budgetMs ?? 0, described?.label ?? "unarmed", "acceptance", "before-turn");
  }
}

const sameSpec = (a: string, b: string): boolean => normalizeSpecPath(a) === normalizeSpecPath(b);

/* What an execution reported of its files: the cases that ran and the tests it says were skipped. */
type ReportedFiles = { cases: readonly QaCase[]; skippedTests?: readonly SkippedTest[] };

/* Whether the execution reported anything of `file`: a case, or a skipped test (a spec whose tests all skipped loaded and ran nothing). A file it reports nothing of did not load. */
const reports = (file: string, { cases, skippedTests }: ReportedFiles): boolean =>
  cases.some((c) => c.file !== undefined && sameSpec(file, c.file)) || (skippedTests ?? []).some((s) => s.file !== undefined && sameSpec(file, s.file));

/*
 * The changed spec files a failing execution leaves standing: those the execution reported, none of whose cases failed. Undefined when
 * the failure cannot be laid on spec files (a case that did not pass names no changed file, or no case failed at all) or when no file
 * is left standing: the regeneration is then rejected whole.
 */
function greenSpecFiles(changed: readonly string[], result: ReportedFiles): { kept: string[]; restored: string[] } | undefined {
  const { cases } = result;
  const failing = cases.filter((c) => c.status !== "pass");
  if (failing.length === 0 || failing.some((c) => c.file === undefined || !changed.some((file) => sameSpec(file, c.file!)))) return undefined;
  const green = (file: string): boolean => {
    return reports(file, result) && cases.filter((c) => c.file !== undefined && sameSpec(file, c.file)).every((c) => c.status === "pass");
  };
  const kept = changed.filter(green);
  if (kept.length === 0) return undefined;
  return { kept, restored: changed.filter((file) => !kept.includes(file)) };
}

/* The changed files left standing when only `silent` ones do not: undefined when none is left, and the regeneration is then rejected whole. */
function standingSpecFiles(changed: readonly string[], silent: readonly string[]): { kept: string[]; restored: string[] } | undefined {
  const kept = changed.filter((file) => !silent.includes(file));
  return kept.length === 0 ? undefined : { kept, restored: [...silent] };
}
