import { test } from "node:test";
import assert from "node:assert/strict";
import { preExecAction } from "@contexts/qa-run-orchestration/domain/pre-exec-regen.ts";

test("corrections that nothing has repaired yet earn a regeneration", () => assert.equal(preExecAction({ corrections: 2, retired: false, regenerated: 0 }), "regenerate"));
test("no corrections, no regeneration", () => assert.equal(preExecAction({ corrections: 0, retired: false, regenerated: 0 }), "proceed"));
test("specs the generator saw pass against DEV are not rewritten", () => assert.equal(preExecAction({ corrections: 2, retired: true, regenerated: 0 }), "proceed"));
test("the regeneration is spent once: corrections that remain after it do not earn another", () => assert.equal(preExecAction({ corrections: 2, retired: false, regenerated: 1 }), "proceed"));
