/* What a sandboxed child prints is the page's and the spec's to shape: it can echo the account's password into a log line, an assertion message or a page the DOM capture reads. The run's secrets are known by value, so every path by which a child's output enters the orchestrator replaces them where it enters, and the pattern redaction that follows (sanitizeText, the Issue sanitizer) never has to find them by how they look. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { REDACTED } from "@kernel/ports/redaction.port.ts";
import { runE2E, type E2eExecuteDeps } from "@contexts/test-execution/infrastructure/e2e-execution.runner.ts";
import { runCheck } from "@contexts/test-execution/infrastructure/static-gate.checks.ts";
import { createCaptureDomDeps } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import { createRunSecretScope, withRunSecretScope } from "../../../src/shared-infrastructure/redaction/run-secret-redaction.ts";
import { sharedTestExec } from "../../support/exec-sandbox-harness.ts";

const SECRET = "hunter2-account-password";

function inRun<T>(fn: () => T): T {
  const scope = createRunSecretScope();
  scope.addAccountSecrets([SECRET]);
  return withRunSecretScope(scope, fn);
}

test("a failed case's message and failure DOM have the run's secrets taken out where the report enters", async () => {
  const title = "login › signs in";
  const file = "login.spec.ts";
  const hash = createHash("sha1").update(`${file}/${title}`).digest("hex").slice(0, 12);
  const deps: E2eExecuteDeps = {
    runSuite: async (args) => {
      writeFileSync(join(args.failureCaptureDir!, `desktop__${hash}__0.json`), JSON.stringify({ project: "desktop", file, title, retry: 0, yaml: `- textbox "Password": ${SECRET}`, finalUrl: `https://dev.example/?p=${SECRET}`, runtimeErrors: [{ type: "pageerror", text: `bad ${SECRET}` }] }));
      return { report: { suites: [{ title: file, specs: [{ title, ok: false, tests: [{ results: [{ status: "failed", error: { message: `expected ${SECRET} to be hidden` } }] }] }] }] }, logs: "", ran: true };
    },
  };
  const run = await inRun(() => runE2E("/e2e", { baseUrl: "https://dev", namespace: "ns" }, deps));
  const failed = run.cases.find((c) => c.status === "fail")!;
  const everything = JSON.stringify(failed);
  assert.equal(everything.includes(SECRET), false, `the failed case still carries the secret: ${everything}`);
  assert.ok(everything.includes(REDACTED));
});

test("the output of a static check has the run's secrets taken out", async () => {
  const out = await inRun(() => runCheck(process.execPath, ["-e", `console.error("error TS2322: ${SECRET}"); process.exit(2)`], process.cwd(), undefined, sharedTestExec()));
  assert.equal(out.ok, false);
  assert.equal(out.output.includes(SECRET), false);
  assert.ok(out.output.includes(REDACTED));
});

test("a page the DOM capture reads has the run's secrets taken out of its snapshot", async () => {
  const exec = sharedTestExec();
  const script = exec.writeScript("echo-page.cjs", `process.stdout.write(JSON.stringify([{ route: "/", yaml: '- link "Welcome ${SECRET}"' }]));`);
  const wrapped = { ...exec, writeScript: () => script, spawn: (cmd: string, args: readonly string[], o: Parameters<typeof exec.spawn>[2]) => exec.spawn(process.execPath, [script], o) };
  const snaps = await inRun(() => createCaptureDomDeps(wrapped).render(process.cwd(), "http://dev.example", ["/"]));
  assert.equal(JSON.stringify(snaps).includes(SECRET), false);
});
