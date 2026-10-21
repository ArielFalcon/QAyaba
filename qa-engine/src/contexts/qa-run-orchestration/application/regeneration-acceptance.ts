/*
 * The one application service every regeneration site shares (static-fix, fix-loop,
 * reviewer-correction, coverage): accept or reject the specs a regeneration changed. A regeneration
 * is accepted only after it validates and its changed specs execute green (or reuse a proof), and the
 * green bytes are fingerprinted into the run's proof ledger; a regeneration that is not accepted has
 * its pre-turn bytes restored and the files its turn created removed, so the bytes on disk always
 * equal the last bytes that executed green. Built once per run; the run's own counter caps how many
 * acceptance executions one run spends, and the run's deadline bounds each of them.
 */
import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { RunDeadlineExceededError } from "@kernel/run-deadline.ts";
import { MAX_ACCEPTANCE_EXECUTIONS } from "../domain/helpers/derive-cycle-backstop.ts";
import type { ClosedLoopHandle, ExecutionPort, RunDeadlinePort, ValidationPort } from "./ports/index.ts";
import type { SpecSnapshot, SpecSnapshotPort } from "./ports/spec-snapshot.port.ts";

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
    }
  | { kind: "rejected"; reason: string }
  | { kind: "cap" };

export interface RegenerationAcceptanceDeps {
  snapshot: SpecSnapshotPort;
  /** sha256 of the accepted bytes; injected so the service never imports node:crypto. */
  fingerprint: (bytes: Uint8Array) => string;
  /** Records one accepted file's proof (its path, the sha256 of its green bytes, and those bytes). */
  ledger: (entry: AcceptanceProofEntry) => Promise<void>;
  /** The intent-lock contract check (a later task). Absent: always passes. */
  contractCheck?: (changedSpecFiles: readonly string[]) => Promise<{ ok: boolean; reason?: string }>;
}

export interface AcceptanceInput {
  specDir: string;
  /** The specs the regeneration changed or created, relative to the spec directory. */
  changedSpecFiles: readonly string[];
  /** The execution namespace: `${runId}-acc<n>`. */
  namespace: string;
  /** The pre-turn snapshot the caller took before sending the turn. */
  snapshot: SpecSnapshot;
  /** The proof source: a changed file whose current bytes `isClosed([file])` is not executed. Absent: every change is executed. */
  closedLoop?: Pick<ClosedLoopHandle, "isClosed">;
  /** No time left: an execution that would start throws the run's deadline error. */
  deadline: RunDeadlinePort;
  validate: ValidationPort["validate"];
  execute: ExecutionPort["execute"];
}

export class RegenerationAcceptance {
  private executions = 0;

  constructor(private readonly deps: RegenerationAcceptanceDeps) {}

  /** Before the turn: capture the pre-turn bytes of the specs the regeneration may touch. */
  snapshot(specDir: string, specFiles: readonly string[]): Promise<SpecSnapshot> {
    return this.deps.snapshot.snapshot(specDir, specFiles);
  }

  /** After the turn finished (the caller reports it, so no session can still write): accept or reject the changed specs. */
  async accept(input: AcceptanceInput): Promise<AcceptanceOutcome> {
    const created = input.changedSpecFiles.filter((file) => !input.snapshot.files.has(file));
    const restore = (): Promise<void> => this.deps.snapshot.restore(input.specDir, input.snapshot, created);

    /* 1. Contract check (the intent lock, a later task): absent means it passes. */
    const contract = await this.deps.contractCheck?.(input.changedSpecFiles);
    if (contract && !contract.ok) {
      await restore();
      return { kind: "rejected", reason: contract.reason ?? "the contract check rejected the change" };
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
    if (toExecute.length > 0) {
      this.executions += 1;
      const result = await input.execute(input.specDir, { specFiles: toExecute, retries: 0, namespace: input.namespace });
      if (result.verdict !== "pass") {
        await restore();
        return { kind: "rejected", reason: `execution ended ${result.verdict}` };
      }
      execution = { verdict: result.verdict, cases: result.cases, logs: result.logs };
    }

    /* 7. Fingerprint the accepted bytes and record the proof ledger. */
    const accepted = await this.deps.snapshot.snapshot(input.specDir, [...input.changedSpecFiles]);
    const proof: AcceptanceProofEntry[] = [];
    for (const file of input.changedSpecFiles) {
      const bytes = accepted.files.get(file);
      if (bytes !== undefined) proof.push({ file, sha256: this.deps.fingerprint(bytes), bytes });
    }
    for (const entry of proof) await this.deps.ledger(entry);

    return {
      kind: "accepted",
      executedSpecs: toExecute,
      ...(execution ? { execution } : {}),
      proof,
    };
  }

  private requireTime(deadline: RunDeadlinePort): void {
    const left = deadline.remainingMs?.();
    if (left === undefined || left > 0) return;
    const described = deadline.describe?.();
    throw new RunDeadlineExceededError(described?.budgetMs ?? 0, described?.label ?? "unarmed", "acceptance", "before-turn");
  }
}
