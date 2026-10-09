/* A code run detects the repository's ecosystem and its test command from files of its working copy, which the agent writes into: the manifest at the root (package.json) is read to choose between the test script and the test runner the dependencies name. A named pipe at that name would hold the whole single-threaded orchestrator for ever, a link would read a file outside the mirror into the choice, and a file of any size would fill its memory. The manifest is read strictly and under a cap; one that is not there or is not JSON is no manifest, as it always was, and one that is there and cannot be used is a refusal, said aloud with the reason of the module's own and nothing the file held: the project carries it, the command it falls back to is not the repository's, and a run or an install of it is infrastructure, never a pass. Every case runs against real files, links and pipes under os.tmpdir(); the pipe cases run under the watch of test/support/named-pipe-watch.ts. */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PACKAGE_JSON_BYTES, ManifestRefusal, detectCodeProject, realDetectDeps, runCodeTests, type CodeExecuteDeps, type CodeProject } from "@contexts/test-execution/infrastructure/code-execution.runner.ts";
import { setupCodeProject } from "@contexts/test-execution/infrastructure/code-setup.ts";
import { withoutWaitingOnNamedPipe } from "../../../support/named-pipe-watch.ts";

const SECRET_MARK = "SECRETv1-hunter2";
const MANIFEST = JSON.stringify({ name: "app", scripts: { test: "vitest run --silent" } });

function canMakeNamedPipes(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "qa-detect-fifo-probe-"));
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
const NO_MODE_RESTRICTIONS = process.platform === "win32" || process.getuid?.() === 0 ? "the account that runs the tests is not bound by file modes, so the cases that rely on them are not exercised" : false;

/* <tmp>/repo is the working copy; <tmp>/outside is what no read may reach. */
async function withRepo(run: (repo: string, outside: string) => Promise<void> | void): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "qa-detect-confined-"));
  const repo = join(tmp, "repo");
  const outside = join(tmp, "outside");
  mkdirSync(repo);
  mkdirSync(outside);
  try {
    await run(repo, outside);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* What the detection says on the way, which goes to logs. */
function capturing<T>(run: () => T): { value: T; warnings: string[] } {
  const warnings: string[] = [];
  const warn = mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  try {
    return { value: run(), warnings };
  } finally {
    warn.mock.restore();
  }
}

/* The test command of a repository whose package.json is `manifest`: the script it names when it has one, and `npm test` when it has no manifest to read. */
const commandOf = (repo: string): string => {
  const { test: command } = detectCodeProject(repo);
  return [command.cmd, ...command.args].join(" ");
};

test("a package.json is read as JSON, and the test script it names decides the command", async () => {
  await withRepo((repo) => {
    writeFileSync(join(repo, "package.json"), MANIFEST);

    const { value, warnings } = capturing(() => realDetectDeps.readJson(join(repo, "package.json")));

    assert.deepEqual(value, JSON.parse(MANIFEST));
    assert.deepEqual(warnings, []);
    assert.equal(commandOf(repo), "npm test");
  });
});

test("a package.json that is not there, or is not JSON, is no manifest and nothing to say as it was", async () => {
  await withRepo((repo) => {
    assert.equal(realDetectDeps.readJson(join(repo, "package.json")), null);
    writeFileSync(join(repo, "package.json"), "{ not json");

    const { value } = capturing(() => realDetectDeps.readJson(join(repo, "package.json")));

    assert.equal(value, null);
  });
});

/* What a manifest that was there and cannot be used comes to: a refusal with the module's reason, which is not the same as no manifest. */
const refusalOf = (value: unknown): string | undefined => (value instanceof ManifestRefusal ? value.reason : undefined);

test("a package.json that is a named pipe is not waited on: the manifest is refused, said once, and the project carries the refusal", { skip: NO_NAMED_PIPES, timeout: 60_000 }, async () => {
  await withRepo(async (repo) => {
    execFileSync("mkfifo", [join(repo, "package.json")]);

    const { value, warnings } = await withoutWaitingOnNamedPipe(join(repo, "package.json"), () => capturing(() => detectCodeProject(repo)));

    assert.equal(value.ecosystem, "node");
    assert.ok(value.manifestRefused !== undefined && value.manifestRefused.length > 0, "and says why");
    assert.equal(warnings.length, 1, "the refusal is said once");
    assert.ok(warnings[0]!.includes(join(repo, "package.json")), `and names the manifest: ${warnings[0]}`);
  });
});

test("a package.json that is a link is not read, whatever it points at, and nothing of the file behind it is in the command or the log", async () => {
  await withRepo((repo, outside) => {
    writeFileSync(join(outside, "package.json"), JSON.stringify({ name: SECRET_MARK, scripts: { test: `echo ${SECRET_MARK}` } }));
    symlinkSync(join(outside, "package.json"), join(repo, "package.json"));

    const { value, warnings } = capturing(() => realDetectDeps.readJson(join(repo, "package.json")));

    assert.ok(refusalOf(value), "the manifest is refused");
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0]!.includes(SECRET_MARK) && !warnings[0]!.includes(outside), "the warning says nothing of the file behind the link");
    assert.equal(commandOf(repo), "node --test", "and the script the file behind the link names did not decide the command");
    assert.ok(!refusalOf(value)!.includes(SECRET_MARK), "nor does the refusal");
  });
});

test("a package.json that is a directory is refused, and is said", async () => {
  await withRepo((repo) => {
    mkdirSync(join(repo, "package.json"));

    const { value, warnings } = capturing(() => realDetectDeps.readJson(join(repo, "package.json")));

    assert.ok(refusalOf(value));
    assert.equal(warnings.length, 1);
  });
});

test("a package.json that cannot be read is refused, said by the code of the failure and with the path of the manifest, and nothing else", { skip: NO_MODE_RESTRICTIONS }, async () => {
  await withRepo((repo) => {
    writeFileSync(join(repo, "package.json"), MANIFEST);
    chmodSync(join(repo, "package.json"), 0o000);
    try {
      const { value, warnings } = capturing(() => realDetectDeps.readJson(join(repo, "package.json")));

      assert.equal(refusalOf(value), "EACCES");
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0]!.includes(join(repo, "package.json")) && warnings[0]!.includes("EACCES"), warnings[0]);
    } finally {
      chmodSync(join(repo, "package.json"), 0o644);
    }
  });
});

test("a package.json of exactly the cap is read and one byte more is refused, whatever it holds", async () => {
  await withRepo((repo) => {
    const padded = (bytes: number): string => MANIFEST + " ".repeat(bytes - Buffer.byteLength(MANIFEST));
    writeFileSync(join(repo, "package.json"), padded(MAX_PACKAGE_JSON_BYTES));
    const exact = capturing(() => realDetectDeps.readJson(join(repo, "package.json")));
    writeFileSync(join(repo, "package.json"), padded(MAX_PACKAGE_JSON_BYTES + 1));
    const over = capturing(() => realDetectDeps.readJson(join(repo, "package.json")));

    assert.deepEqual(exact.value, JSON.parse(MANIFEST));
    assert.deepEqual(exact.warnings, []);
    assert.ok(refusalOf(over.value), "one byte more, and it is not read");
    assert.equal(over.warnings.length, 1);
  });
});

test("a project whose manifest is there and is read, or is not there, or is not JSON, carries no refusal: only a manifest that cannot be used does", async () => {
  await withRepo((repo) => {
    assert.equal(detectCodeProject(repo).manifestRefused, undefined, "no manifest at all");
    writeFileSync(join(repo, "package.json"), "{ not json");
    assert.equal(detectCodeProject(repo).manifestRefused, undefined, "a manifest that is not JSON is no manifest, as it was");
    writeFileSync(join(repo, "package.json"), MANIFEST);
    assert.equal(detectCodeProject(repo).manifestRefused, undefined, "and one that is read");
  });
});

/* A run cannot choose its test command from a manifest it cannot read, and the default it falls back to is not the repository's: a pass or a fail of it says nothing of the repository. */
const REFUSED_PROJECT: CodeProject = { ecosystem: "node", install: { cmd: "npm", args: ["install"] }, test: { cmd: "node", args: ["--test"] }, manifestRefused: "the file is a symbolic link or not a regular file" };

test("a code run whose manifest is refused is infrastructure, never a pass or a fail, and runs nothing", async () => {
  let ran = 0;
  const deps = { detect: () => REFUSED_PROJECT, runTests: async () => { ran += 1; return { exitCode: 0, logs: "ok", spawnError: undefined }; } } as unknown as CodeExecuteDeps;

  const run = await runCodeTests("/repo", { namespace: "ns" }, deps);

  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
  assert.equal(ran, 0, "the default command was not run in its place");
  assert.ok(run.logs.includes("package.json") && run.logs.includes(REFUSED_PROJECT.manifestRefused!), run.logs);
});

test("the setup of a code run whose manifest is refused fails aloud, with the manifest named and the reason, and installs nothing", async () => {
  let installs = 0;
  const deps = { detect: () => REFUSED_PROJECT, install: async () => { installs += 1; } };

  await assert.rejects(() => setupCodeProject("/repo", deps), (err: unknown) => err instanceof Error && err.message.includes(join("/repo", "package.json")) && err.message.includes(REFUSED_PROJECT.manifestRefused!));
  assert.equal(installs, 0);
});

test("the cap is far beyond any manifest", () => {
  assert.ok(MAX_PACKAGE_JSON_BYTES >= 256 * 1024 && MAX_PACKAGE_JSON_BYTES <= 16 * 1024 * 1024, `${MAX_PACKAGE_JSON_BYTES}`);
});
