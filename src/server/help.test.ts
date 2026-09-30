import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHelpContext } from "./help";
import { infraErrorGloss } from "../qa/learning/taxonomy";

test("the help explains an infra-error by every cause it can have, the engine-side ones included", () => {
  const help = buildHelpContext();
  assert.ok(help.includes(infraErrorGloss("E-STEP-BUDGET")), "an agent that ran out of steps");
  assert.ok(help.includes(infraErrorGloss("E-NO-DECISION")), "an agent that decided nothing");
  assert.ok(help.includes(infraErrorGloss("E-PRECONDITION")), "a login the run could not complete");
});

test("the help never presents an infra-error as only a DEV problem", () => {
  const legend = buildHelpContext().split("\n").find((line) => line.startsWith("- **infra-error**")) ?? "";
  assert.notEqual(legend, "", "the verdict legend has an infra-error line");
  assert.doesNotMatch(legend, /^- \*\*infra-error\*\* — DEV/);
});

test("the help says a skipped run is one where the agent declared a no-op", () => {
  const legend = buildHelpContext().split("\n").find((line) => line.startsWith("- **skipped**")) ?? "";
  assert.match(legend, /declared/i);
});
