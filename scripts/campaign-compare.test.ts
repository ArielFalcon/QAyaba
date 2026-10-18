import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArguments, runCompare, collectCampaign, type CompareDeps } from "./campaign-compare.ts";

const catalog = {
  schemaVersion: 1,
  phases: ["gate"],
  scores: [
    { name: "spec_pass_rate", dataType: "NUMERIC", polarity: "higher_better", graderVersion: "1" },
    { name: "context_utilization", dataType: "NUMERIC", polarity: "higher_better", suffixes: ["route", "dom"], graderVersion: "1" },
    { name: "auth_overhead", dataType: "NUMERIC", polarity: "lower_better", graderVersion: "1" },
  ],
};

type Row = { id: string; arm: string; replicate: number; evaluationStatus?: "pending" | "complete"; pass: number; auth: number };
function service(rows: Row[], complete = true): { deps: CompareDeps; out: string[]; written: Map<string, string>; gets: string[] } {
  const out: string[] = [];
  const written = new Map<string, string>();
  const gets: string[] = [];
  const deps: CompareDeps = {
    get: async (path) => {
      gets.push(path);
      if (path === "/api/v1/campaigns/c1/runs") {
        return { schemaVersion: 1, campaignId: "c1", complete, runs: rows.map((r) => ({ id: r.id, variant: { arm: r.arm }, replicate: r.replicate, status: "done", evaluationStatus: r.evaluationStatus ?? "complete" })) };
      }
      if (path === "/api/v1/evaluations/catalog") return catalog;
      const m = /^\/api\/v1\/runs\/([^/]+)\/evaluation$/.exec(path);
      const row = rows.find((r) => r.id === m?.[1]);
      if (!row) throw new Error(`GET ${path} answered HTTP 404`);
      return {
        schemaVersion: 1, runId: row.id, traceId: null, status: "complete",
        scores: [
          { name: "spec_pass_rate", value: row.pass, dataType: "NUMERIC", polarity: "none", source: "deterministic", graderVersion: "1" },
          { name: "auth_overhead", value: row.auth, dataType: "NUMERIC", polarity: "none", source: "deterministic", graderVersion: "1" },
          { name: "context_utilization.dom", value: 0.5, dataType: "NUMERIC", polarity: "none", source: "deterministic", graderVersion: "1" },
        ],
      };
    },
    out: (line) => out.push(line),
    writeText: (path, text) => void written.set(path, text),
  };
  return { deps, out, written, gets };
}

const rows = (): Row[] => [1, 2, 3].flatMap((rep) => [
  { id: `c${rep}`, arm: "control", replicate: rep, pass: 0.1 * rep, auth: 10 + rep },
  { id: `t${rep}`, arm: "treatment", replicate: rep, pass: 0.8 + 0.01 * rep, auth: 1 + rep },
]);

test("the arguments need a campaign, take repeatable variant baselines and bound the numbers", () => {
  assert.equal(parseArguments([]).ok, false);
  assert.equal(parseArguments(["--campaign", "bad id"]).ok, false);
  const ok = parseArguments(["--campaign", "c1", "--baseline", "variant.arm=control", "--baseline", "variant.model=m1", "--seed", "5"]);
  assert.ok(ok.ok && ok.baseline.arm === "control" && ok.baseline.model === "m1" && ok.seed === 5);
  for (const bad of [["--baseline", "arm=control"], ["--baseline", "variant.arm=a", "--baseline", "variant.arm=b"], ["--iterations", "0"], ["--seed", "x"], ["--bogus", "1"], ["--out"]]) {
    assert.equal(parseArguments(["--campaign", "c1", ...bad]).ok, false, bad.join(" "));
  }
});

test("scores are read through the public API, polarity comes from the catalog and a suffixed name inherits its base", async () => {
  const s = service(rows());
  const { runs } = await collectCampaign("c1", s.deps);
  const first = runs[0]!;
  assert.equal(first.scores.find((x) => x.name === "auth_overhead")!.polarity, "lower_better");
  assert.equal(first.scores.find((x) => x.name === "context_utilization.dom")!.polarity, "higher_better");
  assert.ok(s.gets.every((g) => g.startsWith("/api/v1/")));
  assert.ok(s.gets.every((g) => !g.includes("versions")), "the default view is the graders' rows only; human labels need versions=all and are never compared");
});

test("the report compares the arms against the baseline, and lower_better makes a drop a lift", async () => {
  const s = service(rows());
  assert.equal(await runCompare(["--campaign", "c1", "--baseline", "variant.arm=control", "--out", "/o", "--iterations", "300"], s.deps), 0);
  const json = JSON.parse(s.written.get("/o/comparison.json")!);
  const byName = (n: string) => json.comparison.scores.find((x: { name: string }) => x.name === n);
  assert.equal(byName("spec_pass_rate").versusBaseline["arm=treatment"].assessment, "lift");
  assert.equal(byName("auth_overhead").versusBaseline["arm=treatment"].assessment, "lift");
  assert.equal(json.complete, true);
  assert.match(s.written.get("/o/comparison.md")!, /# Campaign c1/);
});

test("runs that are not graded are left out with a warning, and an incomplete campaign is flagged in the report", async () => {
  const s = service([...rows(), { id: "late", arm: "treatment", replicate: 4, evaluationStatus: "pending", pass: 0, auth: 0 }], false);
  await runCompare(["--campaign", "c1", "--out", "/o", "--iterations", "50"], s.deps);
  assert.ok(s.out.some((l) => l.includes("1 run(s) are not graded yet") && l.includes("late")));
  assert.equal(s.gets.some((g) => g.includes("/late/")), false);
  assert.match(s.written.get("/o/comparison.md")!, /not complete/);
});

test("a campaign the service holds no run for, an unknown baseline and a failing API are each reported, not thrown", async () => {
  const empty = service([]);
  assert.equal(await runCompare(["--campaign", "c1"], empty.deps), 1);
  assert.match(empty.out.join("\n"), /no run for campaign/);
  const s = service(rows());
  assert.equal(await runCompare(["--campaign", "c1", "--baseline", "variant.arm=ghost"], s.deps), 1);
  assert.match(s.out.join("\n"), /no arm carries/);
  const broken: CompareDeps = { ...s.deps, get: async () => { throw new Error("GET x answered HTTP 500"); } };
  assert.equal(await runCompare(["--campaign", "c1"], broken), 1);
});

test("without --out the markdown and the JSON go to the output", async () => {
  const s = service(rows());
  assert.equal(await runCompare(["--campaign", "c1", "--iterations", "50"], s.deps), 0);
  assert.ok(s.out.some((l) => l.startsWith("# Campaign c1")));
  assert.ok(s.out.some((l) => l.includes('"runsCompared": 6')));
});
