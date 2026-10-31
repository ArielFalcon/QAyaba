import { test } from "node:test";
import assert from "node:assert/strict";
import { REDACTION_LOOKAHEAD_CHARS, redactThenBound } from "../../src/shared-kernel/redact-then-bound.ts";
import { redactAndBound } from "../../src/shared-infrastructure/redaction/redact-and-bound.ts";
import { sanitizeText } from "../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { CASES, RUN_PASS, base64Run, filler, headStraddle, insides, leaks, tailStraddle, withRunSecrets } from "../support/straddling-secrets.ts";

type Bound = (raw: string, max: number, keep?: "head" | "tail") => string;
const issue: Bound = (raw, max, keep) => redactAndBound(raw, max, keep ? { keep } : {});
const model: Bound = (raw, max) => redactAndBound(raw, max, { mode: "model" });
const pattern: Bound = (raw, max) => redactThenBound(raw, max, (t) => sanitizeText(t).text);

/* Every bound a producer of untrusted text uses, with the redaction it goes through. */
const BOUNDS: Array<{ max: number; keep?: "head" | "tail"; bound: Bound }> = [
  ...[40, 160, 200, 300, 400, 500, 600, 900, 1000, 2000, 4000, 12000].map((max) => ({ max, bound: issue })),
  ...[200, 300, 2000, 4000, 12000].map((max) => ({ max, bound: pattern })),
  { max: 8000, bound: model },
  ...[600, 16000].map((max) => ({ max, keep: "tail" as const, bound: issue })),
];

for (const { max, keep, bound } of BOUNDS) {
  test(`a bound of ${max} (${keep ?? "head"}, ${bound === model ? "model" : "issue"} mode) keeps no part of a secret that straddles it`, () => {
    const failures: string[] = [];
    for (const c of CASES) {
      for (const inside of insides(c.text).filter((n) => n < max - 2)) {
        const raw = keep === "tail" ? tailStraddle(c.text, max, inside) : headStraddle(c.text, max, inside);
        const out = withRunSecrets(() => bound(raw, max, keep));
        const found = leaks(out, c);
        if (found.length > 0) failures.push(`${c.name} inside=${inside} kept ${JSON.stringify(found.slice(0, 3))}`);
      }
    }
    assert.deepEqual(failures, []);
  });
}

/* Redaction that shrinks the window moves the kept end toward the window's far edge, where a secret that straddles it was never matched whole. */
const SHRINKS = [2000, 6000, 8300];
for (const shrink of SHRINKS) {
  for (const c of CASES) {
    test(`a head bound keeps no part of a ${c.name} at the edge of a window that ${shrink} characters of base64 shrank`, () => {
      const max = 200;
      const window = max + REDACTION_LOOKAHEAD_CHARS;
      const lead = `echo ${base64Run(shrink)} | base64 -d > avatar.png && npx qa-login --password `;
      const gap = window - 8 - lead.length;
      const raw = `${lead}${" ".repeat(Math.max(0, gap))} ${c.text} --headed ${filler(600)}`;
      const out = withRunSecrets(() => issue(raw, max));
      assert.deepEqual(leaks(out, c), []);
      assert.ok(out.length <= max);
    });

    test(`a tail bound keeps no part of a ${c.name} at the edge of a window that ${shrink} characters of base64 shrank`, () => {
      const max = 200;
      const window = max + REDACTION_LOOKAHEAD_CHARS;
      const trail = ` and moved on: ${base64Run(shrink)} done`;
      const gap = window - 8 - trail.length;
      const raw = `${filler(600)} ${c.text}${" ".repeat(Math.max(0, gap))}${trail}`;
      const out = withRunSecrets(() => issue(raw, max, "tail"));
      assert.deepEqual(leaks(out, c), []);
      assert.ok(out.length <= max);
    });
  }
}

test("a text the caller already cut at its far edge keeps nothing from the lookahead before that edge", () => {
  const max = 200;
  const kept = max + REDACTION_LOOKAHEAD_CHARS;
  const whole = `${filler(300)} the login form takes ${RUN_PASS} and ${base64Run(kept - 60)} done`;
  const retained = whole.slice(whole.length - kept);
  const out = withRunSecrets(() => redactAndBound(retained, max, { keep: "tail", rawIsWindow: true }));
  assert.deepEqual(leaks(out, CASES[0]!), []);
  assert.ok(out.length <= max);
});

test("a window that redaction shrank is widened for the bound's worth of text after the redacted run", () => {
  const max = 100;
  const raw = `${base64Run(5000)} ${"visible words follow ".repeat(300)}`;
  const out = issue(raw, max);
  assert.ok(out.length > max / 2, out);
  assert.ok(out.includes("visible words follow"));
});

test("a cut never lands inside a [REDACTED] marker", () => {
  const raw = `${filler(60)}password="amber falcon river twelve" ${filler(400)}`;
  for (let max = 55; max < 90; max++) {
    const head = issue(raw, max);
    assert.doesNotMatch(head, /\[R(E(D(A(C(T(E(D)?)?)?)?)?)?)?$/, `head ${max}: ${head}`);
    const tail = issue(raw, max, "tail");
    assert.doesNotMatch(tail, /^(R?E?D?A?C?T?E?D?)\]/, `tail ${max}: ${tail}`);
  }
});

test("the marker of a cut says what was kept of the original and never a negative number", () => {
  const raw = `${"password=\"abcd efgh\" ".repeat(5)}${filler(400)}`;
  const out = issue(raw, 30, undefined);
  const marked = redactAndBound(raw, 30, { marker: (original, kept) => `[kept ${kept} of ${original}]` });
  assert.match(marked, /\[kept \d+ of \d+\]$/);
  assert.doesNotMatch(marked, /-\d/);
  assert.ok(out.length <= 30);
});
