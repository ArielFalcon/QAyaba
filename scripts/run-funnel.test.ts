import { test } from "node:test";
import assert from "node:assert/strict";
import { main, parseArguments, type FunnelDeps } from "./run-funnel.ts";

function harness(rows: Awaited<ReturnType<FunnelDeps["funnel"]>> = []) {
  const out: string[] = [];
  const asked: Array<{ app?: string; since?: string }> = [];
  const deps: FunnelDeps = { funnel: (opts) => { asked.push(opts); return rows; }, out: (line) => out.push(line) };
  return { deps, out, asked };
}

test("the funnel arguments name an app and a date, both optional", () => {
  assert.deepEqual(parseArguments([]), { ok: true, app: undefined, since: undefined });
  assert.deepEqual(parseArguments(["--app", "shop", "--since", "2026-10-01T00:00:00Z"]), { ok: true, app: "shop", since: "2026-10-01T00:00:00.000Z" });
});

test("a date in another spelling reaches the query as the UTC instant it names", () => {
  assert.deepEqual(parseArguments(["--since", "2026-10-01T02:00:00+02:00"]), { ok: true, app: undefined, since: "2026-10-01T00:00:00.000Z" });
});

test("an unknown argument, a missing value or a date that is not one is refused", () => {
  assert.equal(parseArguments(["--bogus"]).ok, false);
  assert.equal(parseArguments(["--app"]).ok, false);
  assert.equal(parseArguments(["--since", "yesterday"]).ok, false);
});

test("the funnel prints one line per group with its count, a run with no recorded phase as unknown", async () => {
  const { deps, out } = harness([
    { furthestPhase: "setup", verdict: "infra-error", errorClass: "E-INFRA", count: 2 },
    { furthestPhase: null, verdict: "infra-error", errorClass: null, count: 1 },
    { furthestPhase: "learn", verdict: "pass", errorClass: null, count: 5 },
  ]);

  assert.equal(await main([], deps), 0);

  const text = out.join("\n");
  assert.match(text, /setup\s+infra-error\s+E-INFRA\s+2/);
  assert.match(text, /\(unknown\)\s+infra-error\s+-\s+1/);
  assert.match(text, /learn\s+pass\s+-\s+5/);
  assert.match(text, /total\s+8/);
});

test("the filters reach the query", async () => {
  const { deps, asked } = harness();
  await main(["--app", "shop", "--since", "2026-10-01T00:00:00Z"], deps);
  assert.deepEqual(asked, [{ app: "shop", since: "2026-10-01T00:00:00.000Z" }]);
});

test("a funnel with no finished runs says so", async () => {
  const { deps, out } = harness([]);
  assert.equal(await main([], deps), 0);
  assert.match(out.join("\n"), /no finished runs/);
});

test("a bad argument prints the usage and exits 2", async () => {
  const { deps, out } = harness();
  assert.equal(await main(["--nope"], deps), 2);
  assert.match(out.join("\n"), /usage: npm run funnel/);
});
