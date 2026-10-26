/* these two copies must stay byte-compatible; engine cannot import src/ */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunSecretScope, withRunSecretScope } from "../../../src/shared-infrastructure/redaction/run-secret-redaction.ts";

import {
  sanitizeText as ported,
  containsSecrets as portedContainsSecrets,
  assertNoSecretLeak as portedAssertNoSecretLeak,
} from "../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import {
  sanitizeText as reference,
  containsSecrets as referenceContainsSecrets,
  assertNoSecretLeak as referenceAssertNoSecretLeak,
} from "../../../../src/orchestrator/sanitizer.ts";

test("redacts a mixed secret + PII + private-IP line identically", () => {
  const input = "apiKey=sk-abc123XYZ host=10.0.3.14 email leaker@example.com token: ghs_supersecretvalue";
  assert.deepEqual(ported(input), reference(input));
});

test("DB connection string — password redacted, host preserved, identically", () => {
  const input = "DATABASE_URL=postgres://admin:s3cr3tP4ss@db.internal:5432/app";
  assert.deepEqual(ported(input), reference(input));
});

test("JWT redaction", () => {
  const jwt = "eyJhbGciOi.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4";
  const input = `Authorization: Bearer ${jwt}`;
  assert.deepEqual(ported(input), reference(input));
});

test("data URI base64 preserved identically (no false-positive secret redaction)", () => {
  const input = `<img src="data:image/png;base64,${"A".repeat(200)}">`;
  assert.deepEqual(ported(input), reference(input));
});

test("credential-free URL passes through unchanged, identically", () => {
  const input = "fetch('https://api.example.com/v1/users?page=2')";
  assert.deepEqual(ported(input), reference(input));
});

test("empty string handled identically", () => {
  assert.deepEqual(ported(""), reference(""));
});

test("git SHA (pure hex) is not mistaken for a base64 secret, identically", () => {
  const input = `commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 landed`;
  assert.deepEqual(ported(input), reference(input));
});

/* Byte-parity for "model" mode: both twins must apply the SAME narrowed api-key-assignment
   pattern; the two-tier policy exists as a mode flag on ONE shared pattern set.
 */
test("model mode — type annotation NOT redacted, identically in both twins", () => {
  const input = "password: string;";
  assert.deepEqual(ported(input, "model"), reference(input, "model"));
});

test("model mode — bare call expression NOT redacted, identically in both twins", () => {
  const input = "const token = getToken();";
  assert.deepEqual(ported(input, "model"), reference(input, "model"));
});

test("model mode — quoted literal STILL redacted, identically in both twins", () => {
  const input = 'const password = "hunter2";';
  assert.deepEqual(ported(input, "model"), reference(input, "model"));
});

test("issue mode (default) unchanged, identically in both twins", () => {
  const input = "password: string; token = getToken();";
  assert.deepEqual(ported(input), reference(input));
  assert.deepEqual(ported(input, "issue"), reference(input, "issue"));
});

test("containsSecrets detects a real secret identically in both twins", () => {
  const input = "token: ghs_supersecretvalue123456789012345678";
  assert.equal(portedContainsSecrets(input), referenceContainsSecrets(input));
  assert.equal(portedContainsSecrets(input), true);
});

test("containsSecrets returns false for clean text identically in both twins", () => {
  const input = "fetch('https://api.example.com/v1/users?page=2')";
  assert.equal(portedContainsSecrets(input), referenceContainsSecrets(input));
  assert.equal(portedContainsSecrets(input), false);
});

test("containsSecrets model mode does NOT flag a type annotation, identically in both twins", () => {
  const input = "password: string;";
  assert.equal(portedContainsSecrets(input, "model"), referenceContainsSecrets(input, "model"));
  assert.equal(portedContainsSecrets(input, "model"), false);
});

test("assertNoSecretLeak throws SecretLeakError when a secret survives redaction, identically in both twins", () => {
  const leaked = "token: ghs_supersecretvalue123456789012345678";
  assert.throws(() => portedAssertNoSecretLeak(leaked, "issue", "diff→model"), /a secret survived redaction/);
  assert.throws(() => referenceAssertNoSecretLeak(leaked, "issue", "diff→model"), /a secret survived redaction/);
});

test("assertNoSecretLeak does not throw on clean redacted text, identically in both twins", () => {
  const clean = "no secrets here";
  assert.doesNotThrow(() => portedAssertNoSecretLeak(clean, "issue", "diff→model"));
  assert.doesNotThrow(() => referenceAssertNoSecretLeak(clean, "issue", "diff→model"));
});

/* Quote-aware value capture must not leak a secret's tail when the value contains an embedded
   quote. Pin the exact behavior identically in both twins so a future drift between the two
   regexes is caught here.
 */
test("an embedded quote in a bare value does not leak the tail, identically", () => {
  const input = 'token=abc"def';
  assert.deepEqual(ported(input), reference(input));
});

test("GITHUB_TOKEN with an embedded quote does not leak the tail, identically", () => {
  const input = 'GITHUB_TOKEN=ghp_abc"XYZ123';
  assert.deepEqual(ported(input), reference(input));
});

test("a prose keyword false-match does not let an escaped-quote secret ship unredacted, identically", () => {
  const input = 'leaked secret: password="mySecretPass\\"WithQuote" end';
  assert.deepEqual(ported(input), reference(input));
});

test("a balanced-quote name holding a keyword (Token: refresh) is handled identically", () => {
  const input = "role:name 'button' with name \"Token: refresh\" is NOT in the captured tree";
  assert.deepEqual(ported(input), reference(input));
});

test("the run's own secrets are taken out by value identically in both twins, in every mode", () => {
  const scope = createRunSecretScope();
  scope.addAccountSecrets(["plain-pass-9981"]);
  scope.addSessionValues(["c00kie-value-abcdef"]);
  withRunSecretScope(scope, () => {
    for (const input of ['<input value="plain-pass-9981">', "Expected: plain-pass-9981 cookie=c00kie-value-abcdef token=sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaa"]) {
      for (const mode of ["issue", "model"] as const) assert.deepEqual(ported(input, mode), reference(input, mode));
    }
  });
});
