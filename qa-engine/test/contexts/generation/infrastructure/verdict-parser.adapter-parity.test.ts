/* these two copies must stay byte-compatible; engine cannot import src/ */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VerdictParserAdapter } from "@contexts/generation/infrastructure/verdict-parser.adapter.ts";
import { parseVerdict } from "../../../../../src/integrations/verdict-parse.ts";
import { parseReviewerVerdict } from "../../../../../src/integrations/verdict-validate.ts";

function makeRealAdapter(): VerdictParserAdapter {
  return new VerdictParserAdapter({ parseVerdict, parseReviewerVerdict });
}

test("PARITY: parseGenerator on a valid generator verdict matches legacy parseVerdict output", () => {
  const text = JSON.stringify({ specs: ["login.spec.ts", "checkout.spec.ts"], note: "all flows covered" });
  const adapter = makeRealAdapter();
  const got = adapter.parseGenerator(text);
  const legacy = parseVerdict(text);
  /* specs must match — a gutted adapter returning [] FAILS this */
  assert.deepEqual(got.specs, legacy.specs ?? []);
  /* parsed flag forwarded — a gutted adapter always returning parsed:true on garbage FAILS the miss test below */
  assert.equal(got.parsed, legacy.parsed);
  assert.equal(got.note, legacy.note);
});

test("PARITY: parseGenerator reads a declared no-op's reason the way the legacy parser does, and never reads `approved` as one", () => {
  const adapter = makeRealAdapter();
  const declared = JSON.stringify({ specs: [], noop: { reason: "nothing worth an E2E test" } });
  assert.equal(adapter.parseGenerator(declared).noopReason, "nothing worth an E2E test");
  assert.equal(adapter.parseGenerator(declared).noopReason, parseVerdict(declared).noopReason);
  for (const undecided of ['{"specs":[],"approved":true}', '{"approved":true}', '{"specs":[],"noop":{"reason":"  "}}']) {
    assert.equal("noopReason" in adapter.parseGenerator(undecided), false, undecided);
    assert.equal(parseVerdict(undecided).noopReason, undefined, undecided);
  }
});

test("PARITY: parseGenerator on a parse miss is fail-closed — matches legacy parsed:false output", () => {
  const text = "the agent wrote prose with no JSON verdict";
  const adapter = makeRealAdapter();
  const got = adapter.parseGenerator(text);
  const legacy = parseVerdict(text);
  /* parsed:false is the contract on a miss; a gutted adapter returning parsed:true FAILS this */
  assert.equal(got.parsed, false);
  assert.equal(got.parsed, legacy.parsed);
  assert.deepEqual(got.specs, []);
  assert.deepEqual(got.specs, legacy.specs ?? []);
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

test("PARITY: parseGenerator with specMetas forwards them — a gutted adapter that drops specMetas FAILS", () => {
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

test("PARITY: parseReview on a valid reviewer approval matches legacy parseReviewerVerdict output", () => {
  const text = JSON.stringify({ approved: true, rationale: "all flows exercised", corrections: [] });
  const adapter = makeRealAdapter();
  const got = adapter.parseReview(text);
  const legacy = parseReviewerVerdict(text);
  assert.equal(got.approved, true);
  assert.equal(got.approved, legacy.approved);
  assert.equal(got.blockingCount, 0);
  assert.equal(got.blockingCount, legacy.blockingCount);
  assert.equal(got.valid, true);
  assert.equal(got.valid, legacy.valid);
});

test("PARITY: parseReview on a reviewer rejection forwards blockingCount and corrections", () => {
  const text = JSON.stringify({
    approved: false,
    rationale: "missing assertion on discount",
    corrections: ["[false-positive] checkout.spec.ts: asserts nothing about the discount total"],
  });
  const adapter = makeRealAdapter();
  const got = adapter.parseReview(text);
  const legacy = parseReviewerVerdict(text);
  assert.equal(got.approved, false);
  assert.equal(got.approved, legacy.approved);
  /* blockingCount — the grave [false-positive] tag must make this >=1 per effectiveSeverity logic */
  assert.ok((got.blockingCount ?? 0) >= 1, "a grave-tagged correction must produce blockingCount >= 1");
  assert.equal(got.blockingCount, legacy.blockingCount);
});

test("PARITY: parseReview on a parse miss is fail-closed — matches legacy parsed:false output", () => {
  const text = "the reviewer wrote prose but no JSON";
  const adapter = makeRealAdapter();
  const got = adapter.parseReview(text);
  const legacy = parseReviewerVerdict(text);
  /* fail-closed: approved must be false on a miss */
  assert.equal(got.approved, false);
  assert.equal(got.approved, legacy.approved);
  assert.equal(got.parsed, false);
  assert.equal(got.parsed, legacy.parsed);
  /* issues forwarded — the bounded repair loop reads them; a gutted adapter returning [] loses the repair fuel */
  assert.ok(Array.isArray(got.issues) && got.issues.length > 0,
    "issues must be non-empty on a parse miss — a gutted adapter FAILS this");
  assert.deepEqual(got.issues, legacy.issues);
});
