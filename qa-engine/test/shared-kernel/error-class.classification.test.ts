import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import {
  ERROR_CLASSES,
  GRAVE_TAGS,
  errorClassFromVerdict,
  errorClassFromCorrections,
  resolveErrorClass,
} from "@kernel/error-class.ts";

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
  it("classifies by the leading [tag] even when the prose contains no keyword", () => {
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

const RESOLVED_CLASS_BY_INPUT: Record<string, string | null> = {
  '{"verdict":"invalid","coverageRatio":null,"minCoverageRatio":0.7,"reviewerCorrections":[]}': "E-STATIC",
  '{"verdict":"fail","coverageRatio":null,"minCoverageRatio":0.7,"reviewerCorrections":[]}': "E-EXEC-FAIL",
  '{"verdict":"flaky","coverageRatio":null,"minCoverageRatio":0.7,"reviewerCorrections":[]}': "E-FLAKY",
  '{"verdict":"infra-error","coverageRatio":null,"minCoverageRatio":0.7,"reviewerCorrections":[]}': "E-INFRA",
  '{"verdict":"pass","coverageRatio":0.25,"minCoverageRatio":0.7,"reviewerCorrections":[]}': "E-COVERAGE-GAP",
  '{"verdict":"pass","coverageRatio":0.95,"minCoverageRatio":0.7,"reviewerCorrections":[]}': null,
  '{"verdict":"pass","coverageRatio":null,"minCoverageRatio":0.7,"reviewerCorrections":[]}': null,
  '{"verdict":"fail","coverageRatio":null,"minCoverageRatio":0.7,"reviewerCorrections":["[false-positive] x"]}': "E-EXEC-FAIL",
  '{"verdict":"pass","coverageRatio":0.95,"minCoverageRatio":0.7,"reviewerCorrections":[],"valueScore":0.2}': "E-VALUE-SURVIVED",
  '{"verdict":"pass","coverageRatio":0.95,"minCoverageRatio":0.7,"reviewerCorrections":[],"valueScore":0.85}': null,
  '{"verdict":"skipped","coverageRatio":null,"minCoverageRatio":0.7,"reviewerCorrections":[]}': null,
};

test("resolveErrorClass returns the recorded class for each run evidence", () => {
  for (const [key, expected] of Object.entries(RESOLVED_CLASS_BY_INPUT)) {
    assert.equal(resolveErrorClass(JSON.parse(key)), expected, key);
  }
});

test("the grave tags are the vocabulary tags that must block publish, without the recoverable fragile-selector", () => {
  assert.deepEqual([...GRAVE_TAGS].sort(), ["false-positive", "no-cleanup", "wrong-objective"]);
  assert.equal(GRAVE_TAGS.has("fragile-selector"), false);
});

test("every error class is listed once", () => {
  assert.equal(new Set(ERROR_CLASSES).size, ERROR_CLASSES.length);
});
