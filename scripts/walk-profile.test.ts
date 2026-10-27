/* The walk profile reads a recorded store (the Angular route fixture) and replays a change's walk; it writes nothing. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, percentile } from "./walk-profile.ts";

const STORE = join(import.meta.dirname, "..", "qa-engine", "test", "shared-infrastructure", "code-graph", "__fixtures__", "codegraph-angular-routes", "store.db");

/* A one-line edit of the login page's class (src/app/login/login.page.ts line 4). */
const DIFF = [
  "diff --git a/src/app/login/login.page.ts b/src/app/login/login.page.ts",
  "--- a/src/app/login/login.page.ts",
  "+++ b/src/app/login/login.page.ts",
  "@@ -4 +4 @@",
  "-export class LoginPage {}",
  "+export class LoginPage { readonly title = 'Sign in'; }",
  "",
].join("\n");

interface Replay {
  current: { seeds: number; truncated: boolean; nodesVisited: number; pagesReached: number; routesReached: number };
  policies: { policy: string; fanInLimit: number | null; nodesVisited: number; pagesReached: number; hubSeeds: number }[];
}

function profile(extra: (dir: string) => string[]): { inDegree: { all: { n: number; max: number } }; replay?: Replay } {
  const dir = mkdtempSync(join(tmpdir(), "walk-profile-"));
  try {
    const lines: string[] = [];
    assert.equal(main(["--store", STORE, "--json", ...extra(dir)], (l) => lines.push(l)), 0);
    const json = lines.join("\n");
    return JSON.parse(json.slice(json.indexOf("\n[") + 1))[0];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a percentile is the nearest-rank value of the ascending list", () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(xs, 50), 5);
  assert.equal(percentile(xs, 95), 10);
  assert.equal(percentile(xs, 10), 1);
  assert.equal(percentile([], 99), 0);
});

test("without a diff only the store's in-degree distribution is reported", () => {
  const out = profile(() => []);
  assert.ok(out.inDegree.all.n > 0);
  assert.equal(out.replay, undefined);
});

test("a change's walk is replayed through the store reader and reaches the pages the map names and the routes to them", () => {
  const out = profile((dir) => {
    writeFileSync(join(dir, "change.diff"), DIFF);
    writeFileSync(join(dir, "map.json"), JSON.stringify({ routes: [{ path: "/login", implementationFiles: ["src/app/login/login.page.ts"] }, { path: "/home", implementationFiles: ["src/app/home/home.page.ts"] }] }));
    return ["--diff", join(dir, "change.diff"), "--map", join(dir, "map.json")];
  });
  const { current, policies } = out.replay!;
  assert.equal(current.seeds, 1, "the class holding the edited line");
  assert.equal(current.truncated, false);
  assert.equal(current.pagesReached, 1, "/login, not /home");
  assert.equal(current.routesReached, 1, "the route path /login, declared twice");
  const complete = policies.find((p) => p.fanInLimit === null)!;
  assert.equal(complete.nodesVisited, current.nodesVisited, "an uncut walk visits what the reader visits");
});
