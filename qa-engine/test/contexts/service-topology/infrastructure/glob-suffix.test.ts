/* compileFileGlob is a filename-suffix predicate, not a full glob engine — the walk already
   recurses directories. Unsupported directory-structured patterns must fail-closed and warn,
   never silently over-match every file of that extension. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compileFileGlob } from "@contexts/service-topology/infrastructure/glob-suffix.ts";

test("compileFileGlob: '**/*.api.ts' matches a file named 'orders.api.ts'", () => {
  const matches = compileFileGlob("**/*.api.ts");
  assert.equal(matches("orders.api.ts"), true);
});

test("compileFileGlob: '**/*.api.ts' does not match a file with a different extension", () => {
  const matches = compileFileGlob("**/*.api.ts");
  assert.equal(matches("orders.service.ts"), false);
});

test("compileFileGlob: a DIFFERENT extension pattern works with the SAME compiler (agnosticism)", () => {
  const matches = compileFileGlob("**/*.gateway.ts");
  assert.equal(matches("orders.gateway.ts"), true);
  assert.equal(matches("orders.api.ts"), false);
});

test("compileFileGlob: matches regardless of leading path segments (the ** prefix)", () => {
  const matches = compileFileGlob("**/*.api.ts");
  assert.equal(matches("src/app/orders/api/orders.api.ts"), true);
});

/* Directory-structured globs are not a filename-suffix predicate. lastIndexOf("*") used to
   collapse them to a bare extension and silently match every file of that type. */

test("compileFileGlob: '**/api/*.ts' (directory-structured) does NOT match 'orders.api.ts' — unsupported shape", () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const matches = compileFileGlob("**/api/*.ts");
    assert.equal(matches("orders.api.ts"), false, "must fail-closed, not silently match every .ts file");
    assert.ok(warnings.length > 0, "must warn loudly about the unsupported glob shape");
  } finally {
    console.warn = originalWarn;
  }
});

test("compileFileGlob: 'order*.ts' (mid-string wildcard, not filename-suffix) does NOT match 'billing.ts'", () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const matches = compileFileGlob("order*.ts");
    assert.equal(matches("billing.ts"), false, "must fail-closed, not substring-suffix-match every .ts file");
  } finally {
    console.warn = originalWarn;
  }
});

test("compileFileGlob: '**/*.api.ts' (supported filename-suffix shape) still matches 'orders.api.ts'", () => {
  const matches = compileFileGlob("**/*.api.ts");
  assert.equal(matches("orders.api.ts"), true);
});

test("compileFileGlob: '*.ts' (bare filename-suffix, no **) still matches 'orders.ts'", () => {
  const matches = compileFileGlob("*.ts");
  assert.equal(matches("orders.ts"), true);
});
