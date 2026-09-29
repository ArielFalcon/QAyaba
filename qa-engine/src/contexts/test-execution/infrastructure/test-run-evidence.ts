/* Positive evidence that a code-mode test run executed at least one test, collected while its output streams by. The kept output is bounded (bounded-output-tail.ts), so the line that proves tests ran (a Go `ok` line, a Rust or Maven test count) can already be dropped by the time the run ends; reading the kept text alone would then call a passing suite "executed zero tests". */

import type { Ecosystem } from "./code-execution.runner.ts";

/** The single-line marker a runner prints when it ran tests, per ecosystem that reports zero tests as a clean exit. Ecosystems absent here have no such marker. */
const TESTS_RAN_MARKER: Partial<Record<Ecosystem, RegExp>> = {
  go: /^ok\s/,
  rust: /running [1-9]\d* tests?/,
  maven: /Tests run: [1-9]/,
};

/* A line longer than this is not a runner's summary line; it is skipped instead of buffered, so a flood without line breaks cannot grow the scanner. */
const MAX_SCANNED_LINE_CHARS = 8192;

/** True when one line of output is this ecosystem's marker that a test ran. */
export function lineShowsTestsRan(ecosystem: Ecosystem, line: string): boolean {
  return TESTS_RAN_MARKER[ecosystem]?.test(line) ?? false;
}

/** True when any line of already-collected output shows a test ran. */
export function outputShowsTestsRan(ecosystem: Ecosystem, output: string): boolean {
  return TESTS_RAN_MARKER[ecosystem] !== undefined && output.split("\n").some((line) => lineShowsTestsRan(ecosystem, line));
}

/** Watches one output stream chunk by chunk. Memory stays bounded whatever the child writes. */
export class TestRunEvidence {
  private sawTest = false;
  private partialLine = "";
  private skippingLongLine = false;

  constructor(private readonly ecosystem: Ecosystem) {}

  get sawTestsRan(): boolean {
    return this.sawTest;
  }

  feed(chunk: string): void {
    if (this.sawTest || TESTS_RAN_MARKER[this.ecosystem] === undefined) return;
    const lines = (this.partialLine + chunk).split("\n");
    this.partialLine = lines.pop() ?? "";
    for (const line of lines) {
      if (!this.skippingLongLine && lineShowsTestsRan(this.ecosystem, line)) {
        this.sawTest = true;
        return;
      }
      this.skippingLongLine = false;
    }
    if (this.partialLine.length > MAX_SCANNED_LINE_CHARS) {
      this.partialLine = "";
      this.skippingLongLine = true;
    }
  }

  /** The stream closed: judge the last line, which had no line break after it. */
  end(): void {
    this.feed("\n");
  }
}
