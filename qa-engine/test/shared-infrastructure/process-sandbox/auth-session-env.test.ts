import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authSessionEnv } from "../../../src/shared-infrastructure/process-sandbox/auth-session-env.ts";
/* NOTE: 3 leading ../ from qa-engine/test/shared-infrastructure/process-sandbox/ to qa-engine/src/ */

/* Auth material must live in an orchestrator-only authDir, never under the
   watched-repo mirror the agent can read. These tests prove authSessionEnv reads ONLY from the
   authDir it is given and never derives a path from (or falls back to) a mirror/specDir.
 */

test("authSessionEnv reads credential files from authDir, never from a separate mirror dir", () => {
  const mirrorDir = mkdtempSync(join(tmpdir(), "qa-mirror-"));
  const authDir = mkdtempSync(join(tmpdir(), "qa-authdir-"));
  try {
    /* Decoy under the mirror — proves the function never reads from it. */
    mkdirSync(join(mirrorDir, ".auth"), { recursive: true });
    writeFileSync(join(mirrorDir, ".auth", "user.json"), "DECOY");

    writeFileSync(join(authDir, "user.json"), "{}");
    writeFileSync(join(authDir, "client.p12"), "cert-bytes");
    writeFileSync(join(authDir, "cert.pass"), "s3cr3t");

    const env = authSessionEnv(authDir, { EXISTING: "1" });

    assert.equal(env.PW_STORAGE_STATE, join(authDir, "user.json"));
    assert.equal(env.PW_CLIENT_CERT_PATH, join(authDir, "client.p12"));
    assert.equal(env.DEV_CLIENT_CERT_PASS, "s3cr3t");
    assert.equal(env.EXISTING, "1");
    assert.notEqual(env.PW_STORAGE_STATE, join(mirrorDir, ".auth", "user.json"));
  } finally {
    rmSync(mirrorDir, { recursive: true, force: true });
    rmSync(authDir, { recursive: true, force: true });
  }
});

test("authSessionEnv omits auth keys when authDir has no credential files (public app, no auth declared)", () => {
  const authDir = mkdtempSync(join(tmpdir(), "qa-authdir-empty-"));
  try {
    const env = authSessionEnv(authDir, { BASE: "1" });
    assert.deepEqual(env, { BASE: "1" });
  } finally {
    rmSync(authDir, { recursive: true, force: true });
  }
});
