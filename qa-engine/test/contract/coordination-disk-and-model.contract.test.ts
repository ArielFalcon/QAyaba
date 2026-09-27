import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existingWritableFiles } from "@contexts/qa-run-orchestration/application/coordination/existing-writable-files.ts";
import { classifyDelegationFailure } from "@contexts/qa-run-orchestration/application/coordination/delegation-failure-class.ts";
import { resolveSidekickModel } from "@contexts/qa-run-orchestration/application/coordination/resolve-sidekick-model.ts";
import {
  applyPushback,
  createDelegationBrief,
} from "@contexts/qa-run-orchestration/application/coordination/index.ts";

test("existingWritableFiles keeps only in-scope paths that exist on disk", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-disk-"));
  try {
    mkdirSync(join(root, "e2e"), { recursive: true });
    writeFileSync(join(root, "e2e", "ok.spec.ts"), "// ok");
    const kept = existingWritableFiles(
      root,
      [{ path: "e2e/ok.spec.ts" }, { path: "e2e/missing.spec.ts" }, { path: "src/hack.ts" }],
      ["e2e/"],
    );
    assert.deepEqual(kept, [{ path: "e2e/ok.spec.ts" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existingWritableFiles' fs access is injectable — a fake existsSync decides disk presence with zero real I/O", () => {
  const seen: string[] = [];
  const fakeDeps = {
    existsSync: (path: string) => {
      seen.push(path);
      return path.endsWith("ok.spec.ts");
    },
  };
  const kept = existingWritableFiles(
    "/mirrors/app",
    [{ path: "e2e/ok.spec.ts" }, { path: "e2e/missing.spec.ts" }, { path: "src/hack.ts" }],
    ["e2e/"],
    fakeDeps,
  );
  assert.deepEqual(kept, [{ path: "e2e/ok.spec.ts" }]);
  /* Only in-scope candidates are ever probed — the out-of-scope src/hack.ts never reaches existsSync. */
  assert.deepEqual(seen, ["/mirrors/app/e2e/ok.spec.ts", "/mirrors/app/e2e/missing.spec.ts"]);
});

test("classifyDelegationFailure: failed and blocked statuses are always a contract failure", () => {
  assert.equal(classifyDelegationFailure("failed", 0, 0), "failed");
  assert.equal(classifyDelegationFailure("blocked", 3, 3), "blocked");
});

test("classifyDelegationFailure: completed with claimed files that never verified on disk is a contract failure", () => {
  assert.equal(classifyDelegationFailure("completed", 2, 0), "claimed-files-missing");
  assert.equal(classifyDelegationFailure("completed-with-concerns", 1, 0), "claimed-files-missing");
});

test("classifyDelegationFailure: completed with verified files, or needs-lead, is NOT a contract failure", () => {
  assert.equal(classifyDelegationFailure("completed", 2, 2), undefined);
  assert.equal(classifyDelegationFailure("completed-with-concerns", 0, 0), undefined, "zero claimed files is not itself a failure");
  assert.equal(classifyDelegationFailure("needs-lead", 0, 0), undefined, "an intentional handoff is not a broken contract");
});

test("classifyDelegationFailure: a needs-lead handoff is not a contract failure even with claimed files that never verified", () => {
  assert.equal(classifyDelegationFailure("needs-lead", 2, 0), undefined);
});

test("resolveSidekickModel only returns model for sidekick-escalated", () => {
  assert.equal(resolveSidekickModel("sidekick-standard", "opencode-go/big"), undefined);
  assert.equal(resolveSidekickModel("lead", "opencode-go/big"), undefined);
  assert.equal(resolveSidekickModel("sidekick-escalated", "opencode-go/big"), "opencode-go/big");
  assert.equal(resolveSidekickModel("sidekick-escalated", "  "), undefined);
  assert.equal(resolveSidekickModel("sidekick-escalated", undefined), undefined);
});

test("pushback rejects path escape even with code-mode root '.'", () => {
  const brief = createDelegationBrief({
    delegationId: "d1",
    runId: "r1",
    objective: "x",
    task: "x",
    scope: { readablePaths: ["."], writablePaths: ["."], allowedCommands: [] },
  });
  const blocked = applyPushback(brief, {
    delegationId: "d1",
    runId: "r1",
    status: "completed",
    summary: "hack",
    filesChanged: [{ path: "../secret" }],
    evidence: [],
    validation: [],
    assumptions: [],
    concerns: [],
    unresolvedQuestions: [],
    recommendation: "accept",
  });
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.concerns.some((c) => c.includes("path-outside-scope")));
});

test("pushback allows relative project path under code-mode root '.'", () => {
  const brief = createDelegationBrief({
    delegationId: "d1",
    runId: "r1",
    objective: "x",
    task: "x",
    scope: { readablePaths: ["."], writablePaths: ["."], allowedCommands: [] },
    validationPlan: [{ id: "v1", description: "ok" }],
  });
  const ok = applyPushback(brief, {
    delegationId: "d1",
    runId: "r1",
    status: "completed",
    summary: "ok",
    filesChanged: [{ path: "src/foo.test.ts" }],
    evidence: [],
    validation: [{ id: "v1", ok: true }],
    assumptions: [],
    concerns: [],
    unresolvedQuestions: [],
    recommendation: "accept",
  });
  assert.equal(ok.status, "completed");
});
