/*
 * The comparison report of a campaign (docs/observability-design.md section 12).
 *
 *   npm run campaign-report -- --campaign <id> [--baseline variant.<key>=<value> ...] [--out <dir>] [--seed <n>] [--iterations <n>]
 *
 * Reads the campaign's runs and their scores through the service's PUBLIC API (base URL and token from the environment, like the other
 * scripts), aggregates per variant and per score (mean, bootstrap 95% interval, n) and, against the baseline arm, the difference with its
 * interval. A difference is never called a lift with fewer than 3 replicates. Polarity comes from /evaluations/catalog. Writes markdown and
 * JSON; with no --out they go to stdout. (scripts/campaign-report.ts is the plain-agent campaign's record writer, a different tool.)
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CampaignRunsSchema, EvaluationCatalogSchema, RunEvaluationSchema, type CampaignRuns, type EvaluationCatalog,
} from "../qa-engine/src/shared-kernel/contract/commands.ts";
import {
  ComparisonError, compareCampaign, renderComparisonMarkdown, DEFAULT_BOOTSTRAP_ITERATIONS, DEFAULT_SEED,
  type CampaignComparison, type CampaignRun, type RunScore,
} from "@contexts/evaluation/domain/campaign-comparison.ts";
import { CAMPAIGN_ID_PATTERN } from "@kernel/campaign.ts";

export interface CompareArguments {
  campaign: string;
  baseline: Record<string, string>;
  out?: string;
  seed: number;
  iterations: number;
  baseUrl?: string;
}

export type ParsedArguments = ({ ok: true } & CompareArguments) | { ok: false; problem: string };

const VALUED = new Set(["--campaign", "--baseline", "--out", "--seed", "--iterations", "--base-url"]);
export const MAX_ITERATIONS = 100_000;

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const values = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (!VALUED.has(flag)) return { ok: false, problem: `error: unknown argument '${flag}'` };
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) return { ok: false, problem: `error: ${flag} needs a value` };
    values.set(flag, [...(values.get(flag) ?? []), value]);
  }
  const single = (flag: string): string | undefined => values.get(flag)?.at(-1);
  const campaign = single("--campaign");
  if (campaign === undefined) return { ok: false, problem: "error: --campaign <id> is required" };
  if (!CAMPAIGN_ID_PATTERN.test(campaign)) return { ok: false, problem: "error: --campaign must be 1-100 characters of A-Z a-z 0-9 _ . : -" };
  const baseline: Record<string, string> = {};
  for (const pair of values.get("--baseline") ?? []) {
    const m = /^variant\.([^=]+)=(.+)$/.exec(pair);
    if (!m) return { ok: false, problem: `error: --baseline takes variant.<key>=<value>, got '${pair}'` };
    if (Object.hasOwn(baseline, m[1]!)) return { ok: false, problem: `error: --baseline names variant.${m[1]} twice` };
    baseline[m[1]!] = m[2]!;
  }
  const whole = (flag: string, fallback: number, max: number): number | string => {
    const raw = single(flag);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= max ? n : `error: ${flag} takes a whole number from 1 to ${max}`;
  };
  const seed = whole("--seed", DEFAULT_SEED, 2 ** 32 - 1);
  const iterations = whole("--iterations", DEFAULT_BOOTSTRAP_ITERATIONS, MAX_ITERATIONS);
  if (typeof seed === "string") return { ok: false, problem: seed };
  if (typeof iterations === "string") return { ok: false, problem: iterations };
  return { ok: true, campaign, baseline, seed, iterations, ...(single("--out") !== undefined ? { out: single("--out")! } : {}), ...(single("--base-url") !== undefined ? { baseUrl: single("--base-url")! } : {}) };
}

export interface CompareDeps {
  /* GET a path of the service's API and return the parsed JSON; throws on a non-2xx answer. */
  get(path: string): Promise<unknown>;
  out(line: string): void;
  writeText(path: string, text: string): void;
}

/* A score `<base>.<suffix>` inherits its base's type and polarity (section 14): the catalog lists base names only. */
function catalogEntry(catalog: EvaluationCatalog, name: string): EvaluationCatalog["scores"][number] | undefined {
  const exact = catalog.scores.find((s) => s.name === name);
  if (exact) return exact;
  const dot = name.indexOf(".");
  if (dot < 1) return undefined;
  const base = catalog.scores.find((s) => s.name === name.slice(0, dot));
  return base?.suffixes?.includes(name.slice(dot + 1)) ? base : undefined;
}

const encode = encodeURIComponent;
const FETCH_CONCURRENCY = 8;

/* The campaign's graded runs with their scores, and the runs left out because they are not graded. */
export async function collectCampaign(campaignId: string, deps: Pick<CompareDeps, "get">): Promise<{ listing: CampaignRuns; runs: CampaignRun[]; ungraded: string[] }> {
  const listing = CampaignRunsSchema.parse(await deps.get(`/api/v1/campaigns/${encode(campaignId)}/runs`));
  const catalog = EvaluationCatalogSchema.parse(await deps.get("/api/v1/evaluations/catalog"));
  const graded = listing.runs.filter((r) => r.evaluationStatus === "complete");
  const ungraded = listing.runs.filter((r) => r.evaluationStatus !== "complete").map((r) => r.id);
  const runs: CampaignRun[] = new Array(graded.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < graded.length; i = next++) {
      const r = graded[i]!;
      /* The default view: the latest grader version per name. Human labels (graderVersion "human") only appear with versions=all, which this never asks for. */
      const evaluation = RunEvaluationSchema.parse(await deps.get(`/api/v1/runs/${encode(r.id)}/evaluation`));
      /* A judge is an opinion until it is calibrated against human labels: an experimental judge's score is never compared across arms. */
      const comparable = evaluation.scores.filter((s) => s.source !== "llm_judge" || catalogEntry(catalog, s.name)?.status === "calibrated");
      const scores: RunScore[] = comparable.map((s) => {
        const entry = catalogEntry(catalog, s.name);
        return { name: s.name, value: s.value, dataType: entry?.dataType ?? s.dataType, polarity: entry?.polarity ?? s.polarity, graderVersion: s.graderVersion };
      });
      runs[i] = { runId: r.id, variant: r.variant, replicate: r.replicate, scores };
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, graded.length) }, worker));
  return { listing, runs, ungraded };
}

export interface CompareReport {
  comparison: CampaignComparison;
  /* Every run the service holds for the campaign is done and graded. */
  complete: boolean;
  runsListed: number;
  runsCompared: number;
  ungraded: string[];
}

export async function runCompare(argv: readonly string[], deps: CompareDeps): Promise<number> {
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    deps.out(parsed.problem);
    return 2;
  }
  try {
    const { listing, runs, ungraded } = await collectCampaign(parsed.campaign, deps);
    if (listing.runs.length === 0) {
      deps.out(`error: the service holds no run for campaign '${parsed.campaign}'`);
      return 1;
    }
    const comparison = compareCampaign(runs, { campaignId: parsed.campaign, baseline: parsed.baseline, seed: parsed.seed, iterations: parsed.iterations });
    const report: CompareReport = { comparison, complete: listing.complete, runsListed: listing.runs.length, runsCompared: runs.length, ungraded };
    const markdown = renderComparisonMarkdown(comparison, { complete: listing.complete });
    if (ungraded.length > 0) deps.out(`warning: ${ungraded.length} run(s) are not graded yet and are left out: ${ungraded.slice(0, 5).join(", ")}${ungraded.length > 5 ? ", ..." : ""}`);
    if (parsed.out !== undefined) {
      deps.writeText(join(parsed.out, "comparison.md"), markdown);
      deps.writeText(join(parsed.out, "comparison.json"), `${JSON.stringify(report, null, 2)}\n`);
      deps.out(`[campaign-report] wrote ${join(parsed.out, "comparison.md")} and comparison.json`);
    } else {
      deps.out(markdown);
      deps.out(JSON.stringify(report, null, 2));
    }
    return 0;
  } catch (err) {
    deps.out(`error: ${err instanceof ComparisonError ? err.message : err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/* The service's API over HTTP: the base URL and token the other scripts use. */
export async function defaultDeps(env: Record<string, string | undefined> = process.env, baseUrl?: string): Promise<CompareDeps> {
  const { defaultService } = await import("./efficiency-benchmark.ts");
  const service = await defaultService(env);
  const root = (baseUrl ?? service.baseUrl).replace(/\/+$/, "");
  return {
    get: async (path) => {
      const res = await service.fetch(`${root}${path}`, { headers: service.token ? { Authorization: `Bearer ${service.token}` } : {} });
      if (!res.ok) throw new Error(`GET ${path} answered HTTP ${res.status}`);
      return res.json();
    },
    out: (line) => console.log(line),
    writeText: (path, text) => {
      mkdirSync(join(path, ".."), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      try {
        writeFileSync(temporary, text, "utf8");
        renameSync(temporary, path);
      } catch (err) {
        rmSync(temporary, { force: true });
        throw err;
      }
    },
  };
}

/* Run as a script (not when imported by a test). */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const parsed = parseArguments(argv);
  defaultDeps(process.env, parsed.ok ? parsed.baseUrl : undefined)
    .then((deps) => runCompare(argv, deps))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
