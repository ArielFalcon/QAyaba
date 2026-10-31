/*
 * Whether an app may move to change-coverage `enforce` (ADR-0005): per app, the last three consecutive replicates of one campaign
 * case at one qayaba commit each had a trustworthy measurement with bundle mutation on.
 *
 *   npm run enforce-readiness -- [--app <app>] [--since <ISO date>]
 *
 * Reads the orchestrator's run history, so run it inside the orchestrator container, like funnel. Read-only: it prints an answer
 * and moves no app. A replicate that fails the trust test, or a new qayaba commit, restarts the count. Moving an app to `enforce`
 * stays the owner's act on its configuration; the engine refuses nothing.
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { REQUIRED_CONSECUTIVE_REPLICATES, enforceReadiness, type AppReadiness, type Replicate } from "../engine/src/contexts/objective-signal/application/index.ts";
import type { CampaignReplicateRow } from "../platform/persistence/repositories/run.repository.ts";

export type Parsed = { ok: true; app: string | undefined; since: string | undefined } | { ok: false; problem: string };

export function parseArguments(argv: readonly string[]): Parsed {
  let app: string | undefined;
  let since: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a !== "--app" && a !== "--since") return { ok: false, problem: `error: unknown argument ${a}` };
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) return { ok: false, problem: `error: ${a} needs a value` };
    if (a === "--app") app = v;
    else {
      if (Number.isNaN(Date.parse(v))) return { ok: false, problem: `error: --since '${v}' is not a date` };
      since = new Date(v).toISOString();
    }
  }
  return { ok: true, app, since };
}

const USAGE = [
  "usage: npm run enforce-readiness -- [--app <app>] [--since <ISO date>]",
  `  Per app: whether the last ${REQUIRED_CONSECUTIVE_REPLICATES} consecutive replicates of one campaign case at one qayaba commit had a trustworthy measurement with bundle mutation on.`,
  "  Run inside the orchestrator container: it reads the run history. It changes nothing.",
].join("\n");

export interface ReadinessDeps {
  replicates(opts: { app?: string; since?: string }): CampaignReplicateRow[] | Promise<CampaignReplicateRow[]>;
  out: (line: string) => void;
}

/* One case: one campaign, one tested commit and one variant, the variant's keys in a fixed order. */
const caseKeyOf = (row: CampaignReplicateRow): string =>
  `${row.campaignId} @${row.sha.slice(0, 7)} ${Object.entries(row.variant).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(",")}`.trimEnd();

export function replicateOf(row: CampaignReplicateRow): Replicate {
  return { runId: row.runId, app: row.app, caseKey: caseKeyOf(row), engineVersion: row.engineVersion, gateSignals: row.gateSignals };
}

function linesOf(app: AppReadiness): string[] {
  const lines = [`${app.app}  ${app.qualifies ? "QUALIFIES" : "does not qualify"} at ${app.engineVersion ?? "an unknown commit"}`];
  for (const c of app.cases) {
    const why = c.last ? `; latest ${c.last.runId}: ${c.last.reasons.join(", ")}` : "";
    lines.push(`  ${c.caseKey}  ${c.consecutive} of ${REQUIRED_CONSECUTIVE_REPLICATES} consecutive at ${c.engineVersion ?? "an unknown commit"} (${c.replicates} replicate(s))${why}`);
  }
  return lines;
}

/** Returns the process exit code. A bad argument prints the usage and returns 2; any answer returns 0. */
export async function main(argv: readonly string[], deps: ReadinessDeps): Promise<number> {
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    deps.out(parsed.problem);
    deps.out(USAGE);
    return 2;
  }
  const rows = await deps.replicates({ ...(parsed.app !== undefined ? { app: parsed.app } : {}), ...(parsed.since !== undefined ? { since: parsed.since } : {}) });
  if (rows.length === 0) {
    deps.out("no campaign replicates match");
    return 0;
  }
  for (const app of enforceReadiness(rows.map(replicateOf))) for (const line of linesOf(app)) deps.out(line);
  return 0;
}

/** The run history of the orchestrator container, imported lazily so a test that injects its own never opens it. */
export async function defaultDeps(): Promise<ReadinessDeps> {
  const { getHistory, historyDatabasePath } = await import("../platform/persistence/index.ts");
  /* Opening a history creates and migrates one that is not there: a read-only check refuses a missing one instead. */
  if (!existsSync(historyDatabasePath())) throw new Error(`no run history at ${historyDatabasePath()}`);
  return { replicates: (opts) => getHistory().runs.listCampaignReplicates(opts), out: (line) => console.log(line) };
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
