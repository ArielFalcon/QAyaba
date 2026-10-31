import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeText, containsSecrets } from "../../engine/src/shared-infrastructure/redaction/pattern-redaction.adapter";
import { RedactionPortAdapter } from "./sanitizer";

/* RedactionPortAdapter must detect a secret VALUE present verbatim in text, driven by env VAR
   NAME heuristics (the env-derived secret values the redaction adapter reads), even when no
   NAMED_SECRET_PATTERNS entry recognizes the value's shape. Fixtures below are values pattern-based
   sanitizeText alone genuinely misses (verified live: "oc-LIVE-key-998877" matches no
   NAMED_SECRET_PATTERNS entry at all; "superSecretToken42" is a 19-char bare token, one short of the
   llm-api-key pattern's 20-char minimum).
 */
test("RedactionPortAdapter.redact detects an env-value secret patterns alone would miss (no NAMED_SECRET_PATTERNS match)", () => {
  const env = { OPENCODE_API_KEY: "oc-LIVE-key-998877" };
  const adapter = new RedactionPortAdapter(env);
  /* Baseline: pattern-only sanitizeText genuinely misses this shape (proves the fixture is real). */
  assert.match(sanitizeText("provider rejected key oc-LIVE-key-998877").text, /oc-LIVE-key-998877/);
  const out = adapter.redact("provider rejected key oc-LIVE-key-998877");
  assert.doesNotMatch(out, /oc-LIVE-key-998877/);
  assert.match(out, /\[REDACTED\]/);
});

test("RedactionPortAdapter.redact detects a second env-value gap fixture (bare token below the llm-api-key pattern's length floor)", () => {
  const env = { SERVICE_API_KEY: "superSecretToken42" };
  const adapter = new RedactionPortAdapter(env);
  assert.match(sanitizeText("runtime exited 1: bad service key superSecretToken42").text, /superSecretToken42/);
  const out = adapter.redact("runtime exited 1: bad service key superSecretToken42");
  assert.doesNotMatch(out, /superSecretToken42/);
  assert.match(out, /\[REDACTED\]/);
});

test("RedactionPortAdapter.redact applies env-value AND pattern-based detection together (both mechanisms coexist, no class lost)", () => {
  const env = { OPENCODE_API_KEY: "oc-LIVE-key-998877" };
  const adapter = new RedactionPortAdapter(env);
  const out = adapter.redact("env leak oc-LIVE-key-998877 alongside a pattern hit token=ghs_supersecretvalue");
  assert.doesNotMatch(out, /oc-LIVE-key-998877/);
  assert.doesNotMatch(out, /ghs_supersecretvalue/);
  assert.match(out, /\[REDACTED\]/);
});

test("RedactionPortAdapter.redact ignores env values shorter than the 6-char floor (parity with redact.ts's MIN_SECRET_LEN)", () => {
  const env = { SHORT_TOKEN: "abcde" }; /* 5 chars, below the floor */
  const adapter = new RedactionPortAdapter(env);
  const out = adapter.redact("value is abcde here");
  assert.match(out, /abcde/); /* untouched — too short to treat as a real secret value */
});

test("RedactionPortAdapter.redact ignores env vars whose NAME does not look like a secret (no false positive)", () => {
  const env = { APP_NAME: "not-a-secret-value" };
  const adapter = new RedactionPortAdapter(env);
  const out = adapter.redact("app is called not-a-secret-value");
  assert.match(out, /not-a-secret-value/);
});

test("RedactionPortAdapter() with no injected env defaults to process.env (real shell consumers stay covered)", () => {
  const key = "QAYABA_TEST_ENV_ADAPTER_TOKEN";
  const value = "processEnvDefaultSecretABC123";
  process.env[key] = value;
  try {
    const adapter = new RedactionPortAdapter();
    const out = adapter.redact(`leaked ${value} in output`);
    assert.doesNotMatch(out, new RegExp(value));
  } finally {
    delete process.env[key];
  }
});

test("RedactionPortAdapter.redactText is a shell-consumer alias for redact (env+pattern)", () => {
  const env = { OPENCODE_API_KEY: "oc-LIVE-key-998877" };
  const adapter = new RedactionPortAdapter(env);
  const out = adapter.redactText("leak oc-LIVE-key-998877 here");
  assert.doesNotMatch(out, /oc-LIVE-key-998877/);
  assert.match(out, /\[REDACTED\]/);
});

test("RedactionPortAdapter.redactError unwraps an Error instance through env+pattern redaction", () => {
  const env = { SERVICE_API_KEY: "superSecretToken42" };
  const adapter = new RedactionPortAdapter(env);
  const out = adapter.redactError(new Error("runtime exited 1: bad service key superSecretToken42"));
  assert.doesNotMatch(out, /superSecretToken42/);
  assert.match(out, /\[REDACTED\]/);
});

test("RedactionPortAdapter.redactError stringifies a non-Error thrown value", () => {
  const adapter = new RedactionPortAdapter({});
  const out = adapter.redactError("plain string failure");
  assert.equal(out, "plain string failure");
});

test("RedactionPortAdapter with no secret-named env values redacts exactly like the pattern policy, in both modes", () => {
  const input = "apiKey=sk-abc123XYZ host=10.0.3.14 email leaker@example.com token: ghs_supersecretvalue password: string";
  const adapter = new RedactionPortAdapter({});
  for (const mode of ["issue", "model"] as const) {
    assert.equal(adapter.redact(input, mode), sanitizeText(input, mode).text);
    assert.deepEqual(adapter.detect(input, mode), sanitizeText(input, mode).detection);
    assert.equal(adapter.containsSecret(input, mode), containsSecrets(input, mode));
  }
});
