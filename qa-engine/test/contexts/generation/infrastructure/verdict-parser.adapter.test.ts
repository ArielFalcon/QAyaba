import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { VerdictParserAdapter } from "@contexts/generation/infrastructure/verdict-parser.adapter.ts";
import { GENERATION_NOTE_MAX_CHARS } from "@contexts/generation/domain/generation-end.ts";

test("parseReview delegates and forwards blockingCount + parsed + valid + issues (no behavior drop)", () => {
  const adapter = new VerdictParserAdapter({
    parseVerdict: () => ({ parsed: true, specs: ["a.spec.ts"] }) as never,
    parseReviewerVerdict: () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true, valid: true, issues: [] }) as never,
  } as never);
  const j = adapter.parseReview("…json…");
  assert.equal(j.approved, true);
  assert.equal(j.blockingCount, 0);   /* forwarded — a port that dropped it would be undefined here */
  assert.equal(j.parsed, true);       /* forwarded — the parse-miss round-saver survives */
  assert.equal(j.valid, true);        /* forwarded — the bounded-repair signal survives */
  assert.deepEqual(j.issues, []);     /* forwarded — fed to repairInstruction on a contract miss */
});

test("a contract-miss reviewer verdict forwards valid:false + issues (the bounded-repair re-prompt fuel)", () => {
  const adapter = new VerdictParserAdapter({
    parseVerdict: () => ({ parsed: true, specs: [] }) as never,
    parseReviewerVerdict: () => ({ approved: false, corrections: [], blockingCount: 0, parsed: true, valid: false, issues: ["contract failure"] }) as never,
  } as never);
  const j = adapter.parseReview("…malformed reviewer json…");
  /* valid:false != a real rejection — the use-case fires ONE repairInstruction("reviewer", issues). */
  assert.equal(j.valid, false);
  assert.deepEqual(j.issues, ["contract failure"]); /* a port that dropped issues would be undefined — gutted-impl-proof */
});

test("a parse MISS is fail-closed (approved:false, parsed:false) — inherited from legacy, not 'fixed'", () => {
  const adapter = new VerdictParserAdapter({
    parseVerdict: () => ({ parsed: false, specs: [] }) as never,
    parseReviewerVerdict: () => ({ approved: false, corrections: ["no parseable verdict"], blockingCount: 0, parsed: false, valid: false, issues: ["no reviewer verdict JSON found"] }) as never,
  } as never);
  const j = adapter.parseReview("garbage");
  assert.equal(j.approved, false);
  assert.equal(j.parsed, false);
});

test("parseGenerator delegates to parseVerdict and returns specs", () => {
  let seenText = "";
  const adapter = new VerdictParserAdapter({
    parseVerdict: (text: string) => { seenText = text; return { parsed: true, approved: true, specs: ["login.spec.ts"], note: "ok" }; },
    parseReviewerVerdict: () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true, valid: true, issues: [] }) as never,
  } as never);
  const d = adapter.parseGenerator("verdict text");
  assert.equal(seenText, "verdict text"); /* DELEGATION: a gutted impl that ignores the injected fn FAILS this */
  assert.deepEqual(d.specs, ["login.spec.ts"]);
  assert.equal(d.note, "ok");
});

test("parseGenerator forwards parsed + specMetas (WRAP-2 fail-closed + WRAP-1 manifest upsert survive)", () => {
  const specMetas = [{ file: "login.spec.ts", flow: "login", objective: "sign in", targets: ["src/auth.ts"], sha256: "abc" }];
  const adapter = new VerdictParserAdapter({
    parseVerdict: () => ({ parsed: true, approved: true, specs: ["login.spec.ts"], note: "ok", specMetas }),
    parseReviewerVerdict: () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true, valid: true, issues: [] }) as never,
  } as never);
  const d = adapter.parseGenerator("verdict text");
  assert.equal(d.parsed, true);                 /* WRAP-2: the #1 fail-closed invariant — a port that dropped it would be undefined here */
  assert.deepEqual(d.specMetas, specMetas);     /* WRAP-1: drives the disk-reconciled manifest upsert — gutted-impl-proof */
});

const NO_REVIEWER = () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true, valid: true, issues: [] }) as never;
const SECRET = "sk-abcdefghijklmnopqrstuvwxyz1234";

function adapterReading(verdict: Record<string, unknown>): VerdictParserAdapter {
  return new VerdictParserAdapter({ parseVerdict: () => ({ parsed: true, specs: [], ...verdict }) as never, parseReviewerVerdict: NO_REVIEWER } as never);
}

test("parseGenerator forwards the generator's no-op reason", () => {
  const d = adapterReading({ noopReason: "The diff only renames an internal helper." }).parseGenerator("verdict text");
  assert.equal(d.noopReason, "The diff only renames an internal helper.");
});

test("parseGenerator leaves the no-op reason out when the verdict gave none", () => {
  const d = adapterReading({}).parseGenerator("verdict text");
  assert.equal("noopReason" in d, false);
});

test("parseGenerator redacts secrets in the no-op reason before it leaves the adapter", () => {
  const d = adapterReading({ noopReason: `Nothing to test; the key ${SECRET} was in the diff.` }).parseGenerator("verdict text");
  assert.doesNotMatch(d.noopReason ?? "", /sk-abcdefghijklmnopqrstuvwxyz1234/);
  assert.match(d.noopReason ?? "", /\[REDACTED\]/);
  assert.match(d.noopReason ?? "", /^Nothing to test/);
});

test("parseGenerator bounds the no-op reason to the note bound, keeping its start", () => {
  const d = adapterReading({ noopReason: `START ${"r".repeat(GENERATION_NOTE_MAX_CHARS * 3)}` }).parseGenerator("verdict text");
  assert.ok((d.noopReason ?? "").length <= GENERATION_NOTE_MAX_CHARS);
  assert.ok((d.noopReason ?? "").startsWith("START"));
});

test("parseGenerator forwards the end of the output, redacted, and bounded to the note bound", () => {
  const text = `HEAD ${"lorem ".repeat(GENERATION_NOTE_MAX_CHARS)} key ${SECRET} THE-END`;
  const d = adapterReading({}).parseGenerator(text);
  const tail = d.outputTail ?? "";
  assert.ok(tail.length <= GENERATION_NOTE_MAX_CHARS, `${tail.length} chars`);
  assert.ok(tail.endsWith("THE-END"));
  assert.ok(!tail.includes("HEAD"));
  assert.doesNotMatch(tail, /sk-abcdefghijklmnopqrstuvwxyz1234/);
  assert.match(tail, /\[REDACTED\]/);
});

test("parseGenerator forwards a short output whole and no tail for an empty one", () => {
  assert.equal(adapterReading({}).parseGenerator("short output").outputTail, "short output");
  for (const blank of ["", "  \n "]) {
    assert.equal("outputTail" in adapterReading({}).parseGenerator(blank), false, JSON.stringify(blank));
  }
});

test("parseGenerator on a parse MISS is fail-closed (parsed:false, specs ?? [] = [])", () => {
  const adapter = new VerdictParserAdapter({
    /* parse miss: no verdict JSON found → parsed:false and specs absent (the ?? [] default must apply) */
    parseVerdict: () => ({ parsed: false }) as never,
    parseReviewerVerdict: () => ({ approved: false, corrections: [], blockingCount: 0, parsed: false, valid: false, issues: [] }) as never,
  } as never);
  const d = adapter.parseGenerator("garbage");
  assert.equal(d.parsed, false);     /* a parse miss is NOT a deliberate no-op — the use-case branches on this */
  assert.deepEqual(d.specs, []);     /* undefined specs default to [] (fail-closed, never undefined) */
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
    parseVerdict: () => ({ parsed: true, approved: true, specs, specMetas: specs.map((file) => ({ file, flow: `flow-${file}`, objective: "o", targets: [] })) }),
    parseReviewerVerdict: () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true, valid: true, issues: [] }),
  });
}

function reportedPaths(specs: string[], suite: string[] | undefined): { specs: string[]; metaFiles: (string | undefined)[] } {
  const specDir = suite ? suiteWith(suite) : undefined;
  try {
    const d = reporting(specs).parseGenerator("verdict text", specDir);
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

test("without a spec dir (code target) reported names are kept as they are", () => {
  assert.deepEqual(reportedPaths(["login.spec.ts"], undefined).specs, ["login.spec.ts"]);
});
