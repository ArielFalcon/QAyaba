import { test } from "node:test";
import assert from "node:assert/strict";
import { REDACTED, SecretLeakError, type RedactionPort } from "@kernel/ports/redaction.port.ts";
import { PatternRedactionAdapter, assertNoSecretLeak } from "../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { createRunSecretScope, withRunSecretScope } from "../../../src/shared-infrastructure/redaction/run-secret-redaction.ts";

const port: RedactionPort = new PatternRedactionAdapter();

test("a mixed secret, address and email line loses every sensitive part and keeps the host key", () => {
  const input = "apiKey=sk-abc123XYZ host=10.0.3.14 email leaker@example.com token: ghs_supersecretvalue";
  assert.equal(port.redact(input), `${REDACTED} host=${REDACTED} email ${REDACTED} ${REDACTED}`);
  assert.deepEqual(port.detect(input), { redacted: true, patterns: ["api-key-assignment"], count: 2 });
});

test("a connection string loses its password and keeps the host", () => {
  assert.equal(port.redact("DATABASE_URL=postgres://admin:s3cr3tP4ss@db.internal:5432/app"), `DATABASE_URL=postgres://${REDACTED}@db.internal:5432/app`);
});

test("a bearer token is redacted whole", () => {
  const input = "Authorization: Bearer eyJhbGciOi.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4";
  assert.equal(port.redact(input), REDACTED);
  assert.deepEqual(port.detect(input).patterns, ["bearer-token"]);
});

test("a base64 data URI, a clean URL, a git SHA and the empty string pass through unchanged", () => {
  for (const input of [`<img src="data:image/png;base64,${"A".repeat(60)}">`, "fetch('https://api.example.com/v1/users?page=2')", "commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 landed", ""]) {
    assert.equal(port.redact(input), input);
    assert.deepEqual(port.detect(input), { redacted: false, patterns: [], count: 0 });
  }
});

test("issue mode redacts a keyword assignment even when the value is only a type or a call", () => {
  const input = "password: string; token = getToken();";
  assert.equal(port.redact(input), `${REDACTED} ${REDACTED}`);
  assert.equal(port.redact(input, "issue"), port.redact(input));
});

test("model mode keeps a type annotation and a call expression and still redacts a quoted literal", () => {
  assert.equal(port.redact("password: string;", "model"), "password: string;");
  assert.equal(port.redact("const token = getToken();", "model"), "const token = getToken();");
  assert.equal(port.redact('const password = "hunter2";', "model"), `const ${REDACTED};`);
  assert.equal(port.detect("password: string;", "model").redacted, false);
});

test("containsSecret flags a real secret, not clean text, and model mode does not flag a type annotation", () => {
  assert.equal(port.containsSecret("token: ghs_supersecretvalue123456789012345678"), true);
  assert.equal(port.containsSecret("fetch('https://api.example.com/v1/users?page=2')"), false);
  assert.equal(port.containsSecret("password: string;", "model"), false);
});

test("an embedded quote in a bare value does not leak the tail", () => {
  assert.equal(port.redact('token=abc"def'), REDACTED);
  assert.equal(port.redact('GITHUB_TOKEN=ghp_abc"XYZ123'), REDACTED);
  assert.equal(port.redact('leaked secret: password="mySecretPass\\"WithQuote" end'), `leaked ${REDACTED} end`);
});

test("a balanced-quote name holding a keyword is redacted without corrupting the surrounding markup", () => {
  assert.equal(
    port.redact("role:name 'button' with name \"Token: refresh\" is NOT in the captured tree"),
    `role:name 'button' with name "${REDACTED}" is NOT in the captured tree`,
  );
});

test("assertNoSecretLeak throws SecretLeakError when a secret survives and stays quiet on clean text", () => {
  assert.throws(() => assertNoSecretLeak("token: ghs_supersecretvalue123456789012345678", "issue", "diff→model"), (e: unknown) => e instanceof SecretLeakError && /a secret survived redaction/.test(e.message));
  assert.doesNotThrow(() => assertNoSecretLeak("no secrets here", "issue", "diff→model"));
});

test("the run's own secrets are taken out by value before the patterns, in every mode", () => {
  const scope = createRunSecretScope();
  scope.addAccountSecrets(["plain-pass-9981"]);
  scope.addSessionValues(["c00kie-value-abcdef"]);
  withRunSecretScope(scope, () => {
    for (const mode of ["issue", "model"] as const) {
      const out = port.redact("Expected: plain-pass-9981 cookie=c00kie-value-abcdef token=sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaa", mode);
      assert.ok(!out.includes("plain-pass-9981") && !out.includes("c00kie-value-abcdef"));
      assert.ok(port.detect('<input value="plain-pass-9981">', mode).patterns.includes("run-secret"));
    }
  });
  assert.equal(port.redact("plain-pass-9981"), "plain-pass-9981");
});
