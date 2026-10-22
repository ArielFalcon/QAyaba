/* sanitizeText is the one seam all text bound for a model passes through, so the run's own secrets are taken out there by value, in every mode, before the patterns look. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { REDACTED } from "@kernel/ports/redaction.port.ts";
import { sanitizeText } from "@contexts/generation/infrastructure/sanitize-text.ts";
import { createRunSecretScope, withRunSecretScope } from "../../../../src/shared-infrastructure/run-secret-redaction.ts";

const PASSWORD = "plain-pass-9981";
const COOKIE = "c00kie-value-abcdef";

function scope(): ReturnType<typeof createRunSecretScope> {
  const s = createRunSecretScope();
  s.addAccountSecrets([PASSWORD]);
  s.addSessionValues([COOKIE]);
  return s;
}

const DOM = `<form><input name="pw" value="${PASSWORD}"><meta name="session" content="${COOKIE}"></form>`;
const CASE_ERROR = `Error: expect(locator).toHaveValue(expected)\n  Expected: "${PASSWORD}"\n  Received: ""`;
const STDOUT = `console.log: logged in as qa with ${PASSWORD}; cookie=${COOKIE}`;

for (const mode of ["issue", "model"] as const) {
  test(`${mode} mode: a password or cookie value in a DOM, a case error and a stdout excerpt is replaced`, () => {
    withRunSecretScope(scope(), () => {
      for (const text of [DOM, CASE_ERROR, STDOUT]) {
        const out = sanitizeText(text, mode);
        assert.ok(!out.text.includes(PASSWORD) && !out.text.includes(COOKIE), out.text);
        assert.ok(out.text.includes(REDACTED));
        assert.equal(out.detection.redacted, true);
        assert.ok(out.detection.patterns.includes("run-secret"));
      }
    });
  });
}

test("outside a run's scope the same text keeps its values, and the pattern pass is unchanged", () => {
  assert.equal(sanitizeText(DOM).text, DOM);
  assert.equal(sanitizeText(STDOUT).detection.redacted, false);
});

test("the value pass counts what it replaced and leaves the pattern pass its own count", () => {
  const patternOnly = "token=sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const patternCount = sanitizeText(patternOnly).detection.count;
  withRunSecretScope(scope(), () => {
    const out = sanitizeText(`${PASSWORD} ${COOKIE} ${PASSWORD} ${patternOnly}`);
    assert.equal(out.detection.count, 3 + patternCount);
    assert.ok(out.detection.patterns.includes("run-secret") && out.detection.patterns.includes("llm-api-key"));
  });
});
