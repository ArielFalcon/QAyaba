/*
 * Reproducible agent-efficiency benchmark (design D14). A case names a real
 * commit of a real watched app — USER DATA (CLAUDE.md: "App-specificity
 * lives only in config/"), never engine code — so cases load from
 * config/benchmarks/efficiency-cases.json (gitignored), mirroring
 * coordination-benchmark.ts's own convention.
 * config/benchmarks/efficiency-cases.example.json ships tracked (task 5.4).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunMode, TestTarget } from "@kernel/run-mode.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function defaultEfficiencyBenchmarkCasesPath(): string {
  return join(ROOT, "config", "benchmarks", "efficiency-cases.json");
}

/** Shaped like the CLI's own run arguments (proposal §Scope). */
export interface EfficiencyBenchmarkCase {
  readonly name: string;
  readonly app: string;
  readonly sha: string;
  readonly baseSha?: string;
  readonly mode?: RunMode;
  readonly target?: TestTarget;
  readonly guidance?: string;
}

const RUN_MODES: ReadonlySet<string> = new Set<RunMode>(["diff", "complete", "exhaustive", "manual", "context"]);
const TEST_TARGETS: ReadonlySet<string> = new Set<TestTarget>(["e2e", "code"]);

function isEfficiencyBenchmarkCase(raw: unknown): raw is EfficiencyBenchmarkCase {
  if (typeof raw !== "object" || raw === null) return false;
  const c = raw as Partial<EfficiencyBenchmarkCase>;
  if (typeof c.name !== "string" || c.name.length === 0) return false;
  if (typeof c.app !== "string" || c.app.length === 0) return false;
  if (typeof c.sha !== "string" || c.sha.length === 0) return false;
  if (c.baseSha !== undefined && typeof c.baseSha !== "string") return false;
  if (c.mode !== undefined && !RUN_MODES.has(c.mode)) return false;
  if (c.target !== undefined && !TEST_TARGETS.has(c.target)) return false;
  if (c.guidance !== undefined && typeof c.guidance !== "string") return false;
  return true;
}

/**
 * Loads and form-validates the benchmark case set from a JSON file (defaults
 * to the gitignored config/benchmarks/efficiency-cases.json). Throws loudly
 * — a malformed or missing case file is a setup error the caller should see,
 * never a silent empty benchmark (spec: "Malformed case file fails loudly").
 */
export function loadEfficiencyBenchmarkCases(
  path: string = defaultEfficiencyBenchmarkCasesPath(),
): readonly EfficiencyBenchmarkCase[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `efficiency benchmark cases not found at ${path} — copy config/benchmarks/efficiency-cases.example.json to config/benchmarks/efficiency-cases.json and fill in real cases (app/sha/name) to run the benchmark: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isEfficiencyBenchmarkCase)) {
    throw new Error(
      `${path} must be a JSON array of EfficiencyBenchmarkCase objects (name/app/sha required; baseSha/mode/target/guidance optional)`,
    );
  }
  return parsed;
}
