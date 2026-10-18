import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_JUDGE_DAILY_TOKENS, resolveJudgeSetup, resolveJudgeSwitch } from "./judge-settings";

test("judges are off unless QA_JUDGES_ENABLED is exactly true, and a mistyped value stops the boot", () => {
  assert.equal(resolveJudgeSwitch({}).enabled, false);
  assert.equal(resolveJudgeSwitch({ QA_JUDGES_ENABLED: "" }).enabled, false);
  assert.equal(resolveJudgeSwitch({ QA_JUDGES_ENABLED: "false" }).enabled, false);
  assert.equal(resolveJudgeSwitch({ QA_JUDGES_ENABLED: "true" }).enabled, true);
  for (const bad of ["1", "yes", "TRUE", "on"]) assert.throws(() => resolveJudgeSwitch({ QA_JUDGES_ENABLED: bad }), /QA_JUDGES_ENABLED/, bad);
});

test("the daily token budget defaults to a conservative number and takes a positive whole number; anything else stops the boot", () => {
  assert.equal(resolveJudgeSwitch({}).dailyTokens, DEFAULT_JUDGE_DAILY_TOKENS);
  assert.equal(resolveJudgeSwitch({ QA_JUDGES_DAILY_TOKENS: "50000" }).dailyTokens, 50_000);
  assert.equal(resolveJudgeSwitch({ QA_JUDGES_DAILY_TOKENS: "" }).dailyTokens, DEFAULT_JUDGE_DAILY_TOKENS);
  for (const bad of ["0", "-5", "1.5", "lots", "1e3"]) assert.throws(() => resolveJudgeSwitch({ QA_JUDGES_DAILY_TOKENS: bad }), /QA_JUDGES_DAILY_TOKENS/, bad);
});

const PROMPT = "<!-- judge-prompt-version: 2 -->\n# Judge";
const config = (judgeModel: string | undefined, generatorModel: string | null = "prov/generator-model"): string =>
  JSON.stringify({ agent: { "qa-judge": judgeModel === undefined ? {} : { model: judgeModel }, "qa-generator": generatorModel === null ? {} : { model: generatorModel } } });

const files = (map: Record<string, string>) => (path: string): string => {
  const hit = Object.entries(map).find(([suffix]) => path.endsWith(suffix));
  if (!hit) throw new Error(`ENOENT ${path}`);
  return hit[1];
};

test("the setup is the prompt's version and the judge's configured model when the model differs from the generator's", () => {
  const setup = resolveJudgeSetup({ root: "/repo", readFile: files({ "agents/agent/qa-judge.md": PROMPT, "agents/opencode.json": config("prov/judge-model") }) });
  assert.deepEqual(setup, { ok: true, promptVersion: "2", configuredModel: "prov/judge-model" });
});

test("a judge on the generator's model is refused: it would grade its own work", () => {
  const setup = resolveJudgeSetup({ root: "/repo", readFile: files({ "agents/agent/qa-judge.md": PROMPT, "agents/opencode.json": config("prov/generator-model") }) });
  assert.equal(setup.ok, false);
  if (!setup.ok) assert.match(setup.reason, /generator/);
});

test("the setup is refused, with the reason, when the role block, its model, the generator's model or the prompt version is missing", () => {
  const read = (over: Record<string, string>) => resolveJudgeSetup({ root: "/repo", readFile: files({ "agents/agent/qa-judge.md": PROMPT, "agents/opencode.json": config("prov/judge-model"), ...over }) });
  const noBlock = read({ "agents/opencode.json": JSON.stringify({ agent: { "qa-generator": { model: "p/g" } } }) });
  assert.equal(noBlock.ok, false);
  if (!noBlock.ok) {
    assert.match(noBlock.reason, /qa-judge/);
    assert.equal(noBlock.promptVersion, "2", "the prompt's version is known even though the role is not declared yet");
  }
  assert.equal(read({ "agents/opencode.json": config(undefined) }).ok, false);
  assert.equal(read({ "agents/opencode.json": config("p/j", null) }).ok, false);
  const unversioned = read({ "agents/agent/qa-judge.md": "# no version" });
  assert.equal(unversioned.ok, false);
  if (!unversioned.ok) assert.equal(unversioned.promptVersion, undefined);
  assert.equal(resolveJudgeSetup({ root: "/repo", readFile: () => { throw new Error("ENOENT"); } }).ok, false);
  assert.equal(read({ "agents/opencode.json": "{not json" }).ok, false);
});
