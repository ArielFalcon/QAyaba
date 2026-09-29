/* qa-engine/test/contexts/test-execution/infrastructure/code-setup.test.ts
   Behavioral tests for the code-mode install step.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { setupCodeProject, createDefaultCodeSetupDeps, INSTALL_FAILURE_LOG_TAIL_CHARS, INSTALL_OUTPUT_KEEP_CHARS, type CodeSetupDeps } from "@contexts/test-execution/infrastructure/code-setup.ts";
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

   A failed install must report the child's own stdout/stderr tail, not only `exit ${code}`: the
   actual npm/pip/... error (dependency conflict, network failure, EACCES, ...) is what the caller
   needs, and an install writing more than the OS pipe buffer must be drained, not left to block on
   a full, unread pipe.
 */
test("a failed install surfaces a sanitized, bounded tail of the child's output instead of only the exit code", async () => {
  const deps = createDefaultCodeSetupDeps(null);
  /* The plaintext failure reason and the fake secret are base64-encoded INSIDE the child script
     and decoded only at runtime, so they never appear as literal argv text — the error message's
     `cmd ${args.join(" ")}` echo in the error message cannot accidentally satisfy
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
         the marker reaches the caller only if the output was actually read. Spaces/`@`/`:`/newlines deliberately break up any 40+-char
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

/* An install runs untrusted code: it can write without limit. The orchestrator must survive that,
   keep the newest output, and still fail through the normal error path. */
const FLOOD_LINE = "npm WARN deprecated flood-" + "line@1.0.0: use something else instead\\n";
const FLOOD_UNTIL_KILLED =
  `const chunk = '${FLOOD_LINE}'.repeat(1000);` +
  "process.stdout.write('first-' + 'output-marker\\n');" +
  "(function go() { process.stdout.write(chunk, go); })();";

/* Room for the failure header, the echoed command and the omission note around the reported tail. */
const ERROR_HEADER_ALLOWANCE = 2000;

function nodeInstall(script: string): CodeProject {
  return {
    ecosystem: "node",
    install: { cmd: process.execPath, args: ["-e", script] },
    test: { cmd: "npm", args: ["test"] },
  };
}

test("an install that floods output until the timeout still fails as a timeout and reports its newest output", { timeout: 30_000 }, async () => {
  const project = nodeInstall(FLOOD_UNTIL_KILLED);
  const deps: CodeSetupDeps = { ...createDefaultCodeSetupDeps(null), detect: () => project };
  await assert.rejects(
    () => setupCodeProject(tmpdir(), deps, { timeoutMs: 2500 }),
    (err: Error) => {
      assert.match(err.message, /timeout/i, "the failure is the install timeout, not a crash");
      assert.match(err.message, /flood-line/, "the newest output reaches the caller");
      assert.doesNotMatch(err.message, /first-output-marker/, "the oldest output was dropped, not kept");
      assert.ok(err.message.length < INSTALL_FAILURE_LOG_TAIL_CHARS + ERROR_HEADER_ALLOWANCE, `the error stays bounded (was ${err.message.length} chars)`);
      return true;
    },
  );
});

test("a failed install that wrote megabytes reports only its last lines", { timeout: 30_000 }, async () => {
  const deps = createDefaultCodeSetupDeps(null);
  const script =
    "process.stdout.write('first-' + 'output-marker\\n');" +
    `const chunk = '${FLOOD_LINE}'.repeat(1000);` +
    "let written = 0;" +
    "(function go() {" +
    "  if (written++ < 600) return process.stdout.write(chunk, go);" +
    "  process.stderr.write('last-' + 'output-marker\\n', () => process.exit(3));" +
    "})();";
  await assert.rejects(
    () => deps.install(nodeInstall(script), tmpdir()),
    (err: Error) => {
      assert.match(err.message, /last-output-marker/);
      assert.doesNotMatch(err.message, /first-output-marker/);
      assert.ok(err.message.length < INSTALL_FAILURE_LOG_TAIL_CHARS + ERROR_HEADER_ALLOWANCE, `the error stays bounded (was ${err.message.length} chars)`);
      return true;
    },
  );
});

test("a secret straddling the cut of the reported tail is redacted, not leaked as a fragment", async () => {
  const deps = createDefaultCodeSetupDeps(null);
  /* A 20-char access-key shape whose first 12 chars fall before the cut of the reported tail and last 8 after it.
     Base64 keeps the key out of argv, so only real output capture can put it in the message. */
  const keyB64 = "QUtJQUFCQ0RFRkdISUpLTE1OT1A=";
  const script =
    `const key = Buffer.from('${keyB64}','base64').toString();` +
    "const line = 'npm WARN deprecated filler-package@1.0.0: use something else\\n';" +
    "process.stderr.write(line.repeat(200) + key + ' x'.repeat(1996));" +
    "process.exit(4)";
  await assert.rejects(
    () => deps.install(nodeInstall(script), tmpdir()),
    (err: Error) => {
      assert.doesNotMatch(err.message, /IJKLMNOP/, "no fragment of the key survives the cut");
      assert.doesNotMatch(err.message, /AKIAABCDEFGH/, "the key is not shown whole either");
      return true;
    },
  );
});

/* Redaction shortens the kept output, so the reported tail can reach back to the very start of what the bound kept. If that
   start is the back half of a secret the bound cut through, it must not be shown. The output is mostly secret lines, so
   redacting it leaves far less than the reported tail. */
test("a secret cut through by the kept-output bound is not shown when redaction leaves the whole kept output in the report", async () => {
  const deps = createDefaultCodeSetupDeps(null);
  const secret = "ghp_" + "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"; /* 40 chars */
  const leakedHalf = secret.slice(-20);
  const script = [
    `const keep = ${INSTALL_OUTPUT_KEEP_CHARS}, secret = Buffer.from('${Buffer.from(secret).toString("base64")}', 'base64').toString(), off = 20;`,
    "const line = 'token=' + secret + '\\n';",
    "const suffix = keep - (line.length - (6 + off));",
    "const m = Math.floor(suffix / line.length), r = suffix - m * line.length;",
    "process.stderr.write('filler\\n'.repeat(50) + line + line.repeat(m) + (r > 0 ? 'y'.repeat(r - 1) + '\\n' : ''));",
    "process.exitCode = 4;",
  ].join(" ");
  await assert.rejects(
    () => deps.install(nodeInstall(script), tmpdir()),
    (err: Error) => {
      assert.match(err.message, new RegExp(REDACTED.replace(/[[\]]/g, "\\$&")), "the redacted output after the cut line is reported");
      assert.ok(!err.message.includes(leakedHalf), "the back half of the cut secret is not in the report");
      return true;
    },
  );
});
