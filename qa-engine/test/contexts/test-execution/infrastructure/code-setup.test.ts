/* qa-engine/test/contexts/test-execution/infrastructure/code-setup.test.ts
   Behavioral tests for the code-mode install step, moved from src/qa/code-runner.test.ts
   file; only the import path changes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { setupCodeProject, createDefaultCodeSetupDeps, type CodeSetupDeps } from "@contexts/test-execution/infrastructure/code-setup.ts";
import type { CodeProject } from "@contexts/test-execution/infrastructure/code-execution.runner.ts";
import { REDACTED } from "@kernel/ports/redaction.port.ts";

/* A hung `npm ci`/`mvn`/`gradle` install must NOT block the sequential queue forever.
   The install path needs the same timeout the test path has.
 */
test("code-mode install that hangs is killed by timeout (does not block the queue)", { timeout: 3000 }, async () => {
  const project: CodeProject = { ecosystem: "node", install: { cmd: "npm", args: ["ci"] }, test: { cmd: "npm", args: ["test"] } };
  const deps: CodeSetupDeps = { detect: () => project, install: () => new Promise(() => {}) }; /* never resolves */
  await assert.rejects(() => setupCodeProject("/r", deps, { timeoutMs: 100 }), /timeout/i);
});

test("setupCodeProject runs install only when there is an install command", async () => {
  let installed = 0;
  const project: CodeProject = { ecosystem: "node", install: { cmd: "npm", args: ["ci"] }, test: { cmd: "npm", args: ["test"] } };
  const deps: CodeSetupDeps = { detect: () => project, install: async () => { installed++; } };
  await setupCodeProject("/r", deps);
  assert.equal(installed, 1);

  const noInstall: CodeSetupDeps = {
    detect: () => ({ ecosystem: "rust", install: null, test: { cmd: "cargo", args: ["test"] } }),
    install: async () => { installed++; },
  };
  await setupCodeProject("/r", noInstall);
  assert.equal(installed, 1);
});

test("setupCodeProject prepares the sandbox workdir even for a null-install ecosystem (before the early return)", async () => {
  /* Maven/Gradle/Rust have no install step, but their FIRST untrusted spawn is the test —
     so the chown-to-sandbox must still run for them. prepareWorkdir must fire before install-null returns.
   */
  const prepared: string[] = [];
  const deps: CodeSetupDeps = {
    detect: () => ({ ecosystem: "maven", install: null, test: { cmd: "mvn", args: ["-B", "test"] } }),
    install: async () => { throw new Error("install must not run for a null-install project"); },
    prepareWorkdir: (repoDir) => prepared.push(repoDir),
  };
  await setupCodeProject("/work/repo", deps);
  assert.deepEqual(prepared, ["/work/repo"]);
});

/* Behavioral tests over the REAL spawning install (createDefaultCodeSetupDeps), the actual
   process boundary — matching the pattern established for SandboxedBinaryRunnerAdapter in
   process-sandbox/sandboxed-binary-runner.adapter.test.ts (process.execPath as a controlled
   fake "install" command, no PATH lookup surprises, no real npm needed).

   Before this fix, a failed install reported ONLY `exit ${code}` — the child's own stdout/stderr
   were spawned as unread pipes, so the actual npm/pip/... error (dependency conflict, network
   failure, EACCES, ...) was silently discarded, and an install writing enough output could block
   on a full, unread pipe buffer instead of finishing.
 */
test("a failed install surfaces a sanitized, bounded tail of the child's output instead of only the exit code", async () => {
  const deps = createDefaultCodeSetupDeps(null);
  /* The plaintext failure reason and the fake secret are base64-encoded INSIDE the child script
     and decoded only at runtime, so they never appear as literal argv text — the error message's
     `cmd ${args.join(" ")}` echo (already present before this fix) cannot accidentally satisfy
     these assertions; only genuine stderr capture can.
     "npm ERR! peer dep conflict for left-pad" -> bnBtIEVSUiEgcGVlciBkZXAgY29uZmxpY3QgZm9yIGxlZnQtcGFk
     "AKIAABCDEFGHIJKLMNOP" (fake AWS access key shape)   -> QUtJQUFCQ0RFRkdISUpLTE1OT1A=
   */
  const project: CodeProject = {
    ecosystem: "node",
    install: {
      cmd: process.execPath,
      args: [
        "-e",
        "const reason = Buffer.from('bnBtIEVSUiEgcGVlciBkZXAgY29uZmxpY3QgZm9yIGxlZnQtcGFk','base64').toString();" +
          "const secret = Buffer.from('QUtJQUFCQ0RFRkdISUpLTE1OT1A=','base64').toString();" +
          "process.stderr.write(reason + '\\n' + secret + '\\n');" +
          "process.exit(7)",
      ],
    },
    test: { cmd: "npm", args: ["test"] },
  };
  await assert.rejects(
    () => deps.install(project, tmpdir()),
    (err: Error) => {
      assert.match(err.message, /npm ERR! peer dep conflict for left-pad/, "the real failure reason must reach the caller");
      assert.doesNotMatch(err.message, /AKIAABCDEFGHIJKLMNOP/, "a secret in the child's output must never reach the caller unredacted");
      assert.match(err.message, new RegExp(REDACTED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the redaction marker replaces the secret");
      return true;
    },
  );
});

test("install captures the tail of a large, multi-chunk child output without losing it — the pipes are actively drained, not left unread", async () => {
  const deps = createDefaultCodeSetupDeps(null);
  const marker = "END-OF-LARGE-OUTPUT-MARKER";
  /* base64-encoded so `marker` never appears as literal argv text (see the comment on the first
     test above — the error's `${cmd} ${args.join(" ")}` echo would otherwise satisfy this
     assertion on its own, without proving anything was actually read from the child). */
  const markerB64 = "RU5ELU9GLUxBUkdFLU9VVFBVVC1NQVJLRVI=";
  const project: CodeProject = {
    ecosystem: "node",
    install: {
      cmd: process.execPath,
      /* ~200KB of filler shaped like real npm log lines (several times over any 'data' event's
         chunk size, forcing multiple accumulation rounds), followed by a marker at the very end —
         before this fix, stdout/stderr were never read at all, so nothing (not even the marker)
         would reach the caller. Spaces/`@`/`:`/newlines deliberately break up any 40+-char
         alphanumeric run so the filler itself is never mistaken for a base64-looking secret by
         sanitizeText (unlike a flat run of one repeated letter). */
      args: [
        "-e",
        "process.stdout.write('npm WARN deprecated some-package@1.0.0: use something else instead\\n'.repeat(3000)); " +
          `process.stderr.write(Buffer.from('${markerB64}','base64').toString()); process.exit(9)`,
      ],
    },
    test: { cmd: "npm", args: ["test"] },
  };
  await assert.rejects(
    () => deps.install(project, tmpdir()),
    (err: Error) => {
      assert.match(err.message, new RegExp(marker), "output split across many 'data' events must still be captured intact");
      return true;
    },
  );
});
