import { test } from "node:test";
import assert from "node:assert/strict";
import { FAKE_FLAG } from "./fake-pass-detector.ts";
import {
  CASE_KIND, EXPECTED_OUTCOME, VALIDITY_RUNS, armOrder, assessSpecs, classifyOutcome, invalidReplicateReasons, matchesExpected, parseArguments, parseCases, specStatuses,
} from "./campaign-model.ts";

const SHA = "d842b71a619e5a6a84d1a7966d74c670285cdaa8";

const validCases = () => ({
  app: "demo",
  cases: [
    { id: "dup-address", kind: "cross-repo", sha: SHA, serviceRepo: "org/users-service", expected: { outcome: "spec", mustVerify: "a duplicate address shows the refusal" }, cleanup: { spec: "cleanup-addresses.spec.ts" } },
    { id: "copy-tweak", kind: "diff", sha: "abc1234", expected: { outcome: "noop", mustVerify: "nothing user visible" } },
  ],
});

/* ── the cases file ── */

test("a well-formed cases file loads with its cases in order", () => {
  const parsed = parseCases(validCases());
  assert.equal(parsed.app, "demo");
  assert.deepEqual(parsed.cases.map((c) => c.id), ["dup-address", "copy-tweak"]);
  assert.equal(parsed.cases[0]!.kind, CASE_KIND.CROSS_REPO);
  assert.equal(parsed.cases[0]!.cleanup?.spec, "cleanup-addresses.spec.ts");
});

test("a malformed cases file stops the campaign, naming the case and the field", () => {
  const broken: Array<[string, (v: ReturnType<typeof validCases>) => unknown, RegExp]> = [
    ["no cases", (v) => ({ ...v, cases: [] }), /cases/],
    ["bad id", (v) => ({ ...v, cases: [{ ...v.cases[1]!, id: "../x" }] }), /id/],
    ["duplicate id", (v) => ({ ...v, cases: [v.cases[1]!, v.cases[1]!] }), /duplicate/],
    ["bad kind", (v) => ({ ...v, cases: [{ ...v.cases[1]!, kind: "full" }] }), /kind/],
    ["non-hex sha", (v) => ({ ...v, cases: [{ ...v.cases[1]!, sha: "main" }] }), /sha/],
    ["cross-repo without a service", (v) => ({ ...v, cases: [{ ...v.cases[0]!, serviceRepo: undefined }] }), /serviceRepo/],
    ["diff with a service", (v) => ({ ...v, cases: [{ ...v.cases[1]!, serviceRepo: "org/x" }] }), /serviceRepo/],
    ["service not owner/repo", (v) => ({ ...v, cases: [{ ...v.cases[0]!, serviceRepo: "users" }] }), /serviceRepo/],
    ["unknown outcome", (v) => ({ ...v, cases: [{ ...v.cases[1]!, expected: { outcome: "maybe", mustVerify: "x" } }] }), /outcome/],
    ["empty mustVerify", (v) => ({ ...v, cases: [{ ...v.cases[1]!, expected: { outcome: "spec", mustVerify: " " } }] }), /mustVerify/],
    ["cleanup that is not a spec", (v) => ({ ...v, cases: [{ ...v.cases[1]!, cleanup: { spec: "clean.ts" } }] }), /cleanup/],
    ["cleanup that leaves the suite", (v) => ({ ...v, cases: [{ ...v.cases[1]!, cleanup: { spec: "../clean.spec.ts" } }] }), /cleanup/],
    ["a typo in a key", (v) => ({ ...v, cases: [{ ...v.cases[1]!, expcted: {} }] }), /expcted/],
    ["no app", (v) => ({ ...v, app: "" }), /app/],
  ];
  for (const [name, mutate, message] of broken) assert.throws(() => parseCases(mutate(validCases())), message, name);
  assert.throws(() => parseCases("nope"), /object/);
});

/* ── the command line ── */

const argv = (...extra: string[]): string[] => ["--cases", "cases.json", "--replicas", "3", "--label", "camp-1", "--warm", "warm-1", ...extra];

test("arguments default to both arms and a 30 minute cap, and the safety overrides are off", () => {
  const parsed = parseArguments(argv());
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.args.arms, ["A", "B"]);
  assert.equal(parsed.args.wallCapMin, 30);
  assert.equal(parsed.args.allowNonShadow, false);
  assert.equal(parsed.args.skipEnvChecks, false);
  assert.equal(parsed.args.dryRun, false);
  assert.equal(parsed.args.replicas, 3);
});

test("the arms, the cap and the overrides are read from the command line", () => {
  const parsed = parseArguments(argv("--arms", "B", "--wall-cap-min", "12.5", "--allow-non-shadow", "--skip-env-checks", "--dry-run"));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.args.arms, ["B"]);
  assert.equal(parsed.args.wallCapMin, 12.5);
  assert.ok(parsed.args.allowNonShadow && parsed.args.skipEnvChecks && parsed.args.dryRun);
});

test("--grounding takes the stitcher and curriculum levers and refuses any other key", () => {
  const parsed = parseArguments(argv("--grounding", "stitcher=off,curriculum=on"));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.args.grounding, { stitcher: false, curriculum: true });
  for (const key of ["structuralSignal", "dossier"]) assert.equal(parseArguments(argv("--grounding", `${key}=off`)).ok, false);
});

test("bad arguments are refused with a reason", () => {
  const bad: string[][] = [
    argv("--replicas", "0"), argv("--replicas", "1.5"), argv("--replicas", "99"), argv("--arms", "C"), argv("--arms", "A,A"), argv("--wall-cap-min", "0"),
    argv("--label", "../x"), argv("--warm", "../x"), argv("--nope"), ["--replicas", "2", "--label", "l", "--warm", "w"], ["--cases", "c.json", "--replicas", "2", "--warm", "w"],
    ["--cases", "c.json", "--replicas", "2", "--label", "l"], ["--cases"],
  ];
  for (const args of bad) assert.equal(parseArguments(args).ok, false, args.join(" "));
});

/* ── the order of the arms ── */

test("the order of the arms alternates by replicate so neither arm is always first against DEV", () => {
  assert.deepEqual(armOrder(1, ["A", "B"]), ["A", "B"]);
  assert.deepEqual(armOrder(2, ["A", "B"]), ["B", "A"]);
  assert.deepEqual(armOrder(3, ["A", "B"]), ["A", "B"]);
  assert.deepEqual(armOrder(4, ["A", "B"]), ["B", "A"]);
  assert.deepEqual(armOrder(2, ["B"]), ["B"]);
});

/* ── which spec passed ── */

test("a case belongs to the spec file its title starts with, and a spec passes only when every one of its cases does", () => {
  const cases = [
    { name: "a.spec.ts › one", status: "pass" },
    { name: "a.spec.ts › group › two", status: "pass" },
    { name: "flows/b.spec.ts › one", status: "pass" },
    { name: "flows/b.spec.ts › two", status: "fail" },
    { name: "c.spec.ts › skipped", status: "skip" },
  ];
  const status = specStatuses(cases, ["a.spec.ts", "flows/b.spec.ts", "c.spec.ts", "d.spec.ts"]);
  assert.equal(status.get("a.spec.ts"), "pass");
  assert.equal(status.get("flows/b.spec.ts"), "fail");
  assert.equal(status.get("c.spec.ts"), "fail", "a test that did not run did not pass");
  assert.equal(status.get("d.spec.ts"), "missing", "no test of it ran");
});

test("a title that carries the file relative to a narrower test directory still finds its spec", () => {
  const status = specStatuses([{ name: "b.spec.ts › one", status: "pass" }], ["flows/b.spec.ts"]);
  assert.equal(status.get("flows/b.spec.ts"), "pass");
});

/* ── valid or not ── */

const GREEN = { verdict: "pass" as const, cases: [{ name: "a.spec.ts › t", status: "pass" }] };
const RED = { verdict: "fail" as const, cases: [{ name: "a.spec.ts › t", status: "fail" }] };

test("a spec is valid when it passes both re-runs and nothing about it looks fake", () => {
  const [a] = assessSpecs({ specs: [{ path: "a.spec.ts", flags: [] }], validation: [GREEN, GREEN] });
  assert.equal(a!.valid, true);
  assert.deepEqual(a!.runs, ["pass", "pass"]);
});

test("a spec that fails either re-run is not valid: one green run proves nothing", () => {
  assert.equal(assessSpecs({ specs: [{ path: "a.spec.ts", flags: [] }], validation: [GREEN, RED] })[0]!.valid, false);
  assert.equal(assessSpecs({ specs: [{ path: "a.spec.ts", flags: [] }], validation: [RED, GREEN] })[0]!.valid, false);
});

test("a flagged spec never counts as valid however green it is, and it is not run", () => {
  const flags = [{ kind: FAKE_FLAG.TAUTOLOGY, detail: "expect(true)" }];
  const [a] = assessSpecs({ specs: [{ path: "a.spec.ts", flags }], validation: [GREEN, GREEN] });
  assert.equal(a!.valid, false);
  assert.equal(a!.ran, false);
  assert.deepEqual(a!.flags.map((f) => f.kind), [FAKE_FLAG.TAUTOLOGY]);
});

test("a spec that was never re-run, or only once, is not valid", () => {
  assert.equal(assessSpecs({ specs: [{ path: "a.spec.ts", flags: [] }], validation: [] })[0]!.valid, false);
  assert.equal(assessSpecs({ specs: [{ path: "a.spec.ts", flags: [] }], validation: [GREEN] })[0]!.valid, false);
  assert.equal(VALIDITY_RUNS, 2);
});

/* ── what the arm did, against what the case expects ── */

test("an arm that delivered specs, declared a no-op, or neither, is classified by what it delivered", () => {
  assert.equal(classifyOutcome({ verdict: "pass", delivered: 2 }), "spec");
  assert.equal(classifyOutcome({ verdict: "flaky", delivered: 1 }), "spec");
  assert.equal(classifyOutcome({ verdict: "fail", delivered: 1 }), "spec", "the plain agent's own red run still delivered files; the re-run decides");
  assert.equal(classifyOutcome({ verdict: "skipped", delivered: 0 }), "noop");
  assert.equal(classifyOutcome({ verdict: "infra-error", delivered: 0 }), "none");
  assert.equal(classifyOutcome({ verdict: "fail", delivered: 0 }), "none");
  assert.equal(classifyOutcome({ verdict: null, delivered: 0 }), "none");
});

test("the outcome is judged against the case: a spec where a no-op was right is a miss, and an error is a miss for every expectation", () => {
  assert.equal(matchesExpected(EXPECTED_OUTCOME.SPEC, "spec"), true);
  assert.equal(matchesExpected(EXPECTED_OUTCOME.SPEC, "noop"), false);
  assert.equal(matchesExpected(EXPECTED_OUTCOME.NOOP, "noop"), true);
  assert.equal(matchesExpected(EXPECTED_OUTCOME.NOOP, "spec"), false);
  assert.equal(matchesExpected(EXPECTED_OUTCOME.EITHER, "spec"), true);
  assert.equal(matchesExpected(EXPECTED_OUTCOME.EITHER, "noop"), true);
  for (const expected of Object.values(EXPECTED_OUTCOME)) assert.equal(matchesExpected(expected, "none"), false);
});

/* ── a replicate that cannot be compared ── */

test("a replicate cut by the cap, a failed cleanup, a DEV that was down or a lost run cannot be compared", () => {
  const clean = { capped: false, cleanupFailed: false, verdict: "pass" as const, errorClass: null, validationInfra: false, runLost: false };
  assert.deepEqual(invalidReplicateReasons(clean), []);
  assert.ok(invalidReplicateReasons({ ...clean, capped: true }).some((r) => r.includes("cap")));
  assert.ok(invalidReplicateReasons({ ...clean, cleanupFailed: true }).some((r) => r.includes("cleanup")));
  assert.ok(invalidReplicateReasons({ ...clean, validationInfra: true }).some((r) => r.includes("re-run")));
  assert.ok(invalidReplicateReasons({ ...clean, runLost: true }).some((r) => r.includes("run")));
  assert.ok(invalidReplicateReasons({ ...clean, verdict: "infra-error", errorClass: "E-PRECONDITION" }).some((r) => r.includes("E-PRECONDITION")));
});

test("an infra-error the arm brought on itself (no decision, a spent budget) is the arm's result, not a broken replicate", () => {
  const base = { capped: false, cleanupFailed: false, verdict: "infra-error" as const, validationInfra: false, runLost: false };
  for (const errorClass of ["E-NO-DECISION", "E-STEP-BUDGET", "E-TIME-BUDGET"]) assert.deepEqual(invalidReplicateReasons({ ...base, errorClass }), [], errorClass);
  assert.ok(invalidReplicateReasons({ ...base, errorClass: null }).length > 0, "an infra-error with no class is the environment until shown otherwise");
});
