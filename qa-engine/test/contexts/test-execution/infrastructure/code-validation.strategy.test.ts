import { test } from "node:test";
import assert from "node:assert/strict";
import { CodeValidationStrategy } from "@contexts/test-execution/infrastructure/code-validation.strategy.ts";

test("delegates to the injected code-validate fn and returns {ok, errors, infra} verbatim", async () => {
  let seenDir = "";
  const strategy = new CodeValidationStrategy(async (dir) => {
    seenDir = dir;
    return { ok: true, errors: [], infra: false };
  });
  const out = await strategy.validate("/mirrors/org/app");
  assert.equal(seenDir, "/mirrors/org/app");
  assert.equal(out.ok, true);
  assert.deepEqual(out.errors, []);
  assert.equal(out.infra, false);
});

test("surfaces a real compile error as ok:false, infra:false", async () => {
  const strategy = new CodeValidationStrategy(async () => ({
    ok: false,
    errors: ["[compile] cannot find symbol method map()"],
    infra: false,
  }));
  const out = await strategy.validate("/mirrors/org/app");
  assert.equal(out.ok, false);
  assert.equal(out.infra, false);
  assert.deepEqual(out.errors, ["[compile] cannot find symbol method map()"]);
});

test("surfaces a broken toolchain as infra:true, never blamed on the agent", async () => {
  const strategy = new CodeValidationStrategy(async () => ({
    ok: false,
    errors: ["[compile] JAVA_HOME is not set and could not be found."],
    infra: true,
  }));
  const out = await strategy.validate("/mirrors/org/app");
  assert.equal(out.infra, true);
});

test("threads changedFiles to the injected fn for diff-scoped compilation", async () => {
  type Opts = { changedFiles?: string[] };
  let capturedOpts: Opts | null = null;
  const strategy = new CodeValidationStrategy(async (_dir, opts) => {
    capturedOpts = opts as Opts;
    return { ok: true, errors: [], infra: false };
  });
  await strategy.validate("/mirrors/org/app", ["src/orders.ts"]);
  assert.ok(capturedOpts !== null, "the injected fn must be called");
  assert.deepEqual((capturedOpts as Opts).changedFiles, ["src/orders.ts"]);
});

test("omits changedFiles when absent — the injected fn falls back to its own working-tree probe", async () => {
  type Opts = { changedFiles?: string[] };
  let capturedOpts: Opts | undefined;
  const strategy = new CodeValidationStrategy(async (_dir, opts) => {
    capturedOpts = opts as Opts | undefined;
    return { ok: true, errors: [], infra: false };
  });
  await strategy.validate("/mirrors/org/app");
  assert.equal(capturedOpts?.changedFiles, undefined);
});
