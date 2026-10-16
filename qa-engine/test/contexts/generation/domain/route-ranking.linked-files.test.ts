import { test } from "node:test";
import assert from "node:assert/strict";
import { filesLinkedToPages } from "@contexts/generation/domain/route-ranking.ts";

const MAP = {
  routes: [
    { path: "/restaurantes", source: "src/app/app.routes.ts", implementationFiles: ["src/app/list/list.page.ts", "src/app/list/list.page.html"] },
    { path: "/cuenta", implementationFiles: ["src/app/account/account.page.ts"] },
  ],
};

test("a changed file a route declares as an implementation file or as its source is linked to a page", () => {
  const linked = filesLinkedToPages(MAP, ["src/app/list/list.page.html", "src/app/app.routes.ts", "src/app/util/messages.ts"]);
  assert.deepEqual([...linked].sort(), ["src/app/app.routes.ts", "src/app/list/list.page.html"]);
});

test("a file that only shares a name with a declared one is not linked, and a re-rooted path is", () => {
  assert.equal(filesLinkedToPages(MAP, ["other/list.page.html"]).size, 0);
  assert.deepEqual([...filesLinkedToPages(MAP, ["web/src/app/account/account.page.ts"])], ["web/src/app/account/account.page.ts"]);
});

test("a map with no routes, or no map, links nothing", () => {
  assert.equal(filesLinkedToPages(undefined, ["a/b.ts"]).size, 0);
  assert.equal(filesLinkedToPages({ routes: [] }, ["a/b.ts"]).size, 0);
  assert.equal(filesLinkedToPages({ routes: "nope" }, ["a/b.ts"]).size, 0);
});

test("a route entry that is not well formed contributes nothing and does not stop the others", () => {
  const linked = filesLinkedToPages({ routes: [null, { path: "/x", implementationFiles: [1, "a/b.ts"] }, { path: "/y", implementationFiles: ["c/d.ts"] }] }, ["a/b.ts", "c/d.ts"]);
  assert.deepEqual([...linked], ["c/d.ts"]);
});
