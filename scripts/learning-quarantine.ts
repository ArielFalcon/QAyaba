/*
 * One-shot, idempotent quarantine of the rules an app learned since a date.
 *
 *   npm run learning:quarantine -- --app <app> --since <ISO date> [--dry-run]
 *
 * A rule learned from a signal that later proved false (a gate that flagged correct code, a reflector that invented a
 * cause) keeps being injected into prompts and keeps being credited, so one bad lesson compounds. This marks every rule
 * of the app that is still in force (active or candidate) and was learned at or after `--since` as quarantined. It
 * deletes nothing: a quarantined rule stays in the ledger (`ledger-cli show` lists it), is never retrieved into a prompt
 * and is never credited an outcome, and `ledger-cli release <ruleId>` puts one back. Running it again marks nothing new;
 * a rule learned after the last run is marked by the next. `--dry-run` lists what would be marked and writes nothing.
 *
 * It writes the orchestrator's run history, so run it inside the orchestrator container, as the other operator scripts.
 * Nothing in the service calls it.
 */
import { pathToFileURL } from "node:url";
import { QuarantineLearnedRulesUseCase, type QuarantineReport } from "../qa-engine/src/contexts/cross-run-learning/application/quarantine-learned-rules.use-case.ts";
import type { LearningQuarantinePort } from "@contexts/cross-run-learning/application/index.ts";

export type Parsed = { ok: true; app: string; since: string; dryRun: boolean } | { ok: false; problem: string };

export function parseArguments(argv: readonly string[]): Parsed {
  const values: Record<string, string> = {};
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--app" || a === "--since") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { ok: false, problem: `error: ${a} needs a value` };
      values[a] = v;
    } else if (a === "--dry-run") dryRun = true;
    else return { ok: false, problem: `error: unknown argument ${a}` };
  }
  for (const required of ["--app", "--since"]) if (!values[required]?.trim()) return { ok: false, problem: `error: ${required} is required` };
  return { ok: true, app: values["--app"]!, since: values["--since"]!, dryRun };
}

const USAGE = [
  "usage: npm run learning:quarantine -- --app <app> --since <ISO date> [--dry-run]",
  "  Marks the rules <app> learned at or after <since> (and still in force) as quarantined: never retrieved into a prompt, never",
  "  credited, never deleted. Idempotent. --dry-run lists them and writes nothing. Run inside the orchestrator container.",
].join("\n");

export interface QuarantineDeps {
  repo: LearningQuarantinePort;
  now: () => Date;
  out: (line: string) => void;
}

const TRIGGER_PREVIEW_CHARS = 100;

function describe(report: QuarantineReport): string[] {
  const lines = report.matched.map((r) => `  ${r.id}  ${r.status}/${r.confidence}  ${r.errorClass}  learned ${r.at}  ${r.trigger.replace(/\s+/g, " ").slice(0, TRIGGER_PREVIEW_CHARS)}`);
  const window = `${report.app}, learned since ${report.since}`;
  const already = report.alreadyQuarantined > 0 ? `; ${report.alreadyQuarantined} already quarantined` : "";
  if (report.dryRun) return [...lines, `dry run: ${report.matched.length} rule(s) of ${window} would be quarantined${already}; nothing was written`];
  if (report.marked === 0) return [`nothing to quarantine for ${window}${already}`];
  return [...lines, `quarantined ${report.marked} rule(s) of ${window}${already}`];
}

/** Returns the process exit code. A bad argument prints the usage and returns 2; anything the command could not do throws. */
export async function main(argv: readonly string[], deps: QuarantineDeps): Promise<number> {
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    deps.out(parsed.problem);
    deps.out(USAGE);
    return 2;
  }
  const report = await new QuarantineLearnedRulesUseCase(deps.repo, deps.now).execute({ app: parsed.app, since: parsed.since, dryRun: parsed.dryRun });
  for (const line of describe(report)) deps.out(line);
  return 0;
}

/** The run history of the orchestrator container, imported lazily so a test that injects its own never opens it. */
export async function defaultDeps(): Promise<QuarantineDeps> {
  const { SqliteLearningRepository } = await import("../qa-engine/src/contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter.ts");
  const { historyLearningStore } = await import("../src/server/run-engine-factory.ts");
  return {
    /* The store is scoped by the app a call names, not by the one it was built for. */
    repo: new SqliteLearningRepository(historyLearningStore("")),
    now: () => new Date(),
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
