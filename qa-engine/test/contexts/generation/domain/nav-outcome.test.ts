import { test } from "node:test";
import assert from "node:assert/strict";
import { NAV_OUTCOMES, classifyNavOutcome, isNavigationCall } from "@contexts/generation/domain/nav-outcome.ts";

const page = (url: string, title: string, body = "") => `### Ran Playwright code\nawait page.goto('${url}');\n\n### Page state\n- Page URL: ${url}\n- Page Title: ${title}\n- Page Snapshot:\n${body}`;
const login = { loginUrls: ["https://app.example/login"], authOnlyOrigins: [] as string[] };

test("a page that loaded is ok", () => {
  assert.equal(classifyNavOutcome({ status: "completed", output: page("https://app.example/dashboard", "Dashboard", "- heading Welcome"), ...login }), "ok");
});

test("landing on the declared login page after asking for another page is an auth challenge", () => {
  const output = page("https://app.example/login?next=%2Fdashboard", "Sign in");
  assert.equal(classifyNavOutcome({ status: "completed", output, requestedUrl: "https://app.example/dashboard", ...login }), "auth_challenge");
});

test("asking for the login page itself and getting it is ok", () => {
  assert.equal(classifyNavOutcome({ status: "completed", output: page("https://app.example/login", "Sign in"), requestedUrl: "https://app.example/login", ...login }), "ok");
});

test("a redirect to a dedicated auth origin is an auth challenge", () => {
  const output = page("https://sso.example/authorize?client=x", "SSO");
  assert.equal(classifyNavOutcome({ status: "completed", output, requestedUrl: "https://app.example/dashboard", loginUrls: ["https://sso.example/login"], authOnlyOrigins: ["https://sso.example"] }), "auth_challenge");
});

test("an unauthorized response is an auth challenge", () => {
  assert.equal(classifyNavOutcome({ status: "completed", output: page("https://app.example/admin", "401 Unauthorized"), ...login }), "auth_challenge");
  assert.equal(classifyNavOutcome({ status: "error", output: "Error: Response status code 403 Forbidden", ...login }), "auth_challenge");
});

test("an error status or a failed load is an http error", () => {
  assert.equal(classifyNavOutcome({ status: "completed", output: page("https://app.example/nope", "404 Not Found"), ...login }), "http_error");
  assert.equal(classifyNavOutcome({ status: "completed", output: page("https://app.example/x", "Internal Server Error 500"), ...login }), "http_error");
  assert.equal(classifyNavOutcome({ status: "error", output: "Error: page.goto: net::ERR_CONNECTION_REFUSED at https://app.example/", ...login }), "http_error");
  assert.equal(classifyNavOutcome({ status: "error", output: "Error: page.goto: net::ERR_NAME_NOT_RESOLVED", ...login }), "http_error");
});

test("a request the guard or the egress filter refused is blocked", () => {
  assert.equal(classifyNavOutcome({ status: "error", output: JSON.stringify({ ok: false, code: "blocked", message: "POST /api/x would write to DEV" }), ...login }), "blocked");
  assert.equal(classifyNavOutcome({ status: "error", output: "Error: page.goto: net::ERR_BLOCKED_BY_CLIENT", ...login }), "blocked");
  assert.equal(classifyNavOutcome({ status: "error", output: "net::ERR_TUNNEL_CONNECTION_FAILED", ...login }), "blocked");
});

test("a session the app closed is an auth challenge", () => {
  assert.equal(classifyNavOutcome({ status: "error", output: "session invalidated", ...login }), "auth_challenge");
});

test("words in the page's own content are not evidence: a page about errors is not an error page", () => {
  const body = "- heading \"How to handle a 404 Not Found or a 500 Server Error, net::ERR_NAME_NOT_RESOLVED and 401 Unauthorized\"";
  assert.equal(classifyNavOutcome({ status: "completed", output: page("https://app.example/docs/errors", "Error handling guide", body), ...login }), "unknown");
  assert.equal(classifyNavOutcome({ status: "completed", output: page("https://app.example/docs/errors", "404 Not Found", body), ...login }), "http_error", "the status and title portion still counts");
});

test("nothing to go on is unknown", () => {
  assert.equal(classifyNavOutcome({ status: "completed", output: "", ...login }), "unknown");
  assert.equal(classifyNavOutcome({ status: "error", output: "something odd", ...login }), "unknown");
});

test("the classifier reads a bounded prefix and never throws", () => {
  const huge = "x".repeat(2_000_000) + " 404 Not Found";
  assert.equal(classifyNavOutcome({ status: "completed", output: huge, ...login }), "ok");
  assert.equal(classifyNavOutcome({ status: "completed", output: undefined as unknown as string, ...login }), "unknown");
});

test("a tool call is a navigation by its name, whatever server prefix it carries", () => {
  for (const tool of ["browser_navigate", "playwright_browser_navigate", "mcp__playwright__browser_navigate", "authbrowser_navigate"]) assert.equal(isNavigationCall(tool), true, tool);
  for (const tool of ["browser_click", "read", "authbrowser_snapshot", "navigate_to_symbol"]) assert.equal(isNavigationCall(tool), false, tool);
});

test("every outcome the classifier answers is a member of the exported set", () => {
  const outputs = ["", page("https://app.example/x", "X"), "net::ERR_NAME_NOT_RESOLVED", "401 Unauthorized", "session invalidated", '{"code":"blocked"}'];
  for (const output of outputs) assert.ok((NAV_OUTCOMES as readonly string[]).includes(classifyNavOutcome({ status: "completed", output, ...login })), output);
});
