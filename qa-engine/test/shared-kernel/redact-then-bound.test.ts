import { test } from "node:test";
import assert from "node:assert/strict";
import { REDACTED } from "@kernel/ports/redaction.port.ts";
import { sanitizeText } from "../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { REDACTION_LOOKAHEAD_CHARS, redactThenBound } from "../../src/shared-kernel/redact-then-bound.ts";
import { createRunSecretScope, withRunSecretScope } from "../../src/shared-kernel/run-secret-redaction.ts";

const redact = (text: string): string => sanitizeText(text).text;
const TOKEN = `sk-${"A1b2C3d4".repeat(6)}`;

test("a token straddling the bound is redacted whole, not left as its prefix", () => {
  const raw = `${"x ".repeat(10)}${TOKEN} tail`;
  const bound = raw.indexOf(TOKEN) + 12;
  const out = redactThenBound(raw, bound, redact);
  assert.ok(!out.includes("sk-A1b2"), out);
  assert.ok(out.includes(REDACTED));
});

test("a run secret straddling the bound is redacted whole, not left as its prefix", () => {
  const password = "correct-horse-battery";
  const raw = `login failed for ${password} twice`;
  const scope = createRunSecretScope();
  scope.addAccountSecrets([password]);
  const out = withRunSecretScope(scope, () => redactThenBound(raw, raw.indexOf(password) + 8, redact));
  assert.ok(!out.includes("correct"), out);
});

test("a text within the bound comes out redacted and whole, with no marker", () => {
  const out = redactThenBound(`token ${TOKEN}`, 200, redact, { marker: () => "[cut]" });
  assert.ok(!out.includes("[cut]"));
  assert.ok(!out.includes("A1b2"));
});

test("a text past the bound is cut and the marker reports the original length", () => {
  const raw = "ab ".repeat(200);
  const out = redactThenBound(raw, 99, redact, { marker: (original, kept) => `[original ${original} kept ${kept}]` });
  assert.equal(out, `${raw.slice(0, 99)}[original 600 kept 99]`);
});

test("the tail of a text keeps the end and a secret straddling its start is gone", () => {
  const raw = `${"x ".repeat(10)}${TOKEN} end`;
  const keep = raw.length - raw.indexOf(TOKEN) - 12;
  const out = redactThenBound(raw, keep, redact, { keep: "tail" });
  assert.ok(!out.includes("A1b2C3d4"), out);
  assert.ok(out.endsWith("end"));
});

test("the redactor sees past the bound by the lookahead and no further", () => {
  const seen: number[] = [];
  redactThenBound("zy ".repeat(REDACTION_LOOKAHEAD_CHARS), 50, (text) => (seen.push(text.length), text));
  assert.deepEqual(seen, [50 + REDACTION_LOOKAHEAD_CHARS]);
});

test("a redactor that fails yields a marker, never the raw text", () => {
  const out = redactThenBound("secret", 100, () => {
    throw new Error("boom");
  });
  assert.equal(out, "[redacted]");
});
