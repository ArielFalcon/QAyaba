import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentBrowserSession } from "@contexts/qa-run-orchestration/infrastructure/adapters/agent-browser-session-material.ts";
import { newSandboxReport, withExecScope, type RunScope } from "../../../../../../qa-engine/src/shared-infrastructure/process-sandbox/exec-scope.ts";
import { AUTH_MATERIAL_FILES } from "../../../../../../qa-engine/src/shared-infrastructure/process-sandbox/auth-session-env.ts";

function scopeWith(t: TestContext, files: Record<string, string | Buffer>, over: Partial<RunScope> = {}): RunScope {
  const authDir = mkdtempSync(join(tmpdir(), "agent-browser-auth-"));
  t.after(() => rmSync(authDir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(authDir, name), content);
  return { runId: "r1", workDir: authDir, authDir, egress: { dev: [], install: [] }, report: newSandboxReport(), ...over };
}

const STATE = { cookies: [{ name: "sid", value: "v" }], origins: [] };

test("the saved session is read into memory as data", (t) => {
  const scope = scopeWith(t, { [AUTH_MATERIAL_FILES.storageState]: JSON.stringify(STATE) });
  const material = withExecScope(scope, () => readAgentBrowserSession("https://dev.example.com"));
  assert.deepEqual(material.storageState, STATE);
  assert.equal(material.clientCertificate, undefined);
});

test("a client certificate and its passphrase are read for the app's origin", (t) => {
  const scope = scopeWith(t, { [AUTH_MATERIAL_FILES.clientCert]: Buffer.from("pfx"), [AUTH_MATERIAL_FILES.certPass]: "pw" });
  const material = withExecScope(scope, () => readAgentBrowserSession("https://dev.example.com/app"));
  assert.equal(material.clientCertificate?.origin, "https://dev.example.com");
  assert.equal(material.clientCertificate?.pfx.toString(), "pfx");
  assert.equal(material.clientCertificate?.passphrase, "pw");
});

test("the DEV gate's credentials come from the run's scope", (t) => {
  const scope = scopeWith(t, {}, { gateCreds: { user: "gate", pass: "pw" } });
  const material = withExecScope(scope, () => readAgentBrowserSession("https://dev.example.com"));
  assert.deepEqual(material.httpCredentials, { username: "gate", password: "pw" });
});

test("a session file that is not a storage state, or is a link, is not used", (t) => {
  const bad = scopeWith(t, { [AUTH_MATERIAL_FILES.storageState]: "not json" });
  assert.equal(withExecScope(bad, () => readAgentBrowserSession("https://dev.example.com")).storageState, undefined);
  const wrongShape = scopeWith(t, { [AUTH_MATERIAL_FILES.storageState]: JSON.stringify({ cookies: "x" }) });
  assert.equal(withExecScope(wrongShape, () => readAgentBrowserSession("https://dev.example.com")).storageState, undefined);
  const linked = scopeWith(t, { "real.json": JSON.stringify(STATE) });
  symlinkSync(join(linked.authDir!, "real.json"), join(linked.authDir!, AUTH_MATERIAL_FILES.storageState));
  assert.equal(withExecScope(linked, () => readAgentBrowserSession("https://dev.example.com")).storageState, undefined);
});

test("outside a run's scope there is no session", () => {
  assert.deepEqual(readAgentBrowserSession("https://dev.example.com"), {});
});
