/*
 * The web console's login screen, booted in live mode with no stored session and no loopback
 * auto-login, against a scripted control API. Assertions read what the operator sees (the login
 * screen and its error line) and what the browser asks of which origin — never console internals.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { controlApi, loadConsole, type ConsoleRequest, type Reply } from "./console-harness";

const ACCEPTED_TOKEN = "session-token-accepted";

/* A server with GitHub login configured, loopback auto-login off, and one accepted bearer token. */
function signedOutServer() {
  const api = controlApi({ apps: [], runs: [] });
  return (req: ConsoleRequest): Reply => {
    if (req.path === "/api/v1/version") return { status: 200, json: { server: "1.0.0", githubClientId: "Iv1.configured" } };
    if (req.path === "/api/v1/apps" && req.headers.authorization !== `Bearer ${ACCEPTED_TOKEN}`) {
      return { status: 401, json: { error: "unauthorized" } };
    }
    return api(req);
  };
}

async function signedOutConsole() {
  const h = await loadConsole({ withConsole: true, token: null, routes: signedOutServer() });
  await h.advance(1_000);
  assert.equal(h.loginVisible(), true, "a signed-out console asks the operator to sign in");
  return h;
}

test("no login control makes the browser call another origin", async () => {
  const h = await signedOutConsole();
  const controls = h.loginControls();
  assert.ok(controls.length > 0, "the login screen offers at least one way to sign in");

  for (const id of controls) {
    h.pressLogin(id);
    await h.advance(20 * 60_000);
  }

  const crossOrigin = h.requests.filter((r) => r.origin !== null).map((r) => `${r.origin}${r.path}`);
  assert.deepEqual(crossOrigin, [], "the browser cannot reach another origin's API (CORS), so the console must not try");
});

test("a pasted token the server accepts signs the console in", async () => {
  const h = await signedOutConsole();

  h.typeLogin("token-input", ACCEPTED_TOKEN);
  h.pressLogin("btn-token-login");
  await h.advance(1_000);

  assert.ok([...h.storage.values()].includes(ACCEPTED_TOKEN), "the accepted token becomes the console's session");
  assert.equal(h.loginError(), "");
});

test("a pasted token the server rejects is refused and never kept", async () => {
  const h = await signedOutConsole();

  h.typeLogin("token-input", "not-a-valid-token");
  h.pressLogin("btn-token-login");
  await h.advance(1_000);

  assert.ok(![...h.storage.values()].includes("not-a-valid-token"), "a rejected token is not stored");
  assert.notEqual(h.loginError(), "", "the operator is told the token was refused");
  assert.equal(h.loginVisible(), true);
});

/* A server that rejects every token but FRESH_TOKEN, and whose loopback auto-login hands one out. */
const FRESH_TOKEN = "session-token-from-auto-login";
function loopbackServer() {
  const api = controlApi({ apps: [], runs: [] });
  return (req: ConsoleRequest): Reply => {
    if (req.path === "/api/v1/auth/local") return { status: 200, json: { token: FRESH_TOKEN, username: "local-console" } };
    if (req.headers.authorization !== `Bearer ${FRESH_TOKEN}`) return { status: 401, json: { error: "unauthorized" } };
    return api(req);
  };
}

test("a session that expires signs in again through the loopback auto-login before asking for a token", async () => {
  const h = await loadConsole({ withConsole: true, token: "expired", routes: loopbackServer() });
  await h.advance(1_000);

  assert.equal(h.requestsTo("/api/v1/auth/local").length, 1, "the auto-login is tried once");
  assert.ok([...h.storage.values()].includes(FRESH_TOKEN), "the auto-login's session replaces the expired one");
  assert.equal(h.loginVisible(), false, "no token prompt while the auto-login signs the console in");
});

test("a session that expires again right after the auto-login retry asks for a token", async () => {
  const h = await loadConsole({ withConsole: true, token: "expired", routes: loopbackServer() });
  await h.advance(1_000);

  await h.api.loadAll().catch(() => undefined);
  await h.advance(1_000);

  assert.equal(h.requestsTo("/api/v1/auth/local").length, 1, "the auto-login is retried only once");
  assert.equal(h.loginVisible(), true);
});
