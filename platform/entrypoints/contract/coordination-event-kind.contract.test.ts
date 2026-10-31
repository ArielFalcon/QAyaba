import { test } from "node:test";
import assert from "node:assert/strict";
import { CoordinationEventSchema } from "./commands";

test("the coordination event kinds name the lead's decisions and no earlier routing step", () => {
  const kinds: readonly string[] = CoordinationEventSchema.shape.kind.options;
  assert.ok(kinds.includes("lead-decision"));
  assert.ok(!kinds.includes("router"));
});

test("every other coordination event kind is still part of the contract", () => {
  const kinds: readonly string[] = CoordinationEventSchema.shape.kind.options;
  for (const kind of ["proposal", "delegation", "escalation", "pushback", "outcome"]) assert.ok(kinds.includes(kind), kind);
});
