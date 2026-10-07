/* The watch is what keeps a test of "this code does not wait on a pipe" from hanging when the code does, so it is proved here in a child process that is killed if it hangs: a broken watch fails this test, it does not hold the run. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withoutWaitingOnNamedPipe } from "./named-pipe-watch.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const WATCH_MODULE = pathToFileURL(join(HERE, "named-pipe-watch.ts")).href;

function canMakeNamedPipes(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "qa-pipe-watch-probe-"));
  try {
    execFileSync("mkfifo", [join(dir, "probe")]);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NO_NAMED_PIPES = canMakeNamedPipes() ? false : "mkfifo is not available on this platform, so the named-pipe watch is not exercised";

/* What the child does with a pipe: `read` opens it for reading, as code that waits on it would, and so blocks its thread until the watch releases it. */
const CHILD = `
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchNamedPipe } from ${JSON.stringify(WATCH_MODULE)};
const dir = mkdtempSync(join(tmpdir(), "qa-pipe-watch-child-"));
const pipe = join(dir, "pipe");
execFileSync("mkfifo", [pipe]);
const watch = watchNamedPipe(pipe);
if (process.argv[1] === "read") readFileSync(pipe);
console.log("seen=" + watch.stop());
rmSync(dir, { recursive: true, force: true });
`;

/* Runs the child; a child that does not finish (the watch did not release it) is killed, and that is the answer. */
function runChild(mode: "read" | "leave"): { hung: boolean; stdout: string } {
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", CHILD, mode], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  return { hung: run.error !== undefined || run.signal !== null, stdout: run.stdout };
}

test("a thread blocked opening a named pipe for reading is released by the watch, which says a reader was there", { skip: NO_NAMED_PIPES }, () => {
  const run = runChild("read");

  assert.equal(run.hung, false, "the watch did not release a reader that waits on a named pipe");
  assert.match(run.stdout, /seen=true/);
});

test("code that leaves a named pipe alone is not seen, and nothing is released", { skip: NO_NAMED_PIPES }, () => {
  const run = runChild("leave");

  assert.equal(run.hung, false);
  assert.match(run.stdout, /seen=false/);
});

test("a run that leaves the pipe alone returns what it returned, and one that throws throws the same error", { skip: NO_NAMED_PIPES }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-pipe-watch-run-"));
  try {
    const pipe = join(dir, "pipe");
    execFileSync("mkfifo", [pipe]);

    assert.equal(await withoutWaitingOnNamedPipe(pipe, () => 42), 42);
    assert.equal(await withoutWaitingOnNamedPipe(pipe, async () => "later"), "later");
    const failure = new Error("the code under test failed");
    await assert.rejects(withoutWaitingOnNamedPipe(pipe, () => { throw failure; }), (err: unknown) => err === failure);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
