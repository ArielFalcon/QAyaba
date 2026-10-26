/* codeGraphFor: the graph of an app runs its engine in the launcher's graph profile and checks out only the files of the declared languages outside the app's exclusions. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChangeAnalysis, codeGraphFor } from "@contexts/change-analysis/composition/build-change-analysis.ts";
import type { ExecSandboxPort } from "../../../../src/shared-infrastructure/process-sandbox/exec-sandbox.ts";
import type { SandboxedBinaryRunner, SandboxedRunRequest } from "../../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";

const TREE = ["src/a.ts", "x/b.ts"].map((path, n) => `100644 blob ${String(n).repeat(40)}\t${path}\u0000`).join("");

function harness() {
  const work = mkdtempSync(join(tmpdir(), "code-graph-for-work-"));
  const data = mkdtempSync(join(tmpdir(), "code-graph-for-data-"));
  const spawned: { cmd: string; profile: string | undefined }[] = [];
  const checkedOut: string[][] = [];
  const exec = {
    isolated: false,
    workDir: () => work,
    allocDir: (prefix: string) => mkdtempSync(join(work, prefix)),
    writeScript: () => "",
    spawn: (cmd: string, _args: readonly string[], options: { profile?: string }) => {
      spawned.push({ cmd, profile: options.profile });
      return spawn(process.execPath, ["-e", ""], { cwd: work });
    },
  } as unknown as ExecSandboxPort;
  const git: SandboxedBinaryRunner = {
    run: async (req: SandboxedRunRequest) => {
      if (req.args.includes("checkout")) checkedOut.push(readFileSync(req.args[req.args.indexOf("--pathspec-from-file") + 1]!, "utf8").split("\u0000").filter(Boolean));
      return { exitCode: 0, stdout: req.args.includes("ls-tree") ? TREE : "", stderr: "", timedOut: false };
    },
  };
  const deps = { exec, git, dataDir: data, sandbox: null, processKill: { kill() {} } as never };
  return { deps, spawned, checkedOut, work };
}

test("the graph of an app checks out the declared languages' files outside the app's exclusions, and runs its engine in the graph profile", async () => {
  const { deps, spawned, checkedOut, work } = harness();

  await codeGraphFor(deps)("app-a", ["x/**"]).syncTo(work, "abc1234");

  assert.deepEqual(checkedOut, [["src/a.ts"]]);
  assert.ok(spawned.length > 0, "the engine ran");
  assert.deepEqual(new Set(spawned.map((s) => s.profile)), new Set(["graph"]));
});

test("an app with no exclusions checks out every file of the declared languages", async () => {
  const { deps, checkedOut, work } = harness();

  await codeGraphFor(deps)("app-b", []).syncTo(work, "abc1234");

  assert.deepEqual(checkedOut.map((paths) => [...paths].sort()), [["src/a.ts", "x/b.ts"]]);
});

test("each call builds its own graph, so the index one run built is never another run's", () => {
  const { deps } = harness();
  const build = codeGraphFor(deps);

  assert.notStrictEqual(build("app-a", []), build("app-a", []));
});

test("the change-analysis API serves the graph factory only when graph deps were supplied", () => {
  const { deps } = harness();
  const vcs = {} as never;

  assert.equal(buildChangeAnalysis({ vcs }).codeGraphFor, undefined);
  assert.equal(typeof buildChangeAnalysis({ vcs, graph: deps }).codeGraphFor, "function");
});
