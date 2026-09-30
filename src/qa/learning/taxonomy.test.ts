import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  errorClassFromVerdict,
  errorClassFromCorrections,
  ERROR_CLASSES,
  infraErrorGloss,
} from "./taxonomy";

describe("ERROR_CLASSES", () => {
  it("lists each class once, including the two an agent's generation end can name", () => {
    assert.equal(new Set(ERROR_CLASSES).size, ERROR_CLASSES.length);
    assert.ok((ERROR_CLASSES as readonly string[]).includes("E-STEP-BUDGET"));
    assert.ok((ERROR_CLASSES as readonly string[]).includes("E-NO-DECISION"));
  });

  it("E-INFRA is present and excludable from learning", () => {
    assert(ERROR_CLASSES.includes("E-INFRA"));
  });

  it("E-REVIEWER-REJECTED is a valid ErrorClass", () => {
    assert.ok((ERROR_CLASSES as readonly string[]).includes("E-REVIEWER-REJECTED"));
  });
});

describe("infraErrorGloss", () => {
  it("says the step-budget class is the agent running out of steps, engine-side", () => {
    const gloss = infraErrorGloss("E-STEP-BUDGET");
    assert.match(gloss, /steps/i);
    assert.match(gloss, /engine/i);
  });

  it("says the no-decision class is an agent that decided nothing, engine-side", () => {
    const gloss = infraErrorGloss("E-NO-DECISION");
    assert.match(gloss, /decision/i);
    assert.match(gloss, /engine/i);
  });

  it("never blames the DEV environment, whatever the class or its absence", () => {
    for (const errorClass of [...ERROR_CLASSES, null, undefined, "E-FUTURE-CLASS"]) {
      assert.doesNotMatch(infraErrorGloss(errorClass), /\bDEV\b/, String(errorClass));
    }
  });

  it("gives each engine-side class its own wording, apart from the neutral one", () => {
    const wordings = new Set([infraErrorGloss("E-STEP-BUDGET"), infraErrorGloss("E-NO-DECISION"), infraErrorGloss("E-INFRA")]);
    assert.equal(wordings.size, 3);
    assert.equal(infraErrorGloss(null), infraErrorGloss("E-INFRA"));
    assert.equal(infraErrorGloss("E-FUTURE-CLASS"), infraErrorGloss("E-INFRA"));
  });

  it("stays one plain sentence without an internal E-… code", () => {
    for (const errorClass of ERROR_CLASSES) {
      assert.doesNotMatch(infraErrorGloss(errorClass), /\bE-[A-Z]/, errorClass);
    }
  });
});

describe("errorClassFromVerdict", () => {
  it("invalid → E-STATIC", () => {
    assert.equal(errorClassFromVerdict("invalid", null, 0.7), "E-STATIC");
  });

  it("fail → E-EXEC-FAIL", () => {
    assert.equal(errorClassFromVerdict("fail", null, 0.7), "E-EXEC-FAIL");
  });

  it("flaky → E-FLAKY", () => {
    assert.equal(errorClassFromVerdict("flaky", null, 0.7), "E-FLAKY");
  });

  it("infra-error → E-INFRA", () => {
    assert.equal(errorClassFromVerdict("infra-error", null, 0.7), "E-INFRA");
  });

  it("pass with ratio above min → null (healthy green)", () => {
    assert.equal(errorClassFromVerdict("pass", 0.85, 0.7), null);
  });

  it("pass with ratio below min → E-COVERAGE-GAP", () => {
    assert.equal(errorClassFromVerdict("pass", 0.4, 0.7), "E-COVERAGE-GAP");
  });

  it("pass with null ratio → null (unmeasured)", () => {
    assert.equal(errorClassFromVerdict("pass", null, 0.7), null);
  });

  it("skipped → null", () => {
    assert.equal(errorClassFromVerdict("skipped", null, 0.7), null);
  });

  it("pass with ratio exactly at min → null (ratio >= min)", () => {
    assert.equal(errorClassFromVerdict("pass", 0.7, 0.7), null);
  });
});

describe("errorClassFromCorrections", () => {
  it("false positive keyword → E-FALSE-POSITIVE", () => {
    assert.equal(
      errorClassFromCorrections(["test clicks without asserting anything"]),
      "E-FALSE-POSITIVE",
    );
  });

  it("wrong objective → E-WRONG-OBJECTIVE", () => {
    assert.equal(
      errorClassFromCorrections(["the test is not tied to the commit diff"]),
      "E-WRONG-OBJECTIVE",
    );
  });

  it("fragile selector → E-FRAGILE-SELECTOR", () => {
    assert.equal(
      errorClassFromCorrections(["uses a fragile selector with nth-child"]),
      "E-FRAGILE-SELECTOR",
    );
  });

  it("no cleanup → E-NO-CLEANUP", () => {
    assert.equal(
      errorClassFromCorrections(["test does not clean up orphaned data"]),
      "E-NO-CLEANUP",
    );
  });

  it("returns null for unrecognized corrections", () => {
    assert.equal(
      errorClassFromCorrections(["the color should be blue not red"]),
      null,
    );
  });

  it("returns null for empty array", () => {
    assert.equal(errorClassFromCorrections([]), null);
  });

  it("first match wins when multiple anti-patterns present", () => {
    const result = errorClassFromCorrections([
      "fragile selector with magic string",
      "also does not clean up orphaned data", /* E-NO-CLEANUP would match, but E-FRAGILE-SELECTOR is first */
    ]);
    assert.equal(result, "E-FRAGILE-SELECTOR");
  });
});

describe("errorClassFromCorrections — closed-vocabulary reviewer tags (PROMPT-05)", () => {
  it("classifies by the leading [tag] even when the prose contains no legacy keyword", () => {
    /* The realistic reviewer correction: tagged, but the description is free-form and matches
       none of the keyword regexes. Before the tag, every such correction collapsed to the
       catch-all E-REVIEWER-REJECTED, making the fine-grained taxonomy dead.
     */
    assert.equal(
      errorClassFromCorrections(["[fragile-selector] checkout.spec.ts: replace page.getByText('Pay') with a section-scoped getByRole"]),
      "E-FRAGILE-SELECTOR",
    );
    assert.equal(
      errorClassFromCorrections(["[false-positive] login.spec.ts: add an assertion on the welcome message"]),
      "E-FALSE-POSITIVE",
    );
    assert.equal(
      errorClassFromCorrections(["[wrong-objective] foo.spec.ts: exercises the header, not the changed code"]),
      "E-WRONG-OBJECTIVE",
    );
    assert.equal(
      errorClassFromCorrections(["[no-cleanup] order.spec.ts: the created order is never removed"]),
      "E-NO-CLEANUP",
    );
  });

  it("[other] means the reviewer chose none of the buckets → null (caller uses E-REVIEWER-REJECTED)", () => {
    assert.equal(errorClassFromCorrections(["[other] an issue the buckets do not cover"]), null);
  });

  it("an unrecognized tag falls through to the keyword heuristics", () => {
    assert.equal(
      errorClassFromCorrections(["[typo-tag] uses a fragile selector with nth-child"]),
      "E-FRAGILE-SELECTOR",
    );
  });
});
