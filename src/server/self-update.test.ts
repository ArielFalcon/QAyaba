import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  performSwap,
  confirmSwapHealthy,
  rollback,
  SwapFs,
  SwapMarker,
  MAX_BOOT_ATTEMPTS,
  writePendingPromote,
  readPendingPromote,
  clearPendingPromote,
} from "./self-update";

test("pending-promote survives the swap marker being cleared, and is cleared on terminal outcome", () => {
  const dir = mkdtempSync(join(tmpdir(), "promote-"));
  try {
    assert.equal(readPendingPromote(dir), null);
    const p = { promote: { repo: "o/r", prNumber: 7, nodeId: "PR_node" }, prUrl: "https://x/pull/7", at: "t" };
    writePendingPromote(dir, p);
    assert.deepEqual(readPendingPromote(dir), p); /* durable across the marker clear / a restart */
    clearPendingPromote(dir);
    assert.equal(readPendingPromote(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeFs(present: Set<string> = new Set()): SwapFs & { ops: string[]; marker: SwapMarker | null } {
  let marker: SwapMarker | null = null;
  const ops: string[] = [];
  return {
    ops,
    get marker() {
      return marker;
    },
    exists: (p) => present.has(p),
    rm: (p) => {
      present.delete(p);
      ops.push(`rm ${p}`);
    },
    cp: (from, to) => {
      present.add(to);
      ops.push(`cp ${from} -> ${to}`);
    },
    readMarker: () => marker,
    writeMarker: (_p, m) => {
      marker = m;
    },
    removeMarker: () => {
      marker = null;
    },
  };
}

test("performSwap backs up the live tree before overwriting it, then arms the marker", () => {
  const fs = fakeFs(new Set(["/app/src", "/app/package.json", "/app/package-lock.json", "/work/src", "/work/package.json", "/work/package-lock.json"]));
  performSwap("/app", "/work", "/data", { at: "t1", prUrl: "u" }, fs);
  const backupIdx = fs.ops.findIndex((o) => o === "cp /app/src -> /app/src.bak");
  const removeIdx = fs.ops.findIndex((o) => o === "rm /app/src");
  assert.ok(backupIdx >= 0 && removeIdx >= 0 && backupIdx < removeIdx, "backup must precede removing live src");
  assert.ok(fs.ops.includes("cp /work/src -> /app/src"), "new code copied into place");
  assert.deepEqual(fs.marker, { at: "t1", attempt: 0, prUrl: "u", promote: undefined, fix: undefined });
});

test("performSwap records promote + fix info for the canary-before-merge flow", () => {
  const fs = fakeFs(new Set(["/app/src", "/app/package.json", "/work/src", "/work/package.json"]));
  performSwap(
    "/app",
    "/work",
    "/data",
    { at: "t2", prUrl: "u2", promote: { repo: "o/r", prNumber: 7, nodeId: "PR_node" }, fix: { prTitle: "fix: x", changes: ["a.ts"], rootCause: "r" } },
    fs,
  );
  assert.deepEqual(fs.marker, {
    at: "t2",
    attempt: 0,
    prUrl: "u2",
    promote: { repo: "o/r", prNumber: 7, nodeId: "PR_node" },
    fix: { prTitle: "fix: x", changes: ["a.ts"], rootCause: "r" },
  });
});

/*
 * boot-guard.mjs runs before src/ is loaded (it must survive a bad swap intact — see its own
 * header) and keeps its own literal MAX_BOOT_ATTEMPTS copy rather than importing this one. Reading
 * its source (never importing it — the script performs real fs/process side effects and calls
 * process.exit(0) at the top level) keeps the two constants from silently drifting apart.
 */
test("boot-guard.mjs's MAX_BOOT_ATTEMPTS stays in sync with self-update.ts's own constant", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const bootGuardSrc = readFileSync(join(here, "..", "..", "boot-guard.mjs"), "utf8");
  const m = /const MAX_BOOT_ATTEMPTS = (\d+);/.exec(bootGuardSrc);
  assert.ok(m, "boot-guard.mjs must declare a numeric MAX_BOOT_ATTEMPTS constant in this exact shape");
  assert.equal(Number(m![1]), MAX_BOOT_ATTEMPTS, "boot-guard.mjs's hardcoded attempt threshold must match self-update.ts's MAX_BOOT_ATTEMPTS — the two are not wired together and can only be kept honest by this assertion");
});

test("a healthy swap is confirmed: marker + backups removed", () => {
  const fs = fakeFs(new Set(["/app/src.bak", "/app/package.json.bak", "/app/package-lock.json.bak"]));
  fs.writeMarker("", { at: "t", attempt: 1 });
  confirmSwapHealthy("/app", "/data", fs);
  assert.equal(fs.marker, null);
  assert.ok(fs.ops.includes("rm /app/src.bak"));
});

test("rollback restores the backup over the live tree and clears state", () => {
  const fs = fakeFs(new Set(["/app/src.bak", "/app/package.json.bak"]));
  fs.writeMarker("", { at: "t", attempt: MAX_BOOT_ATTEMPTS });
  const ok = rollback("/app", "/data", fs);
  assert.equal(ok, true);
  assert.ok(fs.ops.includes("cp /app/src.bak -> /app/src"), "restored src from backup");
  assert.ok(fs.ops.includes("cp /app/package.json.bak -> /app/package.json"));
  assert.equal(fs.marker, null);
});

test("rollback is a no-op (returns false) when there is no backup", () => {
  const fs = fakeFs(new Set());
  assert.equal(rollback("/app", "/data", fs), false);
});
