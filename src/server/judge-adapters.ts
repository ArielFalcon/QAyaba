/* The shell's SQLite side of the LLM-judge ports (docs/observability-design.md section 11.3): the attempt ledger, the calibration reports and the label pairs. */

import type { CalibrationPairsPort, CalibrationStorePort, JudgeAttempt, JudgeLedgerPort, JudgeOutcome, JudgePairs } from "@contexts/evaluation/application/index.ts";
import type { CalibrationReport } from "@contexts/evaluation/application/index";
import { parseJudgeGraderVersion, type JudgeName } from "@contexts/evaluation/application/index";
import { getHistory } from "./persistence/index";

const OUTCOMES: readonly string[] = ["scored", "unparseable", "not_applicable", "error"];

export class SqliteJudgeLedger implements JudgeLedgerPort {
  record(attempt: JudgeAttempt): void {
    getHistory().judges.insertJudgeAttempt(attempt);
  }

  lastOutcome(runId: string, judge: JudgeName, promptVersion: string): JudgeOutcome | undefined {
    const outcome = getHistory().judges.lastJudgeOutcome(runId, judge, promptVersion);
    return outcome !== undefined && OUTCOMES.includes(outcome) ? (outcome as JudgeOutcome) : undefined;
  }

  tokensUsedOn(day: string): number {
    return getHistory().judges.judgeTokensUsedOn(day);
  }

  /* The model that answered the judge's newest scored attempt of the prompt version: what a calibration must have been made for to still hold. */
  latestModel(judge: JudgeName, promptVersion: string): string | undefined {
    return getHistory().judges.latestJudgeModel(judge, promptVersion);
  }
}

export class SqliteCalibrationStore implements CalibrationStorePort {
  save(report: CalibrationReport): void {
    getHistory().judges.insertJudgeCalibration({
      judge: report.judge,
      promptVersion: report.promptVersion,
      model: report.model,
      trainN: report.splits.train.n,
      devN: report.splits.dev.n,
      testN: report.splits.test.n,
      tpr: report.tpr,
      tnr: report.tnr,
      agreement: report.agreement,
      status: report.status,
      report: JSON.stringify(report),
      computedAt: report.computedAt,
    });
  }

  latest(judge: JudgeName, promptVersion: string): CalibrationReport | undefined {
    const row = getHistory().judges.latestJudgeCalibration(judge, promptVersion);
    if (!row) return undefined;
    try {
      return JSON.parse(row.report) as CalibrationReport;
    } catch {
      /* A report that cannot be read is no calibration: the judge stays experimental. */
      console.error(`[judge] the stored calibration of ${judge}@${promptVersion} is unreadable; treating it as absent`);
      return undefined;
    }
  }
}

export class SqliteCalibrationPairs implements CalibrationPairsPort {
  pairsFor(judge: JudgeName): JudgePairs | undefined {
    const found = getHistory().judges.listJudgeLabelPairs(judge);
    if (!found) return undefined;
    const version = parseJudgeGraderVersion(found.graderVersion);
    if (!version) return undefined;
    return { graderVersion: found.graderVersion, promptVersion: version.promptVersion, model: found.model, pairs: found.pairs };
  }
}
