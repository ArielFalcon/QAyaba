/* A route named in a log line may come from a page the capture opened, so what reaches the log is cleaned and bounded. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loggableRoute, loggableRoutes, MAX_LOGGED_ROUTE_CHARS, MAX_LOGGED_ROUTES } from "@contexts/generation/infrastructure/loggable-route.ts";

const TOKEN = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("loggableRoute: a secret in a route is redacted", () => {
  assert.equal(loggableRoute(`/reset/${TOKEN}`).includes("ghp_AAAA"), false);
});

test("loggableRoute: a route is cut at its bound", () => {
  assert.ok(loggableRoute(`/${"ab-".repeat(MAX_LOGGED_ROUTE_CHARS)}`).length <= MAX_LOGGED_ROUTE_CHARS);
});

test("loggableRoute: a route of exactly the bound is kept whole, and one more character is cut to the bound with a mark", () => {
  /* Hyphens keep the text from looking like a long encoded secret, which the redaction would replace. */
  const whole = `/${"ab-".repeat(MAX_LOGGED_ROUTE_CHARS)}`.slice(0, MAX_LOGGED_ROUTE_CHARS);
  assert.equal(loggableRoute(whole), whole);
  const cut = loggableRoute(`${whole}y`);
  assert.equal(cut.length, MAX_LOGGED_ROUTE_CHARS);
  assert.ok(cut.endsWith("…") && cut.startsWith("/ab-ab-"));
});

test("loggableRoute: a short route is left as it is", () => {
  assert.equal(loggableRoute("/shops/madrid"), "/shops/madrid");
});

test("loggableRoute: a control character cannot start a line of the log", () => {
  assert.equal(/[\n\r\u0000-\u001f\u007f]/.test(loggableRoute("/a\nINJECTED\r\u0000b")), false);
});

test("loggableRoute: a line break or a tab in a route becomes a space", () => {
  assert.equal(loggableRoute("/a\nb\tc"), "/a b c");
});

test("loggableRoutes: a list of exactly the bound is complete and says nothing of more", () => {
  const routes = Array.from({ length: MAX_LOGGED_ROUTES }, (_, i) => `/r${i}`);
  assert.equal(loggableRoutes(routes), routes.join(", "));
});

test("loggableRoutes: lists the routes cleaned, and counts those beyond its bound", () => {
  const extra = 3;
  const routes = Array.from({ length: MAX_LOGGED_ROUTES + extra }, (_, i) => `/r${i}`);
  const text = loggableRoutes(routes);
  assert.ok(text.includes(`/r${MAX_LOGGED_ROUTES - 1}`));
  assert.equal(text.includes(`/r${MAX_LOGGED_ROUTES},`) || text.endsWith(`/r${MAX_LOGGED_ROUTES}`), false, "the first beyond the bound is not listed");
  assert.ok(text.endsWith(`(+${extra} more)`), "and the count of the rest is stated");
});

test("loggableRoutes: no route gives an empty text", () => {
  assert.equal(loggableRoutes([]), "");
});
