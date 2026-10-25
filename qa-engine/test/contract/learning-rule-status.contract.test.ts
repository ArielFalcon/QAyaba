import { test } from "node:test";
import assert from "node:assert/strict";
import { LearningRuleViewSchema } from "@kernel/contract/commands.ts";

const rule = { trigger: "t", action: "a", errorClass: "E-X", confidence: "low", usageCount: 0, outcomeCount: 0, successRate: null };

test("the wire contract accepts every current rule status", () => {
  for (const status of ["candidate", "active", "deprecated", "superseded"]) {
    assert.equal(LearningRuleViewSchema.safeParse({ ...rule, status }).success, true, status);
  }
});

test("the wire contract refuses a status no build writes anymore", () => {
  assert.equal(LearningRuleViewSchema.safeParse({ ...rule, status: "pending" }).success, false);
});
