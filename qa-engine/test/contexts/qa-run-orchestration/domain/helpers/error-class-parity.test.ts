import { test } from "node:test";
import assert from "node:assert/strict";
/* these two copies must stay byte-compatible; engine cannot import src/ */
/* expected values are a frozen oracle from the deleted twin — do not rebase them to silence a failure */
import {
  errorClassFromVerdict,
  errorClassFromCorrections,
  resolveErrorClass,
} from "@contexts/qa-run-orchestration/domain/helpers/error-class.ts";
import {
  errorClassFromVerdict as legacyErrorClassFromVerdict,
  errorClassFromCorrections as legacyErrorClassFromCorrections,
} from "../../../../../../src/qa/learning/taxonomy.ts";

function legacyResolveErrorClass(input: {
  verdict: string;
  coverageRatio: number | null;
  minCoverageRatio: number;
  reviewerCorrections: string[];
  valueScore?: number | null;
}): string | null {
  const key = JSON.stringify(input);
  const snapshot = LEGACY_RESOLVE_ERROR_CLASS_SNAPSHOT[key];
  if (snapshot === undefined) {
    throw new Error(`No fixture snapshot for input: ${key} — add a captured legacy value before using a new sample.`);
  }
  return snapshot;
}

const LEGACY_RESOLVE_ERROR_CLASS_SNAPSHOT: Record<string, string | null> = {
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

test("PARITY: errorClassFromVerdict matches legacy across every verdict + coverage-ratio band", () => {
  const samples: Array<{ verdict: string; coverageRatio: number | null; minRatio: number }> = [
    { verdict: "invalid", coverageRatio: null, minRatio: 0.7 },
    { verdict: "fail", coverageRatio: null, minRatio: 0.7 },
    { verdict: "flaky", coverageRatio: null, minRatio: 0.7 },
    { verdict: "infra-error", coverageRatio: null, minRatio: 0.7 },
    { verdict: "pass", coverageRatio: null, minRatio: 0.7 },
    { verdict: "pass", coverageRatio: 0.5, minRatio: 0.7 },
    { verdict: "pass", coverageRatio: 0.9, minRatio: 0.7 },
    { verdict: "skipped", coverageRatio: null, minRatio: 0.7 },
    { verdict: "unknown-verdict", coverageRatio: null, minRatio: 0.7 },
  ];
  for (const s of samples) {
    assert.equal(
      errorClassFromVerdict(s.verdict, s.coverageRatio, s.minRatio),
      legacyErrorClassFromVerdict(s.verdict, s.coverageRatio, s.minRatio),
      `verdict=${s.verdict} coverageRatio=${s.coverageRatio}`,
    );
  }
});

test("PARITY: errorClassFromCorrections matches legacy across tagged/untagged/other corrections", () => {
  const samples: string[][] = [
    ["[false-positive] login.spec.ts: asserts nothing meaningful"],
    ["[wrong-objective] does not test the change"],
    ["[fragile-selector] nth-child(2) hardcoded index"],
    ["[no-cleanup] leaves orphaned test data"],
    ["[other] a correction the reviewer chose not to classify"],
    ["an untagged correction mentioning a false positive test"],
    ["a totally unrecognizable correction"],
    [],
    ["[typo-tag] some correction", "fragile selector: nth-child(3)"],
  ];
  for (const s of samples) {
    assert.equal(
      errorClassFromCorrections(s),
      legacyErrorClassFromCorrections(s),
      `corrections=${JSON.stringify(s)}`,
    );
  }
});

test("PARITY: resolveErrorClass matches legacy's labelRunOutcome-derived errorClass across the full precedence chain", () => {
  const samples: Array<{
    verdict: string;
    coverageRatio: number | null;
    minCoverageRatio: number;
    reviewerCorrections: string[];
    valueScore?: number | null;
  }> = [
    { verdict: "invalid", coverageRatio: null, minCoverageRatio: 0.7, reviewerCorrections: [] },
    { verdict: "fail", coverageRatio: null, minCoverageRatio: 0.7, reviewerCorrections: [] },
    { verdict: "flaky", coverageRatio: null, minCoverageRatio: 0.7, reviewerCorrections: [] },
    { verdict: "infra-error", coverageRatio: null, minCoverageRatio: 0.7, reviewerCorrections: [] },
    { verdict: "pass", coverageRatio: 0.25, minCoverageRatio: 0.7, reviewerCorrections: [] },
    { verdict: "pass", coverageRatio: 0.95, minCoverageRatio: 0.7, reviewerCorrections: [] },
    { verdict: "pass", coverageRatio: null, minCoverageRatio: 0.7, reviewerCorrections: [] },
    /* Reviewer-correction-derived class does NOT override a verdict-derived structural class —
       fail-issue with reviewer corrections still resolves E-EXEC-FAIL (verdict wins first).
     */
    { verdict: "fail", coverageRatio: null, minCoverageRatio: 0.7, reviewerCorrections: ["[false-positive] x"] },
    { verdict: "pass", coverageRatio: 0.95, minCoverageRatio: 0.7, reviewerCorrections: [], valueScore: 0.2 },
    { verdict: "pass", coverageRatio: 0.95, minCoverageRatio: 0.7, reviewerCorrections: [], valueScore: 0.85 },
    { verdict: "skipped", coverageRatio: null, minCoverageRatio: 0.7, reviewerCorrections: [] },
  ];
  for (const s of samples) {
    assert.equal(
      resolveErrorClass(s),
      legacyResolveErrorClass(s),
      `verdict=${s.verdict} coverageRatio=${s.coverageRatio} valueScore=${s.valueScore}`,
    );
  }
});
