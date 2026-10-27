import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredModelsFrom } from "./declared-model";

test("the declared model of an agent is the one its opencode.json entry names, absent when it names none", () => {
  const dir = mkdtempSync(join(tmpdir(), "declared-model-"));
  const path = join(dir, "opencode.json");
  writeFileSync(path, JSON.stringify({ agent: { "qa-lead": { model: "prov/lead-model" }, "qa-explore": { description: "no model" } } }));

  const declared = declaredModelsFrom(path);

  assert.equal(declared("qa-lead"), "prov/lead-model");
  assert.equal(declared("qa-explore"), undefined);
  assert.equal(declared("qa-unlisted"), undefined);
});
