/* The mutation oracle of a code run writes Stryker's config into the repository's working copy and reads Stryker's JSON report back from it, and Stryker runs the repository's tests, which the agent wrote: a link planted at the config's name would have the orchestrator overwrite a file of the agent's choosing with the config, and a named pipe, a link or a file of any size where the report is read back would hold the whole single-threaded orchestrator, put a file outside the mirror in the score or fill its memory. The config is written through a temporary file renamed over the target and the report is read strictly under a cap; a config that cannot be written leaves the run unmeasured without starting Stryker, and a report that cannot be used is a run that produced none. Both are signals only: the score stays null, never a fabricated zero. Every case runs against real files, links and pipes under os.tmpdir(); the pipe cases run under the watch of test/support/named-pipe-watch.ts. */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_MUTATION_REPORT_BYTES, StrykerMutationOracleAdapter, type MutationOracleDeps } from "@contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";
import { withoutWaitingOnNamedPipe } from "../../../support/named-pipe-watch.ts";

const br = BlastRadius.of(Sha.of("abcdef1"), ["src/svc.ts"]);
const GOOD_REPORT = JSON.stringify({ metrics: { mutationScore: 75.5, killed: 151, totalMutants: 200 } });
const PRECIOUS = "PRECIOUS: no step may overwrite this\n";

function canMakeNamedPipes(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "qa-stryker-fifo-probe-"));
  try {
    execFileSync("mkfifo", [join(dir, "probe")]);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NO_NAMED_PIPES = canMakeNamedPipes() ? false : "mkfifo is not available on this platform, so the named-pipe cases are not exercised";

/* <tmp>/repo is the working copy of the code run; <tmp>/outside is what no step may reach. */
interface Fixture {
  tmp: string;
  repo: string;
  outside: string;
}

async function withFixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "qa-stryker-confined-"));
  const repo = join(tmp, "repo");
  const outside = join(tmp, "outside");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(repo, "src", "svc.ts"), "export const x = 1;\n");
  writeFileSync(join(outside, "victim.txt"), PRECIOUS);
  try {
    await run({ tmp, repo, outside });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* A Stryker that, when it ends, has left whatever `leave` makes in the working copy. */
function strykerThat(leave: (cwd: string) => void): { deps: MutationOracleDeps; started: () => number } {
  let started = 0;
  const spawn = (_cmd: string, _args: string[], opts: { cwd: string }): ChildProcess => {
    started += 1;
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const child = {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event: string, fn: (...args: unknown[]) => void) => {
        (listeners[event] ??= []).push(fn);
      },
      pid: 12345,
    } as unknown as ChildProcess;
    setTimeout(() => {
      leave(opts.cwd);
      listeners["close"]?.forEach((fn) => fn(0));
    }, 1);
    return child;
  };
  return {
    deps: { spawn, detectCodeProject: () => ({ ecosystem: "node", test: { cmd: "node", args: ["--test"] } }), scrubEnv: () => ({}), processKill: { killTree: () => {} } },
    started: () => started,
  };
}

const writeReport = (cwd: string, text: string = GOOD_REPORT): void => {
  mkdirSync(join(cwd, "reports", "mutation"), { recursive: true });
  writeFileSync(join(cwd, "reports", "mutation", "mutation.json"), text);
};

const measure = (deps: MutationOracleDeps, f: Fixture) => new StrykerMutationOracleAdapter(deps).measure(br, f.repo, "qa-bot-abc");

/* What the oracle says on the way, which goes to logs. */
async function measuring(deps: MutationOracleDeps, f: Fixture, around: <T>(run: () => Promise<T>) => Promise<T> = (run) => run()): Promise<{ result: Awaited<ReturnType<typeof measure>>; warnings: string[] }> {
  const warnings: string[] = [];
  const warn = mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  try {
    return { result: await around(() => measure(deps, f)), warnings };
  } finally {
    warn.mock.restore();
  }
}

test("a stryker.conf.json that is a link is not written through: the file it points at is as it was, Stryker is not started and the run is unmeasured", async () => {
  await withFixture(async (f) => {
    symlinkSync(join(f.outside, "victim.txt"), join(f.repo, "stryker.conf.json"));
    const stryker = strykerThat(writeReport);

    const result = await measure(stryker.deps, f);

    assert.equal(readFileSync(join(f.outside, "victim.txt"), "utf8"), PRECIOUS, "the file behind the link was not overwritten");
    assert.equal(stryker.started(), 0, "and Stryker was not run with a config nobody wrote");
    assert.equal(result.valueScore, null);
    assert.equal(result.mutantCount, null);
    assert.match(result.details, /failed to write Stryker config/);
  });
});

test("a stryker.conf.json that is a link to nothing is not created through either", async () => {
  await withFixture(async (f) => {
    symlinkSync(join(f.outside, "created-by-the-orchestrator.json"), join(f.repo, "stryker.conf.json"));

    const result = await measure(strykerThat(writeReport).deps, f);

    assert.equal(existsSync(join(f.outside, "created-by-the-orchestrator.json")), false);
    assert.equal(result.valueScore, null);
  });
});

test("an ordinary stryker.conf.json is replaced whole, and an ordinary run still scores", async () => {
  await withFixture(async (f) => {
    writeFileSync(join(f.repo, "stryker.conf.json"), "{ the repo's own config, which a run replaces }");
    let seen = "";

    const result = await measure(strykerThat((cwd) => { seen = readFileSync(join(cwd, "stryker.conf.json"), "utf8"); writeReport(cwd); }).deps, f);

    assert.ok(seen.startsWith("{\n"), "the config the run was given is the orchestrator's");
    assert.equal(result.valueScore, 0.755);
    assert.equal(existsSync(join(f.repo, "stryker.conf.json")), false, "and it is cleaned up after the run");
  });
});

test("a report that is a named pipe is not waited on: the run produced no parseable report, and the score is unknown", { skip: NO_NAMED_PIPES, timeout: 60_000 }, async () => {
  await withFixture(async (f) => {
    const pipe = join(f.repo, "reports", "mutation", "mutation.json");
    const stryker = strykerThat((cwd) => { mkdirSync(join(cwd, "reports", "mutation"), { recursive: true }); execFileSync("mkfifo", [pipe]); });

    const { result, warnings } = await measuring(stryker.deps, f, (run) => withoutWaitingOnNamedPipe(pipe, run));

    assert.equal(result.valueScore, null);
    assert.equal(result.mutantCount, null);
    assert.match(result.details, /no parseable report/);
    assert.equal(warnings.length, 1, "and the refusal is said once");
    assert.match(warnings[0]!, /\([^)]+\)/, "with the reason");
  });
});

test("a report that is a link is not read, whatever it points at: a good report the tests wrote elsewhere is not the run's", async () => {
  await withFixture(async (f) => {
    writeFileSync(join(f.outside, "forged.json"), GOOD_REPORT);
    const stryker = strykerThat((cwd) => { mkdirSync(join(cwd, "reports", "mutation"), { recursive: true }); symlinkSync(join(f.outside, "forged.json"), join(cwd, "reports", "mutation", "mutation.json")); });

    const { result, warnings } = await measuring(stryker.deps, f);

    assert.equal(result.valueScore, null);
    assert.match(result.details, /no parseable report/);
    assert.equal(warnings.length, 1, "the refusal is said once");
    assert.match(warnings[0]!, /\([^)]+\)/, "with the reason");
    assert.ok(!warnings[0]!.includes("forged") && !warnings[0]!.includes("mutationScore"), "naming nothing of where the link points and quoting nothing of the file");
    assert.equal(readFileSync(join(f.outside, "forged.json"), "utf8"), GOOD_REPORT, "and the file behind it is as it was");
  });
});

test("a reports directory that is a link is not read through, and cleaning up removes the link and nothing behind it", async () => {
  await withFixture(async (f) => {
    mkdirSync(join(f.outside, "elsewhere", "mutation"), { recursive: true });
    writeFileSync(join(f.outside, "elsewhere", "mutation", "mutation.json"), GOOD_REPORT);
    const stryker = strykerThat((cwd) => symlinkSync(join(f.outside, "elsewhere"), join(cwd, "reports")));

    const result = await measure(stryker.deps, f);

    assert.equal(result.valueScore, null);
    assert.equal(readFileSync(join(f.outside, "elsewhere", "mutation", "mutation.json"), "utf8"), GOOD_REPORT, "what the link pointed at is not deleted");
    assert.equal(existsSync(join(f.repo, "reports")), false, "and the link itself is gone");
  });
});

/* Valid JSON all the way (the report and then whitespace), so that nothing but its size can keep it from being read. */
const writePaddedReport = (cwd: string, bytes: number): void => {
  mkdirSync(join(cwd, "reports", "mutation"), { recursive: true });
  const fd = openSync(join(cwd, "reports", "mutation", "mutation.json"), "w");
  try {
    writeSync(fd, GOOD_REPORT);
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    for (let written = Buffer.byteLength(GOOD_REPORT); written < bytes; written += chunk.length) writeSync(fd, chunk, 0, Math.min(chunk.length, bytes - written));
  } finally {
    closeSync(fd);
  }
};

test("a report of exactly the cap is read and one byte more is not, whatever it holds", async () => {
  await withFixture(async (f) => {
    const exact = await measure(strykerThat((cwd) => writePaddedReport(cwd, MAX_MUTATION_REPORT_BYTES)).deps, f);
    const over = await measure(strykerThat((cwd) => writePaddedReport(cwd, MAX_MUTATION_REPORT_BYTES + 1)).deps, f);

    assert.equal(exact.valueScore, 0.755, "a report of exactly the cap is the report");
    assert.equal(over.valueScore, null, "one byte more is not read");
    assert.match(over.details, /no parseable report/);
  });
});

test("a report far past the cap is refused without being read: a sparse file of four times the cap costs nothing", async () => {
  await withFixture(async (f) => {
    const result = await measure(strykerThat((cwd) => {
      mkdirSync(join(cwd, "reports", "mutation"), { recursive: true });
      const path = join(cwd, "reports", "mutation", "mutation.json");
      writeFileSync(path, "");
      truncateSync(path, MAX_MUTATION_REPORT_BYTES * 4);
    }).deps, f);

    assert.equal(result.valueScore, null);
  });
});

test("a report that is no JSON, or lacks a metric, or holds one that is no number, is a run with no score, as it was", async () => {
  await withFixture(async (f) => {
    const whole = { mutationScore: 75.5, killed: 151, totalMutants: 200 };
    const reports = [
      "{ not json",
      "null",
      JSON.stringify({}),
      JSON.stringify({ metrics: {} }),
      JSON.stringify({ metrics: { ...whole, mutationScore: undefined } }),
      JSON.stringify({ metrics: { ...whole, killed: undefined } }),
      JSON.stringify({ metrics: { ...whole, totalMutants: undefined } }),
      JSON.stringify({ metrics: { ...whole, mutationScore: "75.5" } }),
      JSON.stringify({ metrics: { ...whole, killed: "151" } }),
      JSON.stringify({ metrics: { ...whole, totalMutants: "200" } }),
    ];
    for (const report of reports) {
      const result = await measure(strykerThat((cwd) => writeReport(cwd, report)).deps, f);

      assert.equal(result.valueScore, null, report);
      assert.equal(result.mutantCount, null, report);
    }
    assert.equal((await measure(strykerThat((cwd) => writeReport(cwd, JSON.stringify({ metrics: whole }))).deps, f)).valueScore, 0.755, "and the report with all three is the score");
  });
});

test("the cap a report is read under holds the report of a run of tens of thousands of mutants and no more than a parse in the orchestrator's one thread can take", () => {
  const MIB = 1024 * 1024;
  /* Stryker writes some 250 bytes for each mutant and the source of each file it mutated: 20,000 mutants, which no run of ten minutes reaches, are about 5 MB. A document of nothing but empty arrays costs some fifteen times its size in heap and a second of parse for every 12 MiB (128 MiB of it took 11 s and 2 GiB). */
  assert.ok(MAX_MUTATION_REPORT_BYTES >= 8 * MIB && MAX_MUTATION_REPORT_BYTES <= 16 * MIB, `${MAX_MUTATION_REPORT_BYTES} bytes`);
});
