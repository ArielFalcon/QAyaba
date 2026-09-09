import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join } from "node:path";

type Format = {
  fixed: (n: unknown, digits: number, empty?: string) => string;
  multiplierLabel: (cur: unknown, prev: unknown) => string;
};

function loadFormat(): Format {
  const src = readFileSync(join(process.cwd(), "web/public/js/format.js"), "utf8");
  const ctx = createContext({ window: {} as { QayabaFormat?: Format } });
  runInContext(src, ctx);
  const fmt = (ctx.window as { QayabaFormat?: Format }).QayabaFormat;
  assert.ok(fmt, "format.js must attach window.QayabaFormat");
  return fmt;
}

test("fixed never calls toFixed on null/undefined (the overview crash)", () => {
  const F = loadFormat();
  assert.equal(F.fixed(null, 2), "n/a");
  assert.equal(F.fixed(undefined, 2), "n/a");
  assert.equal(F.fixed(0.8, 2), "0.80");
});

test("multiplierLabel does not throw when baseline is 0 or missing (unmeasured oracle)", () => {
  const F = loadFormat();
  assert.equal(F.multiplierLabel(0, 0), "n/a");
  assert.equal(F.multiplierLabel(null, null), "n/a");
  assert.equal(F.multiplierLabel(0.8, 0.4), "×2.0");
});
