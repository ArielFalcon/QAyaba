import { test } from "node:test";
import assert from "node:assert/strict";
import { stepIntentContextFor } from "./turn-telemetry-config";

test("an e2e app's tests are written in its suite directory and its login is the declared path on its own origin", () => {
  const ctx = stepIntentContextFor({ target: "e2e", e2eRelDir: "e2e", baseUrl: "https://dev.shop.example", loginPath: "/signin", reviewAgents: ["qa-reviewer"] });
  const { specTargets, authFiles, loginUrls, authOnlyOrigins, reviewAgents } = ctx;
  assert.deepEqual(specTargets, { kind: "dir", relDir: "e2e" });
  assert.deepEqual([authFiles, loginUrls, authOnlyOrigins, reviewAgents], [["e2e/auth.setup.ts"], ["https://dev.shop.example/signin"], [], ["qa-reviewer"]]);
});

test("a code target has no suite directory, no login and no auth file: every write is a test", () => {
  const ctx = stepIntentContextFor({ target: "code", e2eRelDir: "e2e", reviewAgents: [] });
  assert.deepEqual(ctx.specTargets, { kind: "any-write" });
  assert.deepEqual([ctx.authFiles, ctx.loginUrls, ctx.authOnlyOrigins], [[], [], []]);
});

test("a login on another origin than the app's makes that origin a login-only origin", () => {
  const ctx = stepIntentContextFor({ target: "e2e", e2eRelDir: "e2e", baseUrl: "https://dev.shop.example", loginPath: "https://sso.example/login", reviewAgents: [] });
  assert.deepEqual(ctx.loginUrls, ["https://sso.example/login"]);
  assert.deepEqual(ctx.authOnlyOrigins, ["https://sso.example"]);
});

test("an app with no declared login path declares no login address", () => {
  const ctx = stepIntentContextFor({ target: "e2e", e2eRelDir: "e2e", baseUrl: "https://dev.shop.example", reviewAgents: [] });
  assert.deepEqual([ctx.loginUrls, ctx.authOnlyOrigins], [[], []]);
});
