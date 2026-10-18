import type { CalibrationPairsPort, CalibrationStorePort, JudgeAgentPort, JudgeAnswer, JudgeAttempt, JudgeEvidencePort, JudgeLedgerPort, JudgeOutcome, JudgePairs } from "@contexts/evaluation/application/ports/judge-ports.ts";
import type { CalibrationReport } from "@contexts/evaluation/domain/judge-calibration.ts";
import type { JudgeEvidence, JudgeName } from "@contexts/evaluation/domain/judges.ts";

export function judgeEvidence(over: Partial<JudgeEvidence> = {}): JudgeEvidence {
  return {
    runId: "run-1",
    mode: "diff",
    cancelled: false,
    verdict: "fail",
    errorClass: null,
    furthestPhase: "execute",
    diff: "diff --git a/src/a.ts b/src/a.ts\n+const a = 1;",
    specs: [{ path: "e2e/a.spec.ts", text: "test('a', async () => {});" }],
    failures: [{ name: "a works", message: "Timeout 5000ms exceeded" }],
    ...over,
  };
}

export class MemoryEvidence implements JudgeEvidencePort {
  constructor(private readonly runs: Record<string, JudgeEvidence | undefined>) {}
  load(runId: string): JudgeEvidence | undefined {
    return this.runs[runId];
  }
}

export class MemoryLedger implements JudgeLedgerPort {
  readonly attempts: JudgeAttempt[] = [];
  record(a: JudgeAttempt): void {
    this.attempts.push(a);
  }
  lastOutcome(runId: string, judge: JudgeName, promptVersion: string): JudgeOutcome | undefined {
    return this.attempts.filter((a) => a.runId === runId && a.judge === judge && a.promptVersion === promptVersion).at(-1)?.outcome;
  }
  tokensUsedOn(day: string): number {
    return this.attempts.filter((a) => a.at.startsWith(day)).reduce((sum, a) => sum + a.tokens, 0);
  }
}

/* An agent that answers from a script; `asked` records every prompt it received. */
export class ScriptedJudge implements JudgeAgentPort {
  readonly asked: string[] = [];
  constructor(private readonly answers: Array<JudgeAnswer | Error>) {}
  async ask(prompt: string): Promise<JudgeAnswer> {
    this.asked.push(prompt);
    const next = this.answers.shift();
    if (!next) throw new Error("no scripted answer left");
    if (next instanceof Error) throw next;
    return next;
  }
}

export const verdict = (v: string, critique = "because"): string => JSON.stringify({ verdict: v, critique });

export class MemoryPairs implements CalibrationPairsPort {
  constructor(private readonly byJudge: Partial<Record<JudgeName, JudgePairs>>) {}
  pairsFor(judge: JudgeName): JudgePairs | undefined {
    return this.byJudge[judge];
  }
}

export class MemoryCalibrations implements CalibrationStorePort {
  readonly reports: CalibrationReport[] = [];
  save(report: CalibrationReport): void {
    this.reports.push(report);
  }
  latest(judge: JudgeName, promptVersion: string): CalibrationReport | undefined {
    return this.reports.filter((r) => r.judge === judge && r.promptVersion === promptVersion).at(-1);
  }
}
