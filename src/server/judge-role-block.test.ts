import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJudgePromptVersion } from "@contexts/evaluation/domain/judges";
import { resolveJudgeSetup } from "./judge-settings";

const root = process.cwd();
const json = (rel: string): any => JSON.parse(readFileSync(join(root, rel), "utf8"));

/* The block waits in agents/pending/ for the owner's live step (re-record the agent-list fixture, then add it to agents/opencode.json). These pin that it is ready to be added as it is. */
const block = json("agents/pending/qa-judge.opencode-block.json")["qa-judge"];
const live = json("agents/opencode.json");

test("the pending judge block is tool-less exactly as the reflector is: every tool and MCP server denied, no read block", () => {
  assert.deepEqual(block.tools, live.agent["qa-reflector"].tools);
  assert.equal(block.permission, undefined, "a role that cannot read keeps the read denial its tools give it; a permission block would re-open it");
  assert.ok(Object.values(block.tools).every((allowed) => allowed === false));
});

test("the pending judge block names one numeric step cap, the pinned prompt file, and a model other than the generator's", () => {
  assert.equal(typeof block.maxSteps, "number");
  assert.equal(block.steps, undefined, "a step cap is named once");
  assert.equal(block.prompt, "{file:./agent/qa-judge.md}");
  assert.equal(typeof block.model, "string");
  assert.notEqual(block.model, live.agent["qa-generator"].model);
});

test("the judge prompt declares its version, and the setup resolves once the block is in the live configuration", () => {
  assert.ok(parseJudgePromptVersion(readFileSync(join(root, "agents/agent/qa-judge.md"), "utf8")));
  const merged = JSON.stringify({ ...live, agent: { ...live.agent, ...json("agents/pending/qa-judge.opencode-block.json") } });
  const setup = resolveJudgeSetup({
    root,
    readFile: (path) => (path.endsWith("opencode.json") ? merged : readFileSync(path, "utf8")),
  });
  assert.equal(setup.ok, true);
});
