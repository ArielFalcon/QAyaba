import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { submitContractsStaleness } from "./check-submit-contracts-fresh.ts";
import { renderSubmitContracts } from "./gen-submit-contracts.ts";
import { SUBMIT_TOOLS } from "../engine/src/shared-kernel/submission.ts";

test("every submit tool has the schema of its contract's arguments, in the kernel's order", () => {
  const rendered = JSON.parse(renderSubmitContracts()) as Record<string, { type: string; properties: Record<string, unknown> }>;

  assert.deepEqual(Object.keys(rendered), [...SUBMIT_TOOLS]);
  for (const tool of SUBMIT_TOOLS) {
    assert.equal(rendered[tool]?.type, "object", tool);
    assert.ok(Object.keys(rendered[tool]?.properties ?? {}).length > 0, `${tool} declares arguments`);
  }
});

test("the committed schemas are those the contracts render now: a contract edit cannot ship with the old arguments", () => {
  assert.equal(submitContractsStaleness((path) => readFileSync(path, "utf8")), undefined);
});

test("staleness names a drifted file and a missing one apart", () => {
  assert.match(submitContractsStaleness(() => "{}", "fresh") ?? "", /is stale/);
  assert.match(
    submitContractsStaleness(() => {
      throw new Error("ENOENT");
    }, "fresh") ?? "",
    /does not exist/,
  );
  assert.equal(submitContractsStaleness(() => "same", "same"), undefined);
});
