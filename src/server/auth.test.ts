import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { issueSession, validateSession, authorizeBearer, allowLocalWebLogin, isPublicControlPlaneRoute, LOCAL_CONSOLE_PRINCIPAL } from "./auth";

const secret = "test-signing-secret";

test("issueSession + validateSession round-trips the username", () => {
  const now = 1_000_000_000;
  const token = issueSession("alice", secret, 3600, now);
  assert.equal(validateSession(token, secret, now), "alice");
});

test("validateSession rejects an expired session", () => {
  const now = 1_000_000_000;
  const token = issueSession("alice", secret, 3600, now);
  assert.equal(validateSession(token, secret, now + 3601_000), null);
});

test("validateSession rejects a tampered payload", () => {
  const now = 1_000_000_000;
  const token = issueSession("alice", secret, 3600, now);
  const parts = token.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "admin", exp: 9_999_999_999 })).toString("base64url");
  assert.equal(validateSession(`${parts[0]}.${forged}.${parts[2]}`, secret, now), null);
});

test("validateSession rejects a token whose header is not our pinned header", () => {
  const now = 1_000_000_000;
  const token = issueSession("alice", secret, 3600, now);
  const parts = token.split(".");
  /* Re-sign with a forged "alg:none" header so the signature matches the forged header —
     it must still be rejected because the header is not the one we issue.
   */
  const forgedHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const forgedSig = createHmac("sha256", secret).update(`${forgedHeader}.${parts[1]}`).digest("base64url");
  assert.equal(validateSession(`${forgedHeader}.${parts[1]}.${forgedSig}`, secret, now), null);
});

test("validateSession rejects a wrong signing secret", () => {
  const now = 1_000_000_000;
  const token = issueSession("alice", secret, 3600, now);
  assert.equal(validateSession(token, "other-secret", now), null);
});

test("validateSession rejects malformed tokens", () => {
  assert.equal(validateSession("not-a-jwt", secret), null);
  assert.equal(validateSession("a.b", secret), null);
  assert.equal(validateSession("", secret), null);
});

const staticToken = "machine-token-abc";

test("authorizeBearer accepts the static machine token", () => {
  assert.equal(authorizeBearer(`Bearer ${staticToken}`, staticToken, secret), "machine");
});

test("authorizeBearer accepts a valid user session JWT", () => {
  const now = 1_000_000_000;
  const session = issueSession("alice", secret, 3600, now);
  assert.equal(authorizeBearer(`Bearer ${session}`, staticToken, secret, now), "alice");
});

test("authorizeBearer rejects an expired session JWT", () => {
  const now = 1_000_000_000;
  const session = issueSession("alice", secret, 3600, now);
  assert.equal(authorizeBearer(`Bearer ${session}`, staticToken, secret, now + 3601_000), null);
});

test("authorizeBearer rejects a wrong static token and non-bearer input", () => {
  assert.equal(authorizeBearer("Bearer wrong-token", staticToken, secret), null);
  assert.equal(authorizeBearer("Basic abc", staticToken, secret), null);
  assert.equal(authorizeBearer(undefined, staticToken, secret), null);
  assert.equal(authorizeBearer("", staticToken, secret), null);
});

test("authorizeBearer accepts a local-console session JWT", () => {
  const now = 1_000_000_000;
  const session = issueSession(LOCAL_CONSOLE_PRINCIPAL, secret, 3600, now);
  assert.equal(authorizeBearer(`Bearer ${session}`, staticToken, secret, now), LOCAL_CONSOLE_PRINCIPAL);
});

test("allowLocalWebLogin is opt-in or loopback-only — never a docker-bridge IP", () => {
  assert.equal(allowLocalWebLogin({ enabled: false, remoteAddress: "172.17.0.1" }), false);
  assert.equal(allowLocalWebLogin({ enabled: false, remoteAddress: "192.168.1.10" }), false);
  assert.equal(allowLocalWebLogin({ enabled: false }), false);
  assert.equal(allowLocalWebLogin({ enabled: false, remoteAddress: "127.0.0.1" }), true);
  assert.equal(allowLocalWebLogin({ enabled: false, remoteAddress: "::1" }), true);
  assert.equal(allowLocalWebLogin({ enabled: false, remoteAddress: "::ffff:127.0.0.1" }), true);
  assert.equal(allowLocalWebLogin({ enabled: true, remoteAddress: "172.17.0.1" }), true);
  assert.equal(allowLocalWebLogin({ enabled: true, remoteAddress: "8.8.8.8" }), true);
});

test("isPublicControlPlaneRoute includes the local-console bootstrap and the existing pre-auth surface", () => {
  assert.equal(isPublicControlPlaneRoute("GET", "/api/health"), true);
  assert.equal(isPublicControlPlaneRoute("GET", "/api/version"), true);
  assert.equal(isPublicControlPlaneRoute("POST", "/api/auth/login"), true);
  assert.equal(isPublicControlPlaneRoute("GET", "/api/auth/local"), true);
  assert.equal(isPublicControlPlaneRoute("POST", "/api/auth/local"), false);
  assert.equal(isPublicControlPlaneRoute("GET", "/api/apps"), false);
});
