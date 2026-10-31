import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ERROR_CLASSES } from "@kernel/error-class";
import { infraErrorGloss } from "./infra-error-gloss";

describe("infraErrorGloss", () => {
  it("says the step-budget class is the agent running out of steps, engine-side", () => {
    const gloss = infraErrorGloss("E-STEP-BUDGET");
    assert.match(gloss, /steps/i);
    assert.match(gloss, /engine/i);
  });

  it("says the time-budget class is the agent running out of time, engine-side", () => {
    const gloss = infraErrorGloss("E-TIME-BUDGET");
    assert.match(gloss, /time/i);
    assert.match(gloss, /engine/i);
    assert.doesNotMatch(gloss, /steps/i);
  });

  it("says the no-decision class is an agent that decided nothing, engine-side", () => {
    const gloss = infraErrorGloss("E-NO-DECISION");
    assert.match(gloss, /decision/i);
    assert.match(gloss, /engine/i);
  });

  it("says the precondition class is a login the run could not complete, and not an engine-side condition", () => {
    const gloss = infraErrorGloss("E-PRECONDITION");
    assert.match(gloss, /login/i);
    assert.doesNotMatch(gloss, /engine/i);
  });

  it("says the reviewer-unavailable class is a reviewer that could not be reached and judged nothing, neither a rejection nor the app's fault", () => {
    const gloss = infraErrorGloss("E-REVIEWER-UNAVAILABLE");
    assert.match(gloss, /reviewer/i);
    assert.match(gloss, /not a rejection/i);
    assert.doesNotMatch(gloss, /engine/i);
  });

  it("never blames the DEV environment, whatever the class or its absence", () => {
    for (const errorClass of [...ERROR_CLASSES, null, undefined, "E-FUTURE-CLASS"]) {
      assert.doesNotMatch(infraErrorGloss(errorClass), /\bDEV\b/, String(errorClass));
    }
  });

  it("gives each engine-side class its own wording, apart from the neutral one", () => {
    const wordings = new Set([infraErrorGloss("E-STEP-BUDGET"), infraErrorGloss("E-NO-DECISION"), infraErrorGloss("E-PRECONDITION"), infraErrorGloss("E-TIME-BUDGET"), infraErrorGloss("E-REVIEWER-UNAVAILABLE"), infraErrorGloss("E-INFRA")]);
    assert.equal(wordings.size, 6);
    assert.equal(infraErrorGloss(null), infraErrorGloss("E-INFRA"));
    assert.equal(infraErrorGloss("E-FUTURE-CLASS"), infraErrorGloss("E-INFRA"));
  });

  it("stays one plain sentence without an internal E-… code", () => {
    for (const errorClass of ERROR_CLASSES) {
      assert.doesNotMatch(infraErrorGloss(errorClass), /\bE-[A-Z]/, errorClass);
    }
  });
});
