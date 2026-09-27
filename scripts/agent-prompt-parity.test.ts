/* Guards against the OpenCode (agents/agent/) and Codex (agent/roles/) prompt copies drifting
   out of parity again — see D2 in the 2026-09-27 remediation backlog. This does not require
   the two files to be byte-identical (each provider's prompt is worded for its own runtime);
   it only pins that a short list of load-bearing guard sentences survive in BOTH copies for
   the roles that have drifted before. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readBoth(role: string): { opencode: string; codex: string } {
  return {
    opencode: readFileSync(join(ROOT, "agents", "agent", `${role}.md`), "utf8"),
    codex: readFileSync(join(ROOT, "agent", "roles", `${role}.md`), "utf8"),
  };
}

function assertBothContain(role: string, guard: string): void {
  const { opencode, codex } = readBoth(role);
  assert.ok(opencode.includes(guard), `agents/agent/${role}.md is missing guard sentence: ${JSON.stringify(guard)}`);
  assert.ok(codex.includes(guard), `agent/roles/${role}.md is missing guard sentence: ${JSON.stringify(guard)}`);
}

test("qa-generator: both copies forbid running the suite itself", () => {
  assertBothContain("qa-generator", "STOP touching the suite");
});

test("qa-proposer: both copies know the http-backend (BE→BE REST) transport", () => {
  assertBothContain("qa-proposer", "### `http-backend`");
  assertBothContain("qa-proposer", "rest-template-exchange");
});

test("qa-sidekick: both copies state frozen authority and the git-write ban", () => {
  assertBothContain("qa-sidekick", "frozen authority flags printed in the brief");
  assertBothContain("qa-sidekick", "never perform git writes");
});

test("qa-generator: both copies send the app login to auth.setup.ts, never to a fixtures.ts override", () => {
  for (const [copy, text] of Object.entries(readBoth("qa-generator"))) {
    assert.match(text, /auth\.setup\.ts/, `${copy} copy must point the app login at e2e/auth.setup.ts`);
    assert.doesNotMatch(text, /overrid\w*[^.]*`?authenticate`? fixture/i, `${copy} copy must not ask for an authenticate override`);
  }
});

/* The two skill copies are kept byte-identical by src/agent-runtime/prompt-sync.test.ts; this pins
   what the auth guide must tell the agent. The orchestrator reads the session only from
   process.env.PW_STORAGE_STATE, and a rewrite that saves anywhere else fails the run before
   execution, so the guide must name that path. */
test("playwright-authoring auth guide: both runtimes' copies say a rewritten login saves to PW_STORAGE_STATE", () => {
  for (const copy of [join("agent", "skills"), join("agents", "skill")]) {
    const guide = readFileSync(join(ROOT, copy, "playwright-authoring", "auth.md"), "utf8");
    assert.match(guide, /process\.env\.PW_STORAGE_STATE/, `${copy}/playwright-authoring/auth.md`);
  }
});
