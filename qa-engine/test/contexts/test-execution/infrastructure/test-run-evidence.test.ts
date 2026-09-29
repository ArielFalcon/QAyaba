import { test } from "node:test";
import assert from "node:assert/strict";
import { TestRunEvidence, lineShowsTestsRan, outputShowsTestsRan } from "@contexts/test-execution/infrastructure/test-run-evidence.ts";

test("a Go package `ok` line is evidence a test ran; a package with no test files is not", () => {
  assert.equal(lineShowsTestsRan("go", "ok  \tgithub.com/acme/app/core\t0.012s"), true);
  assert.equal(lineShowsTestsRan("go", "?   \tgithub.com/acme/app/gen\t[no test files]"), false);
  assert.equal(lineShowsTestsRan("go", "  ok mentioned mid-line"), false, "the marker is a line that starts with ok");
});

test("a Rust test count above zero is evidence a test ran; a zero count is not", () => {
  assert.equal(lineShowsTestsRan("rust", "running 12 tests"), true);
  assert.equal(lineShowsTestsRan("rust", "running 1 test"), true);
  assert.equal(lineShowsTestsRan("rust", "running 0 tests"), false);
});

test("a Maven Tests run count above zero is evidence a test ran; a zero count is not", () => {
  assert.equal(lineShowsTestsRan("maven", "[INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0"), true);
  assert.equal(lineShowsTestsRan("maven", "[INFO] Tests run: 0, Failures: 0, Errors: 0, Skipped: 0"), false);
});

test("an ecosystem whose runner has no such marker never reports evidence", () => {
  assert.equal(lineShowsTestsRan("node", "ok 1 - a passing test"), false);
  assert.equal(outputShowsTestsRan("python", "running 3 tests\nTests run: 3\nok"), false);
});

test("collected output shows a test ran when any of its lines does", () => {
  assert.equal(outputShowsTestsRan("go", "?   \tpkg\t[no test files]\nok  \tpkg2\t0.1s\n"), true);
  assert.equal(outputShowsTestsRan("go", "?   \tpkg\t[no test files]\n"), false);
});

test("evidence is found when a line arrives split across chunks", () => {
  const evidence = new TestRunEvidence("go");
  evidence.feed("?   \tpkg\t[no test files]\nok  \tgithub.com/ac");
  assert.equal(evidence.sawTestsRan, false, "the line is not complete yet");
  evidence.feed("me/app\t0.1s\n");
  assert.equal(evidence.sawTestsRan, true);
});

test("a last line without a line break is judged when the stream ends", () => {
  const evidence = new TestRunEvidence("maven");
  evidence.feed("Tests run: 3, Failures: 0");
  assert.equal(evidence.sawTestsRan, false);
  evidence.end();
  assert.equal(evidence.sawTestsRan, true);
});

test("an overlong line is skipped whole, so its tail cannot pass for a line of its own", () => {
  const evidence = new TestRunEvidence("go");
  evidence.feed(`${"z".repeat(20_000)}`);
  evidence.feed("\nok  \tpkg\t0.1s\n");
  assert.equal(evidence.sawTestsRan, true, "the next line after the overlong one is read normally");

  const tailOnly = new TestRunEvidence("go");
  tailOnly.feed(`${"z".repeat(20_000)}`);
  tailOnly.feed("ok looks like a marker but continues the overlong line\n");
  assert.equal(tailOnly.sawTestsRan, false, "the continuation of a skipped line is not a line start");
});
