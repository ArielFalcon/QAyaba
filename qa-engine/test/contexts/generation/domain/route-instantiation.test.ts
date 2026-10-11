/* How a route template of the map becomes a page that can be opened: a real link the site shows, matched segment by segment. Pure and deterministic. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LINK_LENGTH,
  MAX_LINKS_PER_PAGE,
  instantiableTemplate,
  instantiateRoute,
  sameOriginPathnames,
} from "@contexts/generation/domain/route-instantiation.ts";
import { classifyRoute } from "@kernel/route-capturability.ts";

type Case = readonly [label: string, template: string, links: readonly string[], expected: string | undefined];

const INSTANTIATION: readonly Case[] = [
  ["a link of the same length fills a colon parameter", "/product/:id", ["/product/42"], "/product/42"],
  ["a brace parameter is filled the same way", "/users/{id}/posts", ["/users/7/posts"], "/users/7/posts"],
  ["a bracket parameter is filled the same way", "/blog/[slug]", ["/blog/hello"], "/blog/hello"],
  ["several parameters among literals", "/shops/:province/:city", ["/shops/madrid/madrid"], "/shops/madrid/madrid"],
  ["a literal segment must be equal", "/a/:id/edit", ["/a/1/view", "/a/2/edit"], "/a/2/edit"],
  ["a literal in front must be equal", "/a/:id", ["/b/1", "/a/9"], "/a/9"],
  ["the first matching link in harvest order wins", "/p/:id", ["/p/3", "/p/1", "/p/2"], "/p/3"],
  ["a link with a trailing slash still matches, and the instance has none", "/p/:id", ["/p/3/"], "/p/3"],
  ["a parameter takes one non-empty segment only", "/p/:id", ["/p/"], undefined],
  ["no link of the page matches", "/p/:id", ["/q/1", "/"], undefined],
  ["no links at all", "/p/:id", [], undefined],
  ["a shorter link cannot be extended", "/shops/:province/:city", ["/shops/madrid", "/shops"], undefined],
  ["a longer link gives its leading segments when none has the length", "/shops/:province/:city", ["/shops/madrid/madrid/bar-1"], "/shops/madrid/madrid"],
  ["a link of the exact length wins over an earlier longer one", "/shops/:province/:city", ["/shops/a/b/c", "/shops/x/y"], "/shops/x/y"],
  ["the longer link must match the literals of the template", "/shops/:p/list/:c", ["/shops/a/other/c/d"], undefined],
  ["the root link does not instantiate anything", "/p/:id", ["/"], undefined],
  ["an optional parameter names a page of no fixed length", "/users/:id?", ["/users/1"], undefined],
  ["a catch-all names no single page", "/docs/[...rest]", ["/docs/a/b"], undefined],
  ["a wildcard names no single page", "/files/*", ["/files/a"], undefined],
  ["a segment that mixes a parameter and text is not filled", "/p/id-{id}", ["/p/id-1"], undefined],
  ["a template with no parameter is not instantiated", "/cart", ["/cart"], undefined],
  ["a template with a query is not instantiated", "/p/:id?x=1", ["/p/1"], undefined],
  ["a hash route is not instantiated", "#/p/:id", ["/p/1"], undefined],
  ["a template with no leading slash is not instantiated", "p/:id", ["/p/1"], undefined],
  ["a link that is another host is never an instance", "/p/:id", ["//evil.example/p"], undefined],
  ["a link that is itself a template is skipped for the next one", "/p/:id", ["/p/:id", "/p/5"], "/p/5"],
  ["a link with an empty segment inside is skipped", "/p/:id", ["/p//x", "/p/5"], "/p/5"],
  ["a query on a link is not part of the instance", "/p/:id", ["/p/5?tab=2#top"], "/p/5"],
];

for (const [label, template, links, expected] of INSTANTIATION) {
  test(`instantiateRoute: ${label}`, () => {
    assert.equal(instantiateRoute(template, links), expected);
  });
}

test("instantiateRoute: an instance is always a route a browser can open as written", () => {
  const instance = instantiateRoute("/a/:x", ["/a/[b]", "/a/*", "/a/ok"]);
  assert.equal(instance, "/a/ok");
  assert.deepEqual(classifyRoute(instance!), { capturable: true });
});

test("instantiableTemplate: only a template made of literals and whole-segment parameters qualifies", () => {
  for (const template of ["/a/:id", "/a/{id}/b", "/a/[id]", "/a/:p/:c"]) assert.equal(instantiableTemplate(template), true, template);
  for (const template of ["/a", "/a/*", "/a/:id?", "/a/[...rest]", "/a/x-{id}", "#/a/:id", "a/:id", "/a/:id#x", ""]) assert.equal(instantiableTemplate(template), false, template);
});

const BASE = "https://dev.example.com";

test("sameOriginPathnames: keeps the pathnames of the links on the origin of the site, in page order, once each", () => {
  const hrefs = [`${BASE}/a/1?x=2#top`, `${BASE}/b`, `${BASE}/a/1`, "https://other.example.com/c", `${BASE}/`];
  assert.deepEqual(sameOriginPathnames(hrefs, BASE), ["/a/1", "/b", "/"]);
});

test("sameOriginPathnames: skips what is not an address on the origin", () => {
  const hrefs = ["mailto:a@b.example", "javascript:alert(1)", "not a url", 42, null, `${BASE}:8443/other-port`, "http://dev.example.com/other-scheme", `${BASE}/ok`];
  assert.deepEqual(sameOriginPathnames(hrefs, BASE), ["/ok"]);
});

test("sameOriginPathnames: a value that is not a list gives no links", () => {
  assert.deepEqual(sameOriginPathnames(undefined, BASE), []);
  assert.deepEqual(sameOriginPathnames("/a", BASE), []);
  assert.deepEqual(sameOriginPathnames({ length: 1, 0: `${BASE}/a` }, BASE), []);
});

test("sameOriginPathnames: an unusable base gives no links", () => {
  assert.deepEqual(sameOriginPathnames([`${BASE}/a`], "not a url"), []);
});

test("sameOriginPathnames: is bounded in how many links it keeps and how long one may be", () => {
  const many = Array.from({ length: MAX_LINKS_PER_PAGE + 25 }, (_, i) => `${BASE}/p/${i}`);
  assert.equal(sameOriginPathnames(many, BASE).length, MAX_LINKS_PER_PAGE);
  const long = `${BASE}/${"x".repeat(MAX_LINK_LENGTH + 1)}`;
  assert.deepEqual(sameOriginPathnames([long, `${BASE}/short`], BASE), ["/short"]);
});
