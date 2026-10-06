/* Expected values are the established behavior, built by hand — change them only with a deliberate behavior change, never to silence a failure. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { StrykerMutationOracleAdapter, type MutationOracleDeps } from "@contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";

const sha = Sha.of("abcdef1");
const br = BlastRadius.of(sha, ["src/svc.ts"]);

function mockSpawn(result: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: Error;
  createReport?: boolean;
}) {
  return (_cmd: string, _args: string[], opts: { cwd: string }): ChildProcess => {
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = { error: [], close: [] };
    const child = {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event: string, fn: (...args: unknown[]) => void) => {
        listeners[event] = listeners[event] ?? [];
        listeners[event]!.push(fn);
      },
      pid: 12345,
    } as unknown as ChildProcess;

    setTimeout(() => {
      if (result.error) {
        listeners["error"]?.forEach((fn) => fn(result.error!));
        return;
      }
      if (result.createReport) {
        const reportDir = join(opts.cwd, "reports", "mutation");
        mkdirSync(reportDir, { recursive: true });
        writeFileSync(
          join(reportDir, "mutation.json"),
          JSON.stringify({ metrics: { mutationScore: 75.5, killed: 151, totalMutants: 200 } }),
        );
      }
      listeners["close"]?.forEach((fn) => fn(result.exitCode ?? 0));
    }, 1);

    return child;
  };
}

function deps(overrides: Partial<MutationOracleDeps> = {}): MutationOracleDeps {
  return {
    spawn: mockSpawn({}),
    detectCodeProject: () => ({ ecosystem: "node", test: { cmd: "node", args: ["--test"] } }),
    scrubEnv: () => ({}),
    processKill: { killTree: () => {} },
    ...overrides,
  };
}

function tmpRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "mut-parity-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "index.ts"), "export const x = 1;");
  return repo;
}

test("a non-node project is not measured: no value score and null mutant counts", async () => {
  const repo = tmpRepo();
  try {
    const adapter = new StrykerMutationOracleAdapter(
      deps({ detectCodeProject: () => ({ ecosystem: "python", test: { cmd: "python3", args: ["-m", "pytest"] } }) }),
    );
    const r = await adapter.measure(br, repo, "qa-bot-abc");
    assert.equal(r.valueScore, null, "a non-node ecosystem yields no score");
    /* "Not measured" is null, never 0/0: a zero would read as "0 mutants killed", indistinguishable
       from a genuine measured zero. */
    assert.equal(r.mutantCount, null, "not measured must be null, never a fabricated zero mutant count");
    assert.equal(r.killedCount, null, "not measured must be null, never a fabricated zero killed count");
    assert.match(r.details, /not available/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a node project's Stryker report yields its mutation score as a ratio plus the killed and total mutant counts", async () => {
  const repo = tmpRepo();
  try {
    const adapter = new StrykerMutationOracleAdapter(deps({ spawn: mockSpawn({ exitCode: 0, createReport: true }) }));
    const r = await adapter.measure(br, repo, "qa-bot-abc");
    assert.equal(r.valueScore, 0.755, "the report's mutationScore (75.5) as a ratio");
    assert.equal(r.mutantCount, 200);
    assert.equal(r.killedCount, 151);
    assert.match(r.details, /151\/200/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a Stryker process that cannot start yields no value score and names the spawn failure", async () => {
  const repo = tmpRepo();
  try {
    const adapter = new StrykerMutationOracleAdapter(deps({ spawn: mockSpawn({ error: new Error("ENOENT: stryker not found") }) }));
    const r = await adapter.measure(br, repo, "qa-bot-abc");
    assert.equal(r.valueScore, null);
    assert.match(r.details, /spawn failed|ENOENT/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Stryker mutates only the blast radius's changed files, not the whole repo", async () => {
  const repo = tmpRepo();
  writeFileSync(join(repo, "src", "changed.ts"), "export const y = 2;");
  try {
    let seenMutate: string[] | undefined;
    const scopingSpawn = (_cmd: string, _args: string[], opts: { cwd: string }): ChildProcess => {
      const config = JSON.parse(readFileSync(join(opts.cwd, "stryker.conf.json"), "utf8")) as { mutate: string[] };
      seenMutate = config.mutate;
      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event: string, fn: (...args: unknown[]) => void) => {
          if (event === "close") setTimeout(() => fn(0), 1);
        },
        pid: 12345,
      } as unknown as ChildProcess;
    };
    const localBr = BlastRadius.of(sha, ["src/changed.ts"]);
    const adapter = new StrykerMutationOracleAdapter(deps({ spawn: scopingSpawn }));
    await adapter.measure(localBr, repo, "qa-bot-abc");
    assert.deepEqual(seenMutate, ["src/changed.ts"], "BlastRadius.changedFiles must scope the mutate targets, not the whole repo");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
