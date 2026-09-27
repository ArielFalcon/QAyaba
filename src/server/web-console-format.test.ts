import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join } from "node:path";

type Format = {
  fixed: (n: unknown, digits: number, empty?: string) => string;
  multiplierLabel: (cur: unknown, prev: unknown) => string;
  uniqueAbbrevs: (shas: string[], minLen?: number) => string[];
  shortRepo: (repo: unknown) => string;
  renderMarkdown: (md: unknown) => string;
  pickChatAnswer: (opts: {
    mode: string;
    apiAnswer?: string | null;
    apiError?: string | null;
    canned: string;
  }) => { text: string; kind: "assistant" | "error" | "canned" };
  triggerExtras: (mode: unknown) => { sha: boolean; delta: boolean; guidance: boolean };
  clampDiffCommits: (n: unknown) => number;
  triggerPayload: (input: {
    app: string;
    mode: string;
    sha?: string;
    commits?: number | string;
    guidance?: string;
  }) => Record<string, unknown>;
  nextSseRetryDelay: (current: unknown, cap?: unknown) => number;
};

function loadFormat(): Format {
  const src = readFileSync(join(process.cwd(), "web/public/js/format.js"), "utf8");
  const ctx = createContext({ window: {} as { QayabaFormat?: Format } });
  runInContext(src, ctx);
  const fmt = (ctx.window as { QayabaFormat?: Format }).QayabaFormat;
  assert.ok(fmt, "format.js must attach window.QayabaFormat");
  return fmt;
}

test("fixed never calls toFixed on null/undefined (the overview crash)", () => {
  const F = loadFormat();
  assert.equal(F.fixed(null, 2), "n/a");
  assert.equal(F.fixed(undefined, 2), "n/a");
  assert.equal(F.fixed(0.8, 2), "0.80");
});

test("multiplierLabel does not throw when baseline is 0 or missing (unmeasured oracle)", () => {
  const F = loadFormat();
  assert.equal(F.multiplierLabel(0, 0), "n/a");
  assert.equal(F.multiplierLabel(null, null), "n/a");
  assert.equal(F.multiplierLabel(0.8, 0.4), "×2.0");
});

test("uniqueAbbrevs uses git-style shortest unique prefix (min 7)", () => {
  const F = loadFormat();
  const a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  assert.deepEqual(F.uniqueAbbrevs([a, b]), ["aaaaaaa", "bbbbbbb"]);
});

test("uniqueAbbrevs grows past 7 when the first 7 chars collide", () => {
  const F = loadFormat();
  const a = "abcdef1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const b = "abcdef2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  assert.deepEqual(F.uniqueAbbrevs([a, b]), ["abcdef1", "abcdef2"]);
  const c = "abcdef12aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const d = "abcdef13bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  assert.deepEqual(F.uniqueAbbrevs([c, d]), ["abcdef12", "abcdef13"]);
});

test("uniqueAbbrevs leaves already-short SHAs unchanged", () => {
  const F = loadFormat();
  assert.deepEqual(F.uniqueAbbrevs(["aa17c93", "9f6edf2"]), ["aa17c93", "9f6edf2"]);
});

test("uniqueAbbrevs does not lengthen when the same SHA repeats (re-runs of one commit)", () => {
  const F = loadFormat();
  const sha = "8d703ca290ab68eefb7faf7a9c408d4f3cf00939";
  assert.deepEqual(F.uniqueAbbrevs([sha, sha, sha]), ["8d703ca", "8d703ca", "8d703ca"]);
});

test("shortRepo is the repository name, not owner/name", () => {
  const F = loadFormat();
  assert.equal(F.shortRepo("ArielFalcon/portfolio"), "portfolio");
  assert.equal(F.shortRepo("spring-petclinic/spring-petclinic-microservices"), "spring-petclinic-microservices");
  assert.equal(F.shortRepo("portfolio"), "portfolio");
  assert.equal(F.shortRepo("git@github.com:org/app.git"), "app");
  assert.equal(F.shortRepo(""), "");
});

test("renderMarkdown paints bold, code, lists and headings (TUI parity)", () => {
  const F = loadFormat();
  const html = F.renderMarkdown("## Why\n\nThe spec **failed** on `login.spec.ts`.\n\n- timeout\n- selector");
  assert.match(html, /<h2\b/);
  assert.match(html, /<strong>failed<\/strong>/);
  assert.match(html, /<code[^>]*>login\.spec\.ts<\/code>/);
  assert.match(html, /<li>/);
  assert.match(html, /timeout/);
});

test("renderMarkdown escapes HTML so a model cannot inject markup", () => {
  const F = loadFormat();
  const html = F.renderMarkdown('Alert <script>alert(1)</script> and **ok**');
  assert.equal(html.includes("<script>"), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<strong>ok<\/strong>/);
});

test("live chat never falls back to the canned demo line", () => {
  const F = loadFormat();
  const canned = "This run is on the execute stage — 2/3 specs green, executing the third.";
  const hit = F.pickChatAnswer({ mode: "live", apiAnswer: "## Real\n\n**pass**", canned });
  assert.equal(hit.kind, "assistant");
  assert.equal(hit.text, "## Real\n\n**pass**");
  const failed = F.pickChatAnswer({ mode: "live", apiAnswer: null, apiError: "POST /runs/x/ask → 502", canned });
  assert.equal(failed.kind, "error");
  assert.notEqual(failed.text, canned);
  const empty = F.pickChatAnswer({ mode: "live", apiAnswer: null, canned });
  assert.equal(empty.kind, "error");
  assert.notEqual(empty.text, canned);
});

test("mock chat still uses the canned demo answer", () => {
  const F = loadFormat();
  const canned = "Ask me about the current test.";
  const mock = F.pickChatAnswer({ mode: "mock", apiAnswer: null, canned });
  assert.equal(mock.kind, "canned");
  assert.equal(mock.text, canned);
});

test("triggerExtras shows SHA+delta only for diff, guidance only for manual", () => {
  const F = loadFormat();
  const extras = (mode: string) => {
    const e = F.triggerExtras(mode);
    return { sha: e.sha, delta: e.delta, guidance: e.guidance };
  };
  assert.deepEqual(extras("diff"), { sha: true, delta: true, guidance: false });
  assert.deepEqual(extras("manual"), { sha: false, delta: false, guidance: true });
  assert.deepEqual(extras("complete"), { sha: false, delta: false, guidance: false });
  assert.deepEqual(extras("exhaustive"), { sha: false, delta: false, guidance: false });
});

test("clampDiffCommits stays in the API 1–20 window", () => {
  const F = loadFormat();
  assert.equal(F.clampDiffCommits(1), 1);
  assert.equal(F.clampDiffCommits(4), 4);
  assert.equal(F.clampDiffCommits(0), 1);
  assert.equal(F.clampDiffCommits(21), 20);
  assert.equal(F.clampDiffCommits("8"), 8);
});

test("triggerPayload omits SHA/commits except in diff, and guidance except in manual", () => {
  const F = loadFormat();
  const body = (input: { app: string; mode: string; sha?: string; commits?: number; guidance?: string }) => {
    const p = F.triggerPayload(input);
    return JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
  };
  assert.deepEqual(body({ app: "portfolio", mode: "complete", sha: "8d703ca", commits: 5, guidance: "x" }), {
    app: "portfolio",
    mode: "complete",
  });
  assert.deepEqual(body({ app: "portfolio", mode: "diff", sha: "", commits: 1 }), {
    app: "portfolio",
    mode: "diff",
  });
  assert.deepEqual(body({ app: "portfolio", mode: "diff", sha: "8d703ca", commits: 4 }), {
    app: "portfolio",
    mode: "diff",
    sha: "8d703ca",
    commits: 4,
  });
  assert.deepEqual(body({ app: "portfolio", mode: "manual", guidance: "  test the contact form  " }), {
    app: "portfolio",
    mode: "manual",
    guidance: "test the contact form",
  });
});

test("nextSseRetryDelay doubles and caps (bounded exponential backoff)", () => {
  const F = loadFormat();
  assert.equal(F.nextSseRetryDelay(1000, 30000), 2000);
  assert.equal(F.nextSseRetryDelay(2000, 30000), 4000);
  assert.equal(F.nextSseRetryDelay(20000, 30000), 30000, "must not exceed the cap");
  assert.equal(F.nextSseRetryDelay(30000, 30000), 30000, "stays capped once at the ceiling");
});

test("nextSseRetryDelay falls back to sane defaults for bad input", () => {
  const F = loadFormat();
  assert.equal(F.nextSseRetryDelay(0), 2000, "a non-positive current delay resets to the 1s base");
  assert.equal(F.nextSseRetryDelay(null), 2000);
  assert.equal(F.nextSseRetryDelay(undefined), 2000);
});
