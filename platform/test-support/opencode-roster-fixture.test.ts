/* The roster fixture stands in for agents/opencode.json wherever a test needs the roster only as an input. This is a deployable-lint test: it reads the real file and keeps the fixture's role names and shapes in step with it. It compares names and shapes, never model ids, so a change of model in the deployable breaks nothing. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRoster, rosterFixturePath } from "./fixtures/opencode-roster";

type RoleBlock = { model?: unknown; maxSteps?: unknown; steps?: unknown };

const deployable = (JSON.parse(readFileSync(join(process.cwd(), "agents", "opencode.json"), "utf8")) as { agent: Record<string, RoleBlock> }).agent;
const roster = loadRoster().agent;

test("the roster fixture declares exactly the roles the deployable declares", () => {
  assert.deepEqual(Object.keys(roster).sort(), Object.keys(deployable).sort());
});

test("a fixture role carries a model and a step cap exactly when the deployable role does", () => {
  for (const [role, real] of Object.entries(deployable)) {
    const fixture = roster[role];
    assert.ok(fixture, `${role} is missing from the roster fixture`);
    assert.equal(typeof fixture.model === "string", typeof real.model === "string", `${role}: model`);
    assert.equal(typeof fixture.maxSteps === "number", typeof (real.maxSteps ?? real.steps) === "number", `${role}: step cap`);
  }
});

test("the fixture path is the file the loader parses", () => {
  assert.deepEqual(JSON.parse(readFileSync(rosterFixturePath(), "utf8")), loadRoster());
});
