import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { VerdictParserAdapter, listSuiteSpecFiles } from "@contexts/generation/infrastructure/verdict-parser.adapter.ts";
import { GENERATION_NOTE_MAX_CHARS } from "@contexts/generation/domain/generation-end.ts";
import type { ReviewerVerdict } from "@contexts/generation/domain/verdict-validate.ts";
import { createRunSecretScope, withRunSecretScope } from "../../../../src/shared-kernel/run-secret-redaction.ts";
import { REVIEW_CORRECTION_MAX_CHARS, REVIEW_RATIONALE_MAX_CHARS } from "@contexts/generation/domain/review-output.ts";

const reviewer = (verdict: Partial<ReviewerVerdict>): ReviewerVerdict => ({ approved: true, findings: [], blockingCount: 0, parsed: true, valid: true, issues: [], ...verdict });
const NO_VERDICT_READER = new VerdictParserAdapter({ readVerdict: () => ({ parsed: true, specs: [] }) });

test("readReview forwards approved + blockingCount + parsed + valid (no behavior drop)", () => {
  const j = NO_VERDICT_READER.readReview(reviewer({ approved: true }));
  assert.equal(j.approved, true);
  assert.equal(j.blockingCount, 0);   /* forwarded — a port that dropped it would be undefined here */
  assert.equal(j.parsed, true);       /* forwarded — the parse-miss round-saver survives */
  assert.equal(j.valid, true);
  assert.deepEqual(j.issues, []);
});

test("what the reviewer's submission set aside is forwarded as the issues the record keeps, each with where it was", () => {
  const j = NO_VERDICT_READER.readReview(reviewer({ issues: [{ path: "corrections.1.severity", reason: "no severity" }, { path: "corrections", reason: "not a list" }] }));
  assert.deepEqual(j.issues, ["corrections.1.severity: no severity", "corrections: not a list"]);
});

test("readGenerator delegates to readVerdict and returns the specs of the accepted submission", () => {
  let seen: Record<string, unknown> | undefined;
  const adapter = new VerdictParserAdapter({ readVerdict: (answer) => { seen = answer; return { parsed: true, approved: true, specs: ["login.spec.ts"], note: "ok" }; } });
  const answer = { specs: ["login.spec.ts"], note: "ok" };
  const d = adapter.readGenerator({ answer, output: "text" });
  assert.equal(seen, answer); /* DELEGATION: a gutted impl that ignores the injected fn FAILS this */
  assert.deepEqual(d.specs, ["login.spec.ts"]);
  assert.equal(d.note, "ok");
});

test("readGenerator forwards parsed + specMetas (fail-closed + manifest upsert survive)", () => {
  const specMetas = [{ file: "login.spec.ts", flow: "login", objective: "sign in", targets: ["src/auth.ts"], sha256: "abc" }];
  const adapter = new VerdictParserAdapter({ readVerdict: () => ({ parsed: true, approved: true, specs: ["login.spec.ts"], note: "ok", specMetas }) });
  const d = adapter.readGenerator({ answer: {}, output: "" });
  assert.equal(d.parsed, true);                 /* the #1 fail-closed invariant — a port that dropped it would be undefined here */
  assert.deepEqual(d.specMetas, specMetas);     /* drives the disk-reconciled manifest upsert — gutted-impl-proof */
});

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz1234";

function adapterReading(verdict: Record<string, unknown>): VerdictParserAdapter {
  return new VerdictParserAdapter({ readVerdict: () => ({ parsed: true, specs: [], ...verdict }) as never });
}
const delivered = { answer: {}, output: "" };

test("readGenerator forwards the generator's no-op reason", () => {
  const d = adapterReading({ noopReason: "The diff only renames an internal helper." }).readGenerator(delivered);
  assert.equal(d.noopReason, "The diff only renames an internal helper.");
});

test("readGenerator leaves the no-op reason out when the verdict gave none", () => {
  const d = adapterReading({}).readGenerator(delivered);
  assert.equal("noopReason" in d, false);
});

test("readGenerator redacts secrets in the no-op reason before it leaves the adapter", () => {
  const d = adapterReading({ noopReason: `Nothing to test; the key ${SECRET} was in the diff.` }).readGenerator(delivered);
  assert.doesNotMatch(d.noopReason ?? "", /sk-abcdefghijklmnopqrstuvwxyz1234/);
  assert.match(d.noopReason ?? "", /\[REDACTED\]/);
  assert.match(d.noopReason ?? "", /^Nothing to test/);
});

test("readGenerator bounds the no-op reason to the note bound, keeping its start", () => {
  const d = adapterReading({ noopReason: `START ${"r".repeat(GENERATION_NOTE_MAX_CHARS * 3)}` }).readGenerator(delivered);
  assert.ok((d.noopReason ?? "").length <= GENERATION_NOTE_MAX_CHARS);
  assert.ok((d.noopReason ?? "").startsWith("START"));
});

test("readGenerator forwards the end of the output, redacted, and bounded to the note bound", () => {
  const output = `HEAD ${"lorem ".repeat(GENERATION_NOTE_MAX_CHARS)} key ${SECRET} THE-END`;
  const d = adapterReading({}).readGenerator({ answer: {}, output });
  const tail = d.outputTail ?? "";
  assert.ok(tail.length <= GENERATION_NOTE_MAX_CHARS, `${tail.length} chars`);
  assert.ok(tail.endsWith("THE-END"));
  assert.ok(!tail.includes("HEAD"));
  assert.doesNotMatch(tail, /sk-abcdefghijklmnopqrstuvwxyz1234/);
  assert.match(tail, /\[REDACTED\]/);
});

test("readGenerator forwards a short output whole and no tail for an empty one", () => {
  assert.equal(adapterReading({}).readGenerator({ answer: {}, output: "short output" }).outputTail, "short output");
  for (const blank of ["", "  \n "]) {
    assert.equal("outputTail" in adapterReading({}).readGenerator({ answer: {}, output: blank }), false, JSON.stringify(blank));
  }
});

test("readGenerator on a turn that delivered no submission is fail-closed (parsed:false, no specs) and carries the reason, redacted and bounded", () => {
  const adapter = new VerdictParserAdapter({ readVerdict: () => { throw new Error("no accepted submission is ever read"); } });
  const d = adapter.readGenerator({ noSubmission: `no accepted submission; key ${SECRET} ${"x".repeat(GENERATION_NOTE_MAX_CHARS)}`, output: "prose" });
  assert.equal(d.parsed, false);     /* a miss is NOT a deliberate no-op — the use-case branches on this */
  assert.deepEqual(d.specs, []);
  assert.doesNotMatch(d.note ?? "", /sk-abcdefghijklmnopqrstuvwxyz1234/);
  assert.ok((d.note ?? "").length <= GENERATION_NOTE_MAX_CHARS);
  assert.match(d.note ?? "", /^no accepted submission/);
});

/* A suite on disk (the e2e/ spec dir) holding the given suite-relative files, under the OS temp dir. */
function suiteWith(files: string[]): string {
  const specDir = mkdtempSync(join(tmpdir(), "verdict-suite-"));
  for (const file of files) {
    mkdirSync(dirname(join(specDir, file)), { recursive: true });
    writeFileSync(join(specDir, file), "export {};\n");
  }
  return specDir;
}

/* The generator reported `specs`, each with a specMetas entry naming the same file. */
function reporting(specs: string[]): VerdictParserAdapter {
  return new VerdictParserAdapter({
    readVerdict: () => ({ parsed: true, approved: true, specs, specMetas: specs.map((file) => ({ file, flow: `flow-${file}`, objective: "o", targets: [] })) }),
  });
}

function reportedPaths(specs: string[], suite: string[] | undefined): { specs: string[]; metaFiles: (string | undefined)[] } {
  const specDir = suite ? suiteWith(suite) : undefined;
  try {
    const d = reporting(specs).readGenerator(delivered, specDir);
    return { specs: d.specs, metaFiles: (d.specMetas ?? []).map((m) => m.file) };
  } finally {
    if (specDir) rmSync(specDir, { recursive: true, force: true });
  }
}

test("a bare spec name resolves to the one suite spec of that name, in specs and specMetas", () => {
  const { specs, metaFiles } = reportedPaths(["login.spec.ts"], ["flows/login.spec.ts", "flows/cart.spec.ts"]);
  assert.deepEqual(specs, ["flows/login.spec.ts"]);
  assert.deepEqual(metaFiles, ["flows/login.spec.ts"]);
});

test("a bare spec name that several suite specs share is kept as reported", () => {
  assert.deepEqual(reportedPaths(["login.spec.ts"], ["user/login.spec.ts", "admin/login.spec.ts"]).specs, ["login.spec.ts"]);
});

test("a suite-relative path, a root-level spec and an unknown name are kept as reported", () => {
  const reported = ["flows/login.spec.ts", "home.spec.ts", "missing.spec.ts"];
  assert.deepEqual(reportedPaths(reported, ["flows/login.spec.ts", "home.spec.ts", "flows/home.spec.ts"]).specs, reported);
});

test("specs inside installed packages never make a bare name ambiguous", () => {
  assert.deepEqual(reportedPaths(["login.spec.ts"], ["flows/login.spec.ts", "node_modules/pkg/login.spec.ts"]).specs, ["flows/login.spec.ts"]);
});

test("without a spec dir reported names are kept as they are", () => {
  assert.deepEqual(reportedPaths(["login.spec.ts"], undefined).specs, ["login.spec.ts"]);
});

/* The suite is a directory the agent writes into: it is walked by the one walk of the specs, which follows no link and looks at no more than a cap of entries. */
test("the suite listing is every spec below the suite as a suite-relative, '/'-separated path, and follows no link out of it", () => {
  const specDir = suiteWith(["a.spec.ts", "flows/b.spec.ts", "flows/deep/c.spec.ts", "flows/notes.txt", "node_modules/pkg/x.spec.ts", ".cache/y.spec.ts"]);
  const outside = mkdtempSync(join(tmpdir(), "verdict-outside-"));
  try {
    writeFileSync(join(outside, "elsewhere.spec.ts"), "export {};\n");
    symlinkSync(outside, join(specDir, "flows", "hop"));

    assert.deepEqual(listSuiteSpecFiles(specDir).sort(), ["a.spec.ts", "flows/b.spec.ts", "flows/deep/c.spec.ts"]);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("the suite listing looks at no more than the cap of entries it is given, so a suite the agent flooded does not fill the orchestrator", () => {
  const specDir = suiteWith(["a.spec.ts", "b.spec.ts", "c.spec.ts", "d.spec.ts"]);
  try {
    assert.equal(listSuiteSpecFiles(specDir, 4).length, 4, "exactly the cap is listed whole");
    assert.equal(listSuiteSpecFiles(specDir, 3).length, 3, "one entry past it is not looked at");
    assert.ok(listSuiteSpecFiles(specDir).length > 0, "without a cap of its own it is held to the production one");
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

/* The reviewer's verdict is a verdict, not a report: whatever it wrote in the fields, the record keeps approval preserved, a one/two-sentence rationale and a handful of corrections. */

test("a reviewer verdict with a long rationale and many long corrections is bounded, never stored whole", () => {
  const j = NO_VERDICT_READER.readReview(
    reviewer({
      approved: false,
      rationale: "r".repeat(900),
      findings: Array.from({ length: 9 }, (_, i) => ({ text: `[false-positive] spec: correction ${i} ${"c".repeat(500)}`, severity: "blocking" as const })),
      blockingCount: 9,
    }),
  );

  assert.equal(j.approved, false, "the verdict itself is untouched");
  assert.ok((j.rationale ?? "").length <= 320, `rationale capped, got ${j.rationale?.length}`);
  assert.ok(j.findings.length <= 6, `findings capped, got ${j.findings.length}`);
  for (const finding of j.findings) assert.ok(finding.text.length <= 400, `finding capped, got ${finding.text.length}`);
  assert.equal(j.blockingCount, 9, "the blocking count is the reviewer's own, never reduced by the display cap");
});

test("an approval keeps its rationale, bounded, and is not turned into a rejection by the caps", () => {
  const j = NO_VERDICT_READER.readReview(reviewer({ approved: true, rationale: `${"The discount is asserted end to end. ".repeat(40)}` }));
  assert.equal(j.approved, true);
  assert.ok((j.rationale ?? "").length <= 320);
  assert.match(j.rationale ?? "", /discount/);
});

test("a blocking finding moved ahead of an advisory one keeps its own severity and citation", () => {
  const j = NO_VERDICT_READER.readReview(
    reviewer({
      approved: false,
      findings: [
        { text: "[missing-case] the empty search is not tested", severity: "advisory", citation: { kind: "arm", ref: "src/search.ts:12" } },
        { text: "[false-positive] b.spec.ts asserts nothing", severity: "blocking", citation: { kind: "execution", ref: "b.spec.ts" } },
      ],
      blockingCount: 1,
    }),
  );

  assert.deepEqual(j.findings, [
    { text: "[false-positive] b.spec.ts asserts nothing", severity: "blocking", citation: { kind: "execution", ref: "b.spec.ts" } },
    { text: "[missing-case] the empty search is not tested", severity: "advisory", citation: { kind: "arm", ref: "src/search.ts:12" } },
  ]);
});

test("a run secret of several words straddling the cap of the reviewer's rationale or a finding leaves no word of itself in the judgment", () => {
  const passphrase = "tangerine staple orbit nine";
  const filler = "the page header renders before the data arrives and ";
  const text = (cap: number): string => `${filler.repeat(Math.ceil(cap / filler.length)).slice(0, cap - 20)}${passphrase} and then more words`;
  const scope = createRunSecretScope();
  scope.addAccountSecrets([passphrase]);
  const judgment = withRunSecretScope(scope, () =>
    NO_VERDICT_READER.readReview(reviewer({ approved: false, findings: [{ text: text(REVIEW_CORRECTION_MAX_CHARS), severity: "blocking" }], rationale: text(REVIEW_RATIONALE_MAX_CHARS) })),
  );
  assert.ok(!(judgment.rationale ?? "").includes("tangerine"), judgment.rationale);
  assert.ok(!(judgment.findings[0]?.text ?? "").includes("tangerine"), judgment.findings[0]?.text);
});
