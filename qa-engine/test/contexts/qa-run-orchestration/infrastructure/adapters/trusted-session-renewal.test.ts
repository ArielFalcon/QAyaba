import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trustedSessionRenewal } from "@contexts/qa-run-orchestration/infrastructure/adapters/trusted-session-renewal.ts";
import type { AuthSessionPort, AuthSessionRequest } from "@contexts/qa-run-orchestration/application/ports/auth-session.port.ts";

const LOGIN = 'import { test as setup } from "@playwright/test";\nsetup("login", async ({ page }) => { await page.goto("/"); });\n';

function rig(t: TestContext, over: { fails?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "trusted-renewal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const specDir = join(root, "e2e");
  mkdirSync(specDir, { recursive: true });
  const prepared: AuthSessionRequest[] = [];
  const authSession: AuthSessionPort = {
    prepare: async (req) => {
      prepared.push(req);
      if (over.fails) throw new Error("login failed");
      return { unauthored: false };
    },
  };
  return { specDir, prepared, authSession, writeLogin: (text: string) => writeFileSync(join(specDir, "auth.setup.ts"), text) };
}

const context = { baseUrl: "https://dev.example" };

test("the login that was there when the loop opened is run again to renew the session", async (t) => {
  const r = rig(t);
  r.writeLogin(LOGIN);
  const renewal = trustedSessionRenewal(r.authSession, context, r.specDir, 1);
  assert.equal(await renewal.renew(), true);
  assert.deepEqual(r.prepared.map((p) => p.phase), ["pre-execute"]);
});

test("a login script the agent rewrote since the loop opened is never run", async (t) => {
  const r = rig(t);
  r.writeLogin(LOGIN);
  const renewal = trustedSessionRenewal(r.authSession, context, r.specDir, 1);
  r.writeLogin(`${LOGIN}// authored by the agent\n`);
  assert.equal(await renewal.renew(), false);
  assert.equal(r.prepared.length, 0);
});

test("a login script that appeared since the loop opened is never run", async (t) => {
  const r = rig(t);
  const renewal = trustedSessionRenewal(r.authSession, context, r.specDir, 1);
  r.writeLogin(LOGIN);
  assert.equal(await renewal.renew(), false);
  assert.equal(r.prepared.length, 0);
});

test("a login script that cannot be vouched for when the loop opens is never run", async (t) => {
  const r = rig(t);
  writeFileSync(join(r.specDir, "elsewhere.ts"), LOGIN);
  symlinkSync(join(r.specDir, "elsewhere.ts"), join(r.specDir, "auth.setup.ts"));
  const renewal = trustedSessionRenewal(r.authSession, context, r.specDir, 1);
  assert.equal(await renewal.renew(), false);
  assert.equal(r.prepared.length, 0);
});

test("a run renews at most as many times as it is allowed, then reports the session lost", async (t) => {
  const r = rig(t);
  r.writeLogin(LOGIN);
  const renewal = trustedSessionRenewal(r.authSession, context, r.specDir, 1);
  assert.equal(await renewal.renew(), true);
  assert.equal(await renewal.renew(), false);
  assert.equal(r.prepared.length, 1);
});

test("a renewal that fails still counts, and says no", async (t) => {
  const r = rig(t, { fails: true });
  r.writeLogin(LOGIN);
  const renewal = trustedSessionRenewal(r.authSession, context, r.specDir, 1);
  assert.equal(await renewal.renew(), false);
  assert.equal(await renewal.renew(), false);
  assert.equal(r.prepared.length, 1);
});
