import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { qayabaDataDir, qayabaRoot } from "./paths";

function withRoot(value: string | undefined, fn: () => void): void {
  const prev = process.env.QAYABA_ROOT;
  if (value === undefined) delete process.env.QAYABA_ROOT;
  else process.env.QAYABA_ROOT = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.QAYABA_ROOT;
    else process.env.QAYABA_ROOT = prev;
  }
}

test("QAYABA_ROOT sets the root and the data directory lives under it", () => {
  withRoot("/srv/qayaba", () => {
    assert.equal(qayabaRoot(), "/srv/qayaba");
    assert.equal(qayabaDataDir(), join("/srv/qayaba", "data"));
  });
});

test("without QAYABA_ROOT the root is the working directory", () => {
  withRoot(undefined, () => {
    assert.equal(qayabaRoot(), process.cwd());
    assert.equal(qayabaDataDir(), join(process.cwd(), "data"));
  });
});
