/*
 * Calibrates an LLM judge against the human labels of the same runs and persists the report.
 *
 *   npm run judge-calibrate -- --judge <name> [--min-n 20]
 *
 * A judge (docs/observability-design.md section 11.3) is `experimental` until it earns `calibrated`: its newest scores are paired with
 * the human labels of the same runs (`npm run langfuse:labels` imports them as source=human), the pairs are split train/dev/test by a hash of
 * the run id, and only the TEST split decides. The judge is calibrated when its TPR and TNR both reach 0.8 there, with at least --min-n
 * labels (default 20) in each class. The report is saved to `judge_calibrations`; the status it earns shows in `GET /api/v1/evaluations/catalog`
 * and gates nothing. Run it again after more labels, a new prompt version or another model.
 *
 * It reads and writes the orchestrator's run history, so run it inside the orchestrator container, as the other operator scripts.
 * Exit 0 for a report (calibrated or not), 1 when the judge has no scores yet, 2 for a bad command line.
 */
import { pathToFileURL } from "node:url";
import type { CalibrateJudgeUseCase } from "../qa-engine/src/contexts/evaluation/application/calibrate-judge.use-case.ts";
import type { CalibrationReport } from "../qa-engine/src/contexts/evaluation/domain/judge-calibration.ts";
import { JUDGE_NAMES, isJudgeName, type JudgeName } from "../qa-engine/src/contexts/evaluation/domain/judges.ts";

export type Parsed = { ok: true; judge: JudgeName; minN?: number } | { ok: false; problem: string };

export function parseArguments(argv: readonly string[]): Parsed {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--judge" || a === "--min-n") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { ok: false, problem: `error: ${a} needs a value` };
      values[a] = v;
    } else return { ok: false, problem: `error: unknown argument ${a}` };
  }
  const judge = values["--judge"]?.trim();
  if (!judge) return { ok: false, problem: "error: --judge is required" };
  if (!isJudgeName(judge)) return { ok: false, problem: `error: unknown judge ${judge} (known: ${JUDGE_NAMES.join(", ")})` };
  let minN: number | undefined;
  if (values["--min-n"] !== undefined) {
    if (!/^[1-9]\d*$/.test(values["--min-n"])) return { ok: false, problem: `error: --min-n must be a positive whole number, got ${values["--min-n"]}` };
    minN = Number(values["--min-n"]);
  }
  return { ok: true, judge, ...(minN !== undefined ? { minN } : {}) };
}

const USAGE = [
  "usage: npm run judge-calibrate -- --judge <name> [--min-n 20]",
  `  Judges: ${JUDGE_NAMES.join(", ")}. Pairs the judge's newest scores with the human labels of the same runs, computes agreement, TPR and TNR on the`,
  "  test split, saves the report and prints it. Calibrated needs TPR and TNR >= 0.8 with --min-n labels in each class. Run inside the orchestrator container.",
].join("\n");

export interface CalibrateDeps {
  useCase: CalibrateJudgeUseCase;
  out: (line: string) => void;
}

const fixed = (v: number | null): string => (v === null ? "n/a" : v.toFixed(3));

function describe(r: CalibrationReport): string[] {
  const lines = [
    `${r.judge}  prompt version ${r.promptVersion}  model ${r.model}  computed ${r.computedAt}`,
    `splits (labelled pairs): train ${r.splits.train.n}, dev ${r.splits.dev.n}, test ${r.splits.test.n}`,
    `test split: TPR ${fixed(r.tpr)}  TNR ${fixed(r.tnr)}  agreement ${fixed(r.agreement)}`,
    `test labels per class: ${Object.entries(r.classCounts).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
    `thresholds: TPR >= ${r.thresholds.minTpr}, TNR >= ${r.thresholds.minTnr}, at least ${r.thresholds.minN} labels per class`,
  ];
  for (const c of r.perClass ?? []) lines.push(`  ${c.class}: n ${c.n}  TPR ${fixed(c.tpr)}  TNR ${fixed(c.tnr)}`);
  lines.push(`status: ${r.status}`);
  for (const reason of r.reasons) lines.push(`  - ${reason}`);
  return lines;
}

/** Returns the process exit code. */
export async function main(argv: readonly string[], deps: CalibrateDeps): Promise<number> {
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    deps.out(parsed.problem);
    deps.out(USAGE);
    return 2;
  }
  const result = deps.useCase.execute({ judge: parsed.judge, ...(parsed.minN !== undefined ? { minN: parsed.minN } : {}) });
  if (!result.ok) {
    deps.out(result.reason);
    return 1;
  }
  for (const line of describe(result.report)) deps.out(line);
  return 0;
}

/** The run history of the orchestrator container, imported lazily so a test that injects its own never opens it. */
export async function defaultDeps(): Promise<CalibrateDeps> {
  const { CalibrateJudgeUseCase } = await import("../qa-engine/src/contexts/evaluation/application/calibrate-judge.use-case.ts");
  const { SqliteCalibrationPairs, SqliteCalibrationStore } = await import("../src/server/judge-adapters.ts");
  return {
    useCase: new CalibrateJudgeUseCase({ pairs: new SqliteCalibrationPairs(), store: new SqliteCalibrationStore(), now: () => new Date().toISOString() }),
    out: (line) => console.log(line),
  };
}

/* Run as a script (not when imported by a test). */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  defaultDeps()
    .then((deps) => main(process.argv.slice(2), deps))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
