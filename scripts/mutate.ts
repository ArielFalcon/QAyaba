/*
 * Mutation-tests ONE critical module against ONLY the test files that exercise it (Stryker, command
 * runner, TypeScript checker). Each preset names the files to mutate — optionally narrowed to the
 * decision logic's line range as `file.ts:start-end` — and the test files that run per mutant, so a
 * run takes minutes, not the whole suite per mutant.
 *
 *   npm run mutate -- <preset>                  full run (every mutant against the preset's tests)
 *   npm run mutate -- <preset> --incremental    re-test only mutants whose source changed
 *   npm run mutate -- --list              the presets
 *   npm run mutate:keystone               the change-coverage keystone preset
 *
 * Incremental mode is opt-in: the command runner reports the whole test command as ONE test, so
 * Stryker cannot see a test-file change and reuses every earlier result — a strengthened test would
 * leave its survivors stale, and a weakened one would keep its kills. Use it only while editing the
 * mutated source itself.
 *
 * The Stryker config and the checker's tsconfig are generated under os.tmpdir(); the incremental
 * state and the JSON report live under reports/mutation/ (gitignored), the sandbox under
 * .stryker-tmp/ (gitignored). docs/testing-standards.md records each preset's baseline score and
 * `break` threshold: a preset fails its run when its score drops below its own `break`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_DIR = "reports/mutation";

export interface MutationThresholds {
  high: number;
  low: number;
  /* The run exits non-zero below this score; null = never fails the run. */
  break: number | null;
}

export interface MutationPreset {
  description: string;
  /* Repo-relative source files, optionally `path.ts:start-end` to mutate only a line range. */
  mutate: readonly string[];
  /* Repo-relative test files that run against every mutant: the module's own tests plus the seam
     tests of its direct consumers — never the whole suite. */
  tests: readonly string[];
  thresholds: MutationThresholds;
}

const OS = "qa-engine/src/contexts/objective-signal/domain";
const OS_TEST = "qa-engine/test/contexts/objective-signal/domain";
const LEARN = "qa-engine/src/contexts/cross-run-learning/domain";
const LEARN_TEST = "qa-engine/test/contexts/cross-run-learning/domain";
const ORCH = "qa-engine/src/contexts/qa-run-orchestration";
const ORCH_TEST = "qa-engine/test/contexts/qa-run-orchestration";
const PUB = "qa-engine/src/contexts/workspace-and-publication/domain";
const PUB_TEST = "qa-engine/test/contexts/workspace-and-publication/domain";

const DEFAULT_THRESHOLDS: MutationThresholds = { high: 90, low: 80, break: null };

export const PRESETS: Readonly<Record<string, MutationPreset>> = {
  keystone: {
    description: "change-coverage keystone: decide/blocks, changed-line assembly, coverage-gap prompt",
    mutate: [`${OS}/decide-coverage.service.ts`, `${OS}/assemble-change-coverage.ts`, `${OS}/render-coverage-gap.ts`],
    tests: [
      `${OS_TEST}/decide-coverage.service.test.ts`,
      `${OS_TEST}/assemble-change-coverage.test.ts`,
      `${OS_TEST}/render-coverage-gap.test.ts`,
      `${ORCH_TEST}/infrastructure/bridges/objective-signal-port.adapter.test.ts`,
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "rule-learning": {
    description: "cross-run learning: rule governance (promotion/demotion) and the outcome fold",
    mutate: [`${LEARN}/rule-governance.service.ts`, `${LEARN}/rule-fold.ts`],
    tests: [
      `${LEARN_TEST}/rule-governance.service.test.ts`,
      `${LEARN_TEST}/rule-fold.test.ts`,
      "qa-engine/test/contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter.test.ts",
      `${ORCH_TEST}/infrastructure/bridges/learning-port.adapter.test.ts`,
      "src/server/history.test.ts",
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "fix-loop": {
    description: "FixLoop aggregate: adjudicate → regen → re-execute, filtered-retry scope, regression guard",
    mutate: [`${ORCH}/domain/fix-loop.aggregate.ts`],
    tests: [
      `${ORCH_TEST}/domain/fix-loop.aggregate.test.ts`,
      `${ORCH_TEST}/domain/fix-loop-characterization.test.ts`,
      `${ORCH_TEST}/application/run-qa.use-case.test.ts`,
      `${ORCH_TEST}/application/coordination-fixloop.use-case.test.ts`,
      `${ORCH_TEST}/infrastructure/bridges/generation-port.adapter.test.ts`,
      "qa-engine/test/contract/coordination-seam.contract.test.ts",
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  coordination: {
    description: "coordination routing: pushback authority checks, delegation-failure class, orchestration router",
    mutate: [
      `${ORCH}/application/coordination/pushback.ts`,
      `${ORCH}/application/coordination/delegation-failure-class.ts`,
      `${ORCH}/application/coordination/orchestration-router.ts`,
    ],
    tests: [
      `${ORCH_TEST}/application/coordination-pushback.test.ts`,
      `${ORCH_TEST}/application/coordination-router.test.ts`,
      "qa-engine/test/contract/coordination-phases-5-14.contract.test.ts",
      "qa-engine/test/contract/coordination-disk-and-model.contract.test.ts",
      "qa-engine/test/contract/coordination-delegation.contract.test.ts",
      "qa-engine/test/contract/coordination-sidekick.contract.test.ts",
      "qa-engine/test/contract/coordination-seam.contract.test.ts",
      `${ORCH_TEST}/application/coordination-active.use-case.test.ts`,
      `${ORCH_TEST}/application/coordination-fixloop.use-case.test.ts`,
      "src/server/coordination-events.test.ts",
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "merge-guard": {
    description: "self-maintainer auto-merge gates: protected paths, change/rate limits",
    mutate: ["src/server/merge-guard.ts"],
    tests: ["src/server/merge-guard.test.ts", "src/server/maintainer-runtime.test.ts"],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "coordination-events": {
    description: "coordination telemetry ledger read model served to the API/TUI",
    mutate: ["src/server/coordination-events.ts"],
    tests: ["src/server/coordination-events.test.ts", "src/server/api.test.ts"],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "local-login": {
    description: "web console local-login policy: loopback peer/flag AND loopback-or-allowlisted Host header",
    mutate: ["src/server/auth.ts:86-171"],
    tests: ["src/server/auth.test.ts", "src/server/api.test.ts"],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "write-confinement": {
    description: "publication write confinement: which paths a publish may touch",
    mutate: [`${PUB}/write-confinement.service.ts`],
    tests: [
      `${PUB_TEST}/write-confinement.service.test.ts`,
      "qa-engine/test/contexts/workspace-and-publication/infrastructure/write-confinement.adapter.test.ts",
      "qa-engine/test/contexts/workspace-and-publication/infrastructure/vcs-write.adapter.test.ts",
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "run-decision": {
    description: "run decision: verdict → side effect (pr/issue/shadow-log/quarantine/none)",
    mutate: [`${ORCH}/domain/run-decision.service.ts`, `${ORCH}/domain/run-decision.ts`],
    tests: [
      `${ORCH_TEST}/domain/run-decision.service.test.ts`,
      `${ORCH_TEST}/domain/run-decision.test.ts`,
      `${ORCH_TEST}/domain/run-decision-parity.test.ts`,
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
};

/* Top-level entries never copied into the Stryker sandbox: build outputs, runtime data, the Go TUI,
   the web app and editor/agent state — none of them is read by a preset's tests. */
const SANDBOX_IGNORE = [
  "client",
  "web",
  "data",
  ".mirrors",
  ".omo",
  ".opencode",
  ".superpowers",
  ".sisyphus",
  ".idea",
  ".claude",
  ".atl",
  ".codegraph",
  ".qa-store",
  "qa-engine/.tsbuild",
  "reports",
];

export function sourcePathOf(entry: string): string {
  return entry.replace(/:\d+(-\d+)?$/, "");
}

export function testCommandFor(preset: MutationPreset): string {
  return `node --import ./test-setup.mjs --import tsx --test ${preset.tests.map((t) => JSON.stringify(t)).join(" ")}`;
}

/* The checker type-checks the mutated files (and what they import) with the options of the project
   they belong to; `references` are not inherited through `extends`, so this runs in single-project
   mode. allowImportingTsExtensions lets src/ files pull in qa-engine sources, which import with `.ts`.
   The file lives under os.tmpdir(), so typeRoots points back at the repo's @types. */
export function checkerTsconfigFor(preset: MutationPreset, root: string): object {
  const sources = preset.mutate.map(sourcePathOf);
  const inQaEngine = sources.every((s) => s.startsWith("qa-engine/"));
  return {
    extends: join(root, inQaEngine ? "qa-engine/tsconfig.json" : "tsconfig.json"),
    compilerOptions: {
      noEmit: true,
      composite: false,
      declaration: false,
      emitDeclarationOnly: false,
      allowImportingTsExtensions: true,
      typeRoots: [join(root, "node_modules", "@types")],
    },
    files: sources.map((s) => join(root, s)),
    include: [],
  };
}

export function strykerConfigFor(
  name: string,
  preset: MutationPreset,
  opts: { tsconfigFile: string; concurrency: number; incremental: boolean },
): object {
  return {
    packageManager: "npm",
    testRunner: "command",
    commandRunner: { command: testCommandFor(preset) },
    coverageAnalysis: "off",
    checkers: ["typescript"],
    tsconfigFile: opts.tsconfigFile,
    mutate: [...preset.mutate],
    incremental: opts.incremental,
    incrementalFile: `${REPORT_DIR}/${name}.incremental.json`,
    reporters: ["clear-text", "progress", "json"],
    jsonReporter: { fileName: `${REPORT_DIR}/${name}.json` },
    ignorePatterns: SANDBOX_IGNORE,
    thresholds: preset.thresholds,
    timeoutMS: 15000,
    concurrency: opts.concurrency,
  };
}

interface ReportMutant {
  status: string;
  mutatorName: string;
  replacement?: string;
  location: { start: { line: number; column: number } };
}

export interface MutationSummary {
  mutants: number;
  killed: number;
  survived: number;
  timeout: number;
  noCoverage: number;
  compileErrors: number;
  /* Mutants a `// Stryker disable` directive excludes — documented equivalent mutants. */
  ignored: number;
  /* (killed + timeout) / (killed + timeout + survived + noCoverage), in percent; null when nothing was valid. */
  score: number | null;
  survivors: string[];
}

export function summarize(report: { files: Record<string, { mutants: ReportMutant[] }> }): MutationSummary {
  const count = { Killed: 0, Survived: 0, Timeout: 0, NoCoverage: 0, CompileError: 0, Ignored: 0 } as Record<string, number>;
  const survivors: string[] = [];
  let mutants = 0;
  for (const [file, { mutants: list }] of Object.entries(report.files)) {
    for (const m of list) {
      mutants += 1;
      count[m.status] = (count[m.status] ?? 0) + 1;
      if (m.status === "Survived" || m.status === "NoCoverage") {
        const at = `${file}:${m.location.start.line}:${m.location.start.column}`;
        survivors.push(`${m.status.padEnd(10)} ${at}  ${m.mutatorName}  ${JSON.stringify(m.replacement ?? "")}`);
      }
    }
  }
  const killed = count.Killed ?? 0;
  const survived = count.Survived ?? 0;
  const timeout = count.Timeout ?? 0;
  const noCoverage = count.NoCoverage ?? 0;
  const valid = killed + timeout + survived + noCoverage;
  return {
    mutants,
    killed,
    survived,
    timeout,
    noCoverage,
    compileErrors: count.CompileError ?? 0,
    ignored: count.Ignored ?? 0,
    score: valid === 0 ? null : Math.round(((killed + timeout) / valid) * 10000) / 100,
    survivors,
  };
}

function usage(): string {
  const lines = Object.entries(PRESETS).map(([n, p]) => `  ${n.padEnd(20)} ${p.description}`);
  return `usage: npm run mutate -- <preset> [--incremental]\n\npresets:\n${lines.join("\n")}`;
}

export interface RunOptions {
  list: boolean;
  preset: string | undefined;
  /* Off unless asked for: see the incremental note at the top of this file. */
  incremental: boolean;
}

export function runOptionsFrom(argv: readonly string[]): RunOptions {
  return {
    list: argv.includes("--list"),
    preset: argv.find((a) => !a.startsWith("--")),
    incremental: argv.includes("--incremental"),
  };
}

function main(argv: string[]): number {
  const opts = runOptionsFrom(argv);
  if (opts.list) {
    console.log(usage());
    return 0;
  }
  const name = opts.preset;
  const preset = name === undefined ? undefined : PRESETS[name];
  if (name === undefined || preset === undefined) {
    console.error(name === undefined ? usage() : `unknown preset "${name}"\n\n${usage()}`);
    return 2;
  }

  const workDir = mkdtempSync(join(tmpdir(), `qayaba-mutate-${name}-`));
  try {
    const tsconfigFile = join(workDir, "tsconfig.json");
    writeFileSync(tsconfigFile, JSON.stringify(checkerTsconfigFor(preset, ROOT), null, 2));
    const configFile = join(workDir, "stryker.conf.json");
    const concurrency = Math.max(1, Math.min(8, availableParallelism() - 2));
    writeFileSync(
      configFile,
      JSON.stringify(strykerConfigFor(name, preset, { tsconfigFile, concurrency, incremental: opts.incremental }), null, 2),
    );

    const strykerArgs = ["run", configFile];
    const run = spawnSync(join(ROOT, "node_modules", ".bin", "stryker"), strykerArgs, { cwd: ROOT, stdio: "inherit" });
    if (run.error) throw run.error;

    const reportFile = join(ROOT, REPORT_DIR, `${name}.json`);
    if (existsSync(reportFile)) {
      const s = summarize(JSON.parse(readFileSync(reportFile, "utf8")));
      console.log(`\nmutate ${name}: ${s.mutants} mutants — killed ${s.killed}, survived ${s.survived}, timeout ${s.timeout}, no-coverage ${s.noCoverage}, compile-error ${s.compileErrors}, ignored ${s.ignored}, score ${s.score ?? "n/a"}%`);
      for (const line of s.survivors) console.log(`  ${line}`);
    }
    return run.status ?? 1;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
