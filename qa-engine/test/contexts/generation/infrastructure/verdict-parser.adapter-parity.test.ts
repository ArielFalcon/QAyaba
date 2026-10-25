/* these two copies must stay byte-compatible; engine cannot import src/ */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VerdictParserAdapter } from "@contexts/generation/infrastructure/verdict-parser.adapter.ts";
import { GENERATION_NOTE_MAX_CHARS } from "@contexts/generation/domain/generation-end.ts";
import { parseVerdict } from "../../../../../src/integrations/verdict-parse.ts";
import { parseReviewerVerdict } from "../../../../../src/integrations/verdict-validate.ts";

function makeRealAdapter(): VerdictParserAdapter {
  return new VerdictParserAdapter({ parseVerdict, parseReviewerVerdict });
}

test("parseGenerator on a valid generator verdict", () => {
  const text = JSON.stringify({ specs: ["login.spec.ts", "checkout.spec.ts"], note: "all flows covered" });
  const adapter = makeRealAdapter();
  const got = adapter.parseGenerator(text);
  const reference = parseVerdict(text);
  /* specs must match — a gutted adapter returning [] FAILS this */
  assert.deepEqual(got.specs, reference.specs ?? []);
  /* parsed flag forwarded — a gutted adapter always returning parsed:true on garbage FAILS the miss test below */
  assert.equal(got.parsed, reference.parsed);
  assert.equal(got.note, reference.note);
});

test("and never reads `approved` as one", () => {
  const adapter = makeRealAdapter();
  const declared = JSON.stringify({ specs: [], noop: { reason: "nothing worth an E2E test" } });
  assert.equal(adapter.parseGenerator(declared).noopReason, "nothing worth an E2E test");
  assert.equal(adapter.parseGenerator(declared).noopReason, parseVerdict(declared).noopReason);
  for (const undecided of ['{"specs":[],"approved":true}', '{"approved":true}', '{"specs":[],"noop":{"reason":"  "}}']) {
    assert.equal("noopReason" in adapter.parseGenerator(undecided), false, undecided);
    assert.equal(parseVerdict(undecided).noopReason, undefined, undecided);
  }
});

test("parseGenerator on a parse miss is fail-closed —", () => {
  const text = "the agent wrote prose with no JSON verdict";
  const adapter = makeRealAdapter();
  const got = adapter.parseGenerator(text);
  const reference = parseVerdict(text);
  /* parsed:false is the contract on a miss; a gutted adapter returning parsed:true FAILS this */
  assert.equal(got.parsed, false);
  assert.equal(got.parsed, reference.parsed);
  assert.deepEqual(got.specs, []);
  assert.deepEqual(got.specs, reference.specs ?? []);
});

/* specs is the list of spec paths the run executes; an entry that is not a path string makes the
   verdict unparseable, never a crash and never a shorter list read as the agent's decision. */
test("a generator verdict listing a spec that is not a path string is a parse miss, with or without a suite dir", () => {
  const specDir = mkdtempSync(join(tmpdir(), "verdict-specs-"));
  try {
    const adapter = makeRealAdapter();
    for (const specs of [[{ path: "flows/a.spec.ts" }], [1], ["flows/a.spec.ts", null]]) {
      const text = JSON.stringify({ specs });
      for (const dir of [specDir, undefined]) {
        const got = adapter.parseGenerator(text, dir);
        assert.equal(got.parsed, false, `${text} (suite dir: ${dir !== undefined})`);
        assert.deepEqual(got.specs, [], `${text} (suite dir: ${dir !== undefined})`);
      }
    }
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("parseGenerator with specMetas forwards them — a gutted adapter that drops specMetas FAILS", () => {
  const specMetas = [
    { file: "flows/login.spec.ts", flow: "login", objective: "user can log in", targets: ["src/auth.ts"] },
  ];
  const text = JSON.stringify({ specs: ["flows/login.spec.ts"], specMetas });
  const adapter = makeRealAdapter();
  const got = adapter.parseGenerator(text);
  /* specMetas must survive the adapter — a gutted impl that drops them returns undefined here */
  assert.ok(got.specMetas, "specMetas must be forwarded — a gutted adapter FAILS this");
  assert.equal(got.specMetas?.[0]?.file, "flows/login.spec.ts");
});

test("parseReview on a valid reviewer approval", () => {
  const text = JSON.stringify({ approved: true, rationale: "all flows exercised", corrections: [] });
  const adapter = makeRealAdapter();
  const got = adapter.parseReview(text);
  const reference = parseReviewerVerdict(text);
  assert.equal(got.approved, true);
  assert.equal(got.approved, reference.approved);
  assert.equal(got.blockingCount, 0);
  assert.equal(got.blockingCount, reference.blockingCount);
  assert.equal(got.valid, true);
  assert.equal(got.valid, reference.valid);
});

test("parseReview on a reviewer rejection forwards blockingCount and corrections", () => {
  const text = JSON.stringify({
    approved: false,
    rationale: "missing assertion on discount",
    corrections: ["[false-positive] checkout.spec.ts: asserts nothing about the discount total"],
  });
  const adapter = makeRealAdapter();
  const got = adapter.parseReview(text);
  const reference = parseReviewerVerdict(text);
  assert.equal(got.approved, false);
  assert.equal(got.approved, reference.approved);
  /* blockingCount — the grave [false-positive] tag must make this >=1 per effectiveSeverity logic */
  assert.ok((got.blockingCount ?? 0) >= 1, "a grave-tagged correction must produce blockingCount >= 1");
  assert.equal(got.blockingCount, reference.blockingCount);
});

test("parseGenerator forwards a typed test-correct claim the reference parser read", () => {
  const text = JSON.stringify({ specs: [], testCorrect: { cause: "env", reason: "DEV did not render the discount" } });
  const adapter = makeRealAdapter();
  const got = adapter.parseGenerator(text);
  const reference = parseVerdict(text);
  assert.deepEqual(got.testCorrect, { cause: "env", reason: "DEV did not render the discount" });
  assert.deepEqual(got.testCorrect, reference.testCorrect);
  assert.equal(got.parsed, true, "a closing verdict carrying only a claim is a parse, not a miss");
  assert.equal(got.parsed, reference.parsed);
});

test("bounded and redacted", () => {
  const rebuttal = { finding: "[false-positive] a.spec.ts: asserts nothing", basis: "execution", ref: "a.spec.ts", reason: "the case ran green" };
  const text = JSON.stringify({ specs: [], rebuttals: [rebuttal] });
  const adapter = makeRealAdapter();
  const got = adapter.parseGenerator(text);
  assert.deepEqual(got.rebuttals, [rebuttal]);
  assert.deepEqual(got.rebuttals, parseVerdict(text).rebuttals);
  assert.equal(got.parsed, true, "a closing verdict carrying only a rebuttal is a parse, not a miss");

  const token = `ghp_${"A".repeat(36)}`;
  const secret = adapter.parseGenerator(JSON.stringify({ specs: [], rebuttals: [{ ...rebuttal, reason: `the case ran green with ${token}` }] }));
  assert.ok(secret.rebuttals);
  assert.equal(secret.rebuttals![0]!.reason.includes(token), false, "the reason carries no secret");
});

test("a rebuttal without a checkable basis is no rebuttal, never a claim the run could weigh", () => {
  const adapter = makeRealAdapter();
  for (const entry of [
    '{"finding":"a.spec.ts","reason":"trust me"}',
    '{"finding":"a.spec.ts","basis":"opinion","ref":"a.spec.ts","reason":"trust me"}',
    '{"finding":"","basis":"execution","ref":"a.spec.ts","reason":"trust me"}',
    'true',
    '"execution"',
  ]) {
    const text = `{"specs":[],"rebuttals":[${entry}]}`;
    assert.equal("rebuttals" in adapter.parseGenerator(text), false, entry);
    assert.equal(parseVerdict(text).rebuttals, undefined, entry);
  }
});

test("a malformed test-correct claim is no claim, never a cause the loop could verify", () => {
  const adapter = makeRealAdapter();
  for (const claim of ['{"cause":"env"}', '{"cause":"env","reason":"   "}', '{"cause":"other","reason":"x"}', "true", '"app"']) {
    const text = `{"specs":[],"testCorrect":${claim}}`;
    assert.equal("testCorrect" in adapter.parseGenerator(text), false, claim);
    assert.equal(parseVerdict(text).testCorrect, undefined, claim);
  }
});

test("a test-correct reason is redacted and bounded before it reaches the run", () => {
  const token = `ghp_${"A".repeat(36)}`;
  const adapter = makeRealAdapter();
  const got = adapter.parseGenerator(JSON.stringify({ specs: [], testCorrect: { cause: "app", reason: `the server rejected ${token}` } }));
  assert.ok(got.testCorrect);
  assert.equal(got.testCorrect!.reason.includes(token), false, "the reason carries no secret");
  assert.ok(got.testCorrect!.reason.length <= GENERATION_NOTE_MAX_CHARS);

  const longReason = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
  const long = adapter.parseGenerator(JSON.stringify({ specs: [], testCorrect: { cause: "app", reason: longReason } }));
  assert.equal(long.testCorrect!.reason.length, GENERATION_NOTE_MAX_CHARS);
});

test("parseReview on a parse miss is fail-closed —", () => {
  const text = "the reviewer wrote prose but no JSON";
  const adapter = makeRealAdapter();
  const got = adapter.parseReview(text);
  const reference = parseReviewerVerdict(text);
  /* fail-closed: approved must be false on a miss */
  assert.equal(got.approved, false);
  assert.equal(got.approved, reference.approved);
  assert.equal(got.parsed, false);
  assert.equal(got.parsed, reference.parsed);
  /* issues forwarded — the bounded repair loop reads them; a gutted adapter returning [] loses the repair fuel */
  assert.ok(Array.isArray(got.issues) && got.issues.length > 0,
    "issues must be non-empty on a parse miss — a gutted adapter FAILS this");
  assert.deepEqual(got.issues, reference.issues);
});
