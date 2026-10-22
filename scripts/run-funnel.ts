/*
 * Where finished runs ended: how many stopped at each phase of the pipeline, with what verdict and error class.
 *
 *   npm run funnel -- [--app <app>] [--since <ISO date>]
 *
 * Reads the orchestrator's run history, so run it inside the orchestrator container, like probe-report. Read-only. A run
 * that recorded no phase (one older than the columns, or one cancelled before the engine reported) is listed as unknown.
 */
import { pathToFileURL } from "node:url";
import type { RunFunnelRow } from "../src/server/history.ts";

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
  "usage: npm run funnel -- [--app <app>] [--since <ISO date>]",
  "  Counts finished runs by the phase they got furthest into, their verdict and their error class.",
  "  Run inside the orchestrator container: it reads the run history.",
].join("\n");

export interface FunnelDeps {
  funnel(opts: { app?: string; since?: string }): RunFunnelRow[] | Promise<RunFunnelRow[]>;
  out: (line: string) => void;
}

function table(rows: readonly RunFunnelRow[]): string[] {
  const cells = rows.map((r) => [r.furthestPhase ?? "(unknown)", r.verdict ?? "-", r.errorClass ?? "-", String(r.count)]);
  const header = ["furthest phase", "verdict", "error class", "runs"];
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]) => c.map((v, i) => (i === 3 ? v.padStart(widths[i]!) : v.padEnd(widths[i]!))).join("  ").trimEnd();
  const total = rows.reduce((n, r) => n + r.count, 0);
  return [line(header), ...cells.map(line), line(["total", "", "", String(total)])];
}

/** Returns the process exit code. A bad argument prints the usage and returns 2. */
export async function main(argv: readonly string[], deps: FunnelDeps): Promise<number> {
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    deps.out(parsed.problem);
    deps.out(USAGE);
    return 2;
  }
  const rows = await deps.funnel({ ...(parsed.app !== undefined ? { app: parsed.app } : {}), ...(parsed.since !== undefined ? { since: parsed.since } : {}) });
  if (rows.length === 0) {
    deps.out("no finished runs match");
    return 0;
  }
  for (const line of table(rows)) deps.out(line);
  return 0;
}

/** The run history of the orchestrator container, imported lazily so a test that injects its own never opens it. */
export async function defaultDeps(): Promise<FunnelDeps> {
  const history = await import("../src/server/history.ts");
  return { funnel: (opts) => history.getRunFunnel(opts), out: (line) => console.log(line) };
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
