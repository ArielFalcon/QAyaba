import { test } from "node:test";
import assert from "node:assert/strict";
import { detectInvalidation, INVALIDATION_KIND } from "@contexts/test-execution/domain/agent-browser-session-invalidation.ts";

const page = (over: Record<string, unknown> = {}) => ({ url: "https://dev.example.com/orders", requestedPath: "/orders", documentStatus: 200, passwordFieldVisible: false, ...over });

test("a page of the app that was asked for and shows no sign-in is a valid session", () => {
  assert.equal(detectInvalidation(page(), {}), undefined);
});

test("landing on a login path is an invalid session, whether or not it was the page asked for", () => {
  for (const path of ["/login", "/signin", "/sign-in", "/users/sign_in", "/auth", "/sso/start", "/Login?next=/orders"]) {
    const found = detectInvalidation(page({ url: `https://dev.example.com${path}` }), {});
    assert.equal(found?.kind, INVALIDATION_KIND.LOGIN_PAGE, path);
  }
});

test("the app's own login path counts as one", () => {
  assert.equal(detectInvalidation(page({ url: "https://dev.example.com/entrar" }), {}), undefined);
  assert.equal(detectInvalidation(page({ url: "https://dev.example.com/entrar" }), { loginPath: "/entrar" })?.kind, INVALIDATION_KIND.LOGIN_PAGE);
  assert.equal(detectInvalidation(page({ url: "https://dev.example.com/entrar/paso-2" }), { loginPath: "/entrar" })?.kind, INVALIDATION_KIND.LOGIN_PAGE);
});

test("a 401 on the page document is an invalid session, a 403 or a 500 is not", () => {
  assert.equal(detectInvalidation(page({ documentStatus: 401 }), {})?.kind, INVALIDATION_KIND.UNAUTHORIZED);
  assert.equal(detectInvalidation(page({ documentStatus: 403 }), {}), undefined);
  assert.equal(detectInvalidation(page({ documentStatus: 500 }), {}), undefined);
  assert.equal(detectInvalidation(page({ documentStatus: undefined }), {}), undefined);
});

test("a visible password field on a page other than the one asked for is an invalid session", () => {
  const found = detectInvalidation(page({ url: "https://dev.example.com/welcome", passwordFieldVisible: true }), {});
  assert.equal(found?.kind, INVALIDATION_KIND.PASSWORD_FIELD);
});

test("a password field on the very page the agent asked for is that page, not a lost session", () => {
  assert.equal(detectInvalidation(page({ url: "https://dev.example.com/settings/password", requestedPath: "/settings/password", passwordFieldVisible: true }), {}), undefined);
});

test("the finding names what was seen without the query or fragment of the address", () => {
  const found = detectInvalidation(page({ url: "https://dev.example.com/login?token=abc#frag" }), {});
  assert.ok(found);
  assert.doesNotMatch(found.detail, /abc|frag/);
  assert.match(found.detail, /\/login/);
});
