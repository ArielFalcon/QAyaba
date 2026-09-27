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
