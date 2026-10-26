/*
 * Whether the response oracle's score can be read, per campaign variant, from the replicates of the campaign.
 *
 *   npm run fault-calibrate -- --campaign <id> [--out <file>]
 *
 * Groups the campaign's runs by variant, takes each run's per-use-case kill rates and counts (`gateSignals.valueByCandidate`, `valueStats`) and
 * gives each variant a verdict: calibrated when the kill rate of a use case holds still across replicates, few failures under corruption are the
 * flow breaking and enough of the suite was exposed (limits in objective-signal/domain/fault-calibration.ts). It gates nothing; a variant moves
 * toward enforce only after it passes. Reads the orchestrator's run history, so run it inside the orchestrator container.
 * Exit 0 for a report, 1 when the campaign has no run, 2 for a bad command line.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { calibrate, type Calibration, type CalibrationReplicate } from "@contexts/objective-signal/application/index.ts";
import { CAMPAIGN_ID_PATTERN } from "../src/contract/campaign.ts";

export type Parsed = { ok: true; campaign: string; out?: string } | { ok: false; problem: string };

export function parseArguments(argv: readonly string[]): Parsed {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a !== "--campaign" && a !== "--out") return { ok: false, problem: `error: unknown argument ${a}` };
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) return { ok: false, problem: `error: ${a} needs a value` };
    values[a] = v;
  }
  const campaign = values["--campaign"];
  if (campaign === undefined) return { ok: false, problem: "error: --campaign <id> is required" };
  if (!CAMPAIGN_ID_PATTERN.test(campaign)) return { ok: false, problem: "error: --campaign must be 1-100 characters of A-Z a-z 0-9 _ . : -" };
  return { ok: true, campaign, ...(values["--out"] !== undefined ? { out: values["--out"] } : {}) };
}

/* The part of the run history the script reads. */
export interface FaultCalibrationDeps {
  listRuns(campaignId: string): Array<{ id: string; variant: Record<string, string> }>;
  outcomeOf(runId: string): { gateSignals?: { valueByCandidate?: ReadonlyArray<{ candidateId: string; exposed: number; killed: number; ratio: number | null; unscored?: string }>; valueStats?: CalibrationReplicate["stats"] } } | undefined;
  out(line: string): void;
  writeText(path: string, text: string): void;
}

export interface VariantCalibration {
  variant: Record<string, string>;
  runs: number;
  calibration: Calibration;
}

const variantKey = (variant: Record<string, string>): string => JSON.stringify(Object.entries(variant).sort(([a], [b]) => a.localeCompare(b)));
const fixed = (v: number | null): string => (v === null ? "n/a" : v.toFixed(2));

export function calibrateCampaign(campaign: string, deps: Pick<FaultCalibrationDeps, "listRuns" | "outcomeOf">): VariantCalibration[] {
  const groups = new Map<string, { variant: Record<string, string>; replicates: CalibrationReplicate[]; runs: number }>();
  for (const run of deps.listRuns(campaign)) {
    const key = variantKey(run.variant);
    const group = groups.get(key) ?? { variant: run.variant, replicates: [], runs: 0 };
    group.runs++;
    const signals = deps.outcomeOf(run.id)?.gateSignals;
    group.replicates.push({ perCandidate: (signals?.valueByCandidate ?? []) as CalibrationReplicate["perCandidate"], stats: signals?.valueStats });
    groups.set(key, group);
  }
  return [...groups.values()].map((g) => ({ variant: g.variant, runs: g.runs, calibration: calibrate(g.replicates) }));
}

/** Returns the process exit code. */
export function main(argv: readonly string[], deps: FaultCalibrationDeps): number {
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    deps.out(parsed.problem);
    deps.out("usage: npm run fault-calibrate -- --campaign <id> [--out <file>]");
    return 2;
  }
  const variants = calibrateCampaign(parsed.campaign, deps);
  if (variants.length === 0) {
    deps.out(`error: the run history holds no run for campaign '${parsed.campaign}'`);
    return 1;
  }
  for (const v of variants) {
    const c = v.calibration;
    deps.out(`${JSON.stringify(v.variant)}  runs ${v.runs}  measured ${c.replicates}  ${c.verdict}`);
    deps.out(`  spread ${fixed(c.spread)}  flow-break share ${fixed(c.flowBreakShare)}  applicable share ${fixed(c.applicableShare)}`);
    for (const reason of c.reasons) deps.out(`  - ${reason}`);
  }
  if (parsed.out !== undefined) {
    deps.writeText(parsed.out, `${JSON.stringify({ campaign: parsed.campaign, variants }, null, 2)}\n`);
    deps.out(`[fault-calibrate] wrote ${parsed.out}`);
  }
  return 0;
}

/** The run history of the orchestrator container, imported lazily so a test that injects its own never opens it. */
export async function defaultDeps(): Promise<FaultCalibrationDeps> {
  const history = await import("../src/server/history.ts");
  const { getHistory } = await import("../src/server/persistence/index.ts");
  return {
    listRuns: (id) => history.listCampaignRuns(id),
    outcomeOf: (id) => getHistory().learning.getRunOutcome(id),
    out: (line) => console.log(line),
    writeText: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, "utf8");
    },
  };
}

/* Run as a script (not when imported by a test). */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  defaultDeps()
    .then((deps) => process.exit(main(process.argv.slice(2), deps)))
    .catch((err: unknown) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
