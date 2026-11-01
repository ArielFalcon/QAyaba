/* A failure's detail reaches the lead as a finding cut at a bound; the cut is made on redacted text, so a credential that straddles it never reaches the lead in part. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { flakyFindings, staticGateFindings, type BoundText } from "@contexts/run-orchestration/application/run-flow/phases/generation-services.ts";
import { sanitizeText } from "../../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { redactThenBound } from "../../../../../src/shared-kernel/redact-then-bound.ts";
import { CASES, filler, leaks } from "../../../../support/straddling-secrets.ts";

const bound: BoundText = (text, maxChars, marker) => redactThenBound(text, maxChars, (seen) => sanitizeText(seen).text, marker ? { marker } : {});
const DETAIL_BOUND = 2000;
const LEAD = "e2e/flows/login.spec.ts(12,7): error TS2345: ";

for (const secret of CASES.filter((c) => ["quoted password", "URL userinfo", "bearer token"].includes(c.name))) {
  test(`a static gate error keeps no part of a ${secret.name} that straddles the finding's cut`, () => {
    const error = `${LEAD}${filler(DETAIL_BOUND - LEAD.length - 20)} ${secret.text} more`;
    const [finding] = staticGateFindings({ errors: [error] }, bound);
    assert.deepEqual(leaks(finding!.finding.text, secret), []);
  });

  test(`a flaky case's detail keeps no part of a ${secret.name} that straddles the finding's cut`, () => {
    const detail = `${LEAD}${filler(DETAIL_BOUND - LEAD.length - 20)} ${secret.text} more`;
    const [finding] = flakyFindings([{ case: { name: "login", status: "flaky", detail, file: "e2e/flows/login.spec.ts" }, class: "timing", evidence: "x" } as never], bound);
    assert.deepEqual(leaks(finding!.finding.text, secret), []);
  });
}

test("a detail past the bound still says it was cut", () => {
  const [finding] = staticGateFindings({ errors: [`${LEAD}${filler(DETAIL_BOUND * 2)}`] }, bound);
  assert.match(finding!.finding.text, /\(cut\)$/);
});
