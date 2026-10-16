/* Guards against the OpenCode (agents/agent/) and Codex (agent/roles/) prompt copies drifting
   out of parity. This does not require
   the two files to be byte-identical (each provider's prompt is worded for its own runtime);
   it only pins that a short list of load-bearing guard sentences survive in BOTH copies for
   the roles that have drifted before. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCEPTANCE_STATUSES,
  readAcceptanceReport,
} from "../qa-engine/src/contexts/qa-run-orchestration/application/coordination/acceptance-report.ts";

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

/* The outcome contract: a change DEV cannot show ends as a declared no-op, or as a spec that creates the state through the UI; a pre-existing element with the same label is never asserted in its place. The verdict reads no flag in the note. */
test("qa-generator: both copies end a change DEV cannot show as a declared no-op and keep the same-label stand-in out of the specs", () => {
  assertBothContain("qa-generator", "cannot be observed on DEV in its current state");
  assertBothContain("qa-generator", "Never assert a pre-existing element");
  assertBothContain("qa-generator", "grounds no selector and no asserted value");
});

test("qa-reviewer: both copies reject a spec that only asserts pre-existing elements with the changed label", () => {
  assertBothContain("qa-reviewer", "| Same-label stand-in |");
  for (const [copy, text] of Object.entries(readBoth("qa-reviewer"))) {
    assert.doesNotMatch(text, /more lenient/i, `${copy} copy must not relax selector precision for a spec written without the page`);
  }
});

test("qa-generator: both copies forbid running the suite itself", () => {
  assertBothContain("qa-generator", "STOP touching the suite");
});

/* The shared layer owns the rule that authoring against live DEV observes and never writes; it is stated
   once there, in both runtimes' copies, and the role file that used to invite form interaction no longer does. */
test("shared instructions: both copies say live DEV is observed while authoring and only a generated spec writes to it", () => {
  for (const path of [join("agents", "AGENTS.md"), join("agent", "AGENTS.md")]) {
    const text = readFileSync(join(ROOT, path), "utf8");
    assert.ok(text.includes("Authoring-time DEV exploration observes; it never writes."), `${path} is missing the observe-only rule`);
    assert.match(text, /ad-hoc script/, `${path} must forbid ad-hoc scripts`);
  }
});

/* The generator has no shell (opencode.json denies bash outright), so neither copy may tell it to run a
   command; the orchestrator's Validate and Execute phases do the checking and say so once. */
test("qa-generator: neither copy tells the author to run a command, and both say the orchestrator validates and runs the specs", () => {
  for (const [copy, text] of Object.entries(readBoth("qa-generator"))) {
    assert.ok(!/npx playwright/.test(text), `${copy} copy still names a Playwright command to run`);
    assert.ok(!/--list/.test(text), `${copy} copy still asks for the suite listing`);
    assert.ok(!/\(bash\)/.test(text), `${copy} copy still has a bash step`);
    assert.match(text, /orchestrator validates and runs/i, `${copy} copy must say who validates what the author writes`);
  }
});

test("qa-generator: neither copy invites submitting forms on live DEV while authoring", () => {
  for (const [copy, text] of Object.entries(readBoth("qa-generator"))) {
    assert.ok(!/interact with forms/i.test(text), `${copy} copy still tells the author to interact with forms`);
  }
});

test("qa-proposer: both copies know the http-backend (BE→BE REST) transport", () => {
  assertBothContain("qa-proposer", "### `http-backend`");
  assertBothContain("qa-proposer", "rest-template-exchange");
});

test("qa-sidekick: both copies state frozen authority and the git-write ban", () => {
  assertBothContain("qa-sidekick", "frozen authority flags printed in the brief");
  assertBothContain("qa-sidekick", "never perform git writes");
});

/* The output example writes each enum as its alternatives ("met"|"unmet"); reading every alternative
   list as an array makes the example parse as JSON. */
function parseOutputExample(example: string): Record<string, unknown> {
  return JSON.parse(example.replace(/"[^"]*"(?:\|"[^"]*")+/g, (alternatives) => `[${alternatives.split("|").join(",")}]`));
}

/* The executor reads `acceptance` strictly (missing/invalid is a recorded contract defect), so the
   example in both copies must be a report the executor reads cleanly under every status it names,
   and it must name every status the reader accepts. */
test("qa-sidekick: both copies' output example is a per-criterion acceptance report the executor reads", () => {
  for (const [copy, text] of Object.entries(readBoth("qa-sidekick"))) {
    const example = /```json\n([\s\S]*?)\n```/.exec(text)?.[1];
    assert.ok(example, `${copy} copy carries a JSON output example`);
    const { acceptance } = parseOutputExample(example) as { acceptance?: { criterion: unknown; status: string[] }[] };
    assert.ok(Array.isArray(acceptance) && acceptance.length > 0, `${copy} copy's example carries an acceptance report`);
    for (const { criterion, status } of acceptance) {
      assert.deepEqual([...status].sort(), [...ACCEPTANCE_STATUSES].sort(), `${copy} copy names every status the executor reads`);
      for (const one of status) {
        const report = readAcceptanceReport([{ criterion, status: one }], acceptance.length);
        assert.equal(report.defect, undefined, `${copy} copy's example entry with status "${one}" reads cleanly`);
      }
    }
  }
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
