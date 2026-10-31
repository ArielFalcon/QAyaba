import { test } from "node:test";
import assert from "node:assert/strict";
import { detectInvalidation, INVALIDATION_KIND } from "@contexts/test-execution/domain/agent-browser-session-invalidation.ts";

const page = (over: Record<string, unknown> = {}) => ({ url: "https://dev.example.com/orders", requestedPath: "/orders", viaNavigation: true, documentStatus: 200, passwordFieldVisible: false, ...over });

test("a page of the app that was asked for and shows no sign-in is a valid session", () => {
  assert.equal(detectInvalidation(page(), {}), undefined);
});

test("being sent to a login path from the page asked for is an invalid session", () => {
  for (const path of ["/login", "/signin", "/sign-in", "/users/sign_in", "/auth", "/sso/start", "/Login?next=/orders"]) {
    const found = detectInvalidation(page({ url: `https://dev.example.com${path}` }), {});
    assert.equal(found?.kind, INVALIDATION_KIND.LOGIN_PAGE, path);
    assert.equal(detectInvalidation(page({ url: `https://dev.example.com${path}`, requestedPath: path.split("?")[0] }), {}), undefined, `${path} when it is the page that was asked for`);
  }
});

test("the app's own login path counts as one, when the call was sent there", () => {
  assert.equal(detectInvalidation(page({ url: "https://dev.example.com/entrar" }), {}), undefined);
  assert.equal(detectInvalidation(page({ url: "https://dev.example.com/entrar" }), { loginPath: "/entrar" })?.kind, INVALIDATION_KIND.LOGIN_PAGE);
  assert.equal(detectInvalidation(page({ url: "https://dev.example.com/entrar/paso-2" }), { loginPath: "/entrar" })?.kind, INVALIDATION_KIND.LOGIN_PAGE);
  assert.equal(detectInvalidation(page({ url: "https://dev.example.com/entrar", requestedPath: "/entrar" }), { loginPath: "/entrar" }), undefined, "asking for the login page and getting it says nothing about the session");
});

test("a page of the app whose path merely looks like a login (an auth callback, an sso settings page) is not a lost session when the agent asked for it", () => {
  for (const path of ["/auth/callback", "/settings/sso", "/auth/sessions", "/sso"]) {
    assert.equal(detectInvalidation(page({ url: `https://dev.example.com${path}`, requestedPath: path }), {}), undefined, path);
  }
});

test("a click that lands on a page whose path looks like a login is a lost session only when that page also asks for a password", () => {
  const clicked = (over: Record<string, unknown>) => page({ viaNavigation: false, requestedPath: "/orders", ...over });
  assert.equal(detectInvalidation(clicked({ url: "https://dev.example.com/settings/sso" }), {}), undefined, "a link to an sso settings page");
  assert.equal(detectInvalidation(clicked({ url: "https://dev.example.com/auth/login", passwordFieldVisible: true }), {})?.kind, INVALIDATION_KIND.LOGIN_PAGE);
  assert.equal(detectInvalidation(clicked({ url: "https://dev.example.com/entrar" }), { loginPath: "/entrar" })?.kind, INVALIDATION_KIND.LOGIN_PAGE, "the app said where its login is");
});

test("a 401 on the page document is an invalid session, a 403 or a 500 is not", () => {
  assert.equal(detectInvalidation(page({ documentStatus: 401 }), {})?.kind, INVALIDATION_KIND.UNAUTHORIZED);
  assert.equal(detectInvalidation(page({ documentStatus: 403 }), {}), undefined);
  assert.equal(detectInvalidation(page({ documentStatus: 500 }), {}), undefined);
  assert.equal(detectInvalidation(page({ documentStatus: undefined }), {}), undefined);
});

test("a visible password field on a page other than the one a navigation asked for is an invalid session", () => {
  const found = detectInvalidation(page({ url: "https://dev.example.com/welcome", passwordFieldVisible: true }), {});
  assert.equal(found?.kind, INVALIDATION_KIND.PASSWORD_FIELD);
});

test("a password field on a page that a click led to is that page (change password, security settings), not a lost session", () => {
  assert.equal(detectInvalidation(page({ viaNavigation: false, url: "https://dev.example.com/settings/security", passwordFieldVisible: true }), {}), undefined);
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

test("a login path with a trailing slash covers the page and what is under it, and nothing that merely starts with its name", () => {
  const over = (path: string) => detectInvalidation(page({ url: `https://dev.example.com${path}` }), { loginPath: "/entrar/" })?.kind;
  assert.equal(over("/entrar"), INVALIDATION_KIND.LOGIN_PAGE);
  assert.equal(over("/entrar/"), INVALIDATION_KIND.LOGIN_PAGE);
  assert.equal(over("/entrar/paso-2"), INVALIDATION_KIND.LOGIN_PAGE);
  assert.equal(over("/entrarx"), undefined);
  assert.equal(detectInvalidation(page({ url: "https://dev.example.com/entrar" }), { loginPath: "entrar" }), undefined, "a login path that is not a path is ignored");
});

test("an address that is not a URL is judged by its path alone", () => {
  assert.equal(detectInvalidation(page({ url: "/login?next=%2Forders#top" }), {})?.kind, INVALIDATION_KIND.LOGIN_PAGE);
  const found = detectInvalidation(page({ url: "/login?token=abc#frag" }), {});
  assert.doesNotMatch(found?.detail ?? "", /abc|frag/);
});

test("a 401 and a password field each say what was seen, and the detail names the path", () => {
  assert.match(detectInvalidation(page({ documentStatus: 401 }), {})?.detail ?? "", /\/orders/);
  assert.match(detectInvalidation(page({ url: "https://dev.example.com/welcome", passwordFieldVisible: true }), {})?.detail ?? "", /\/welcome/);
});
