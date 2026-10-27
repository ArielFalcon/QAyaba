/* The pages a run observed: for each case that ran, the requests its page depended on and the accessible tree it ended on, read back from the files the seed's capture left in the failure-capture directory when the caller asked (`observe`). The directory is the child's, so it is read strictly and all or nothing, and everything that leaves it is re-derived and redacted: a query never leaves, a secret is taken out. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runE2E, type E2eExecuteDeps } from "@contexts/test-execution/infrastructure/e2e-execution.runner.ts";
import { MAX_OBSERVED_LINE_CHARS, MAX_OBSERVED_REQUESTS } from "@contexts/objective-signal/domain/observed-page.ts";

const REPORT = {
  suites: [
    {
      title: "map.spec.ts",
      specs: [
        { title: "applies the theme", ok: true, tests: [{ status: "expected", results: [{ status: "passed" }] }] },
        { title: "keeps the zoom", ok: true, tests: [{ status: "expected", results: [{ status: "passed" }] }] },
      ],
    },
  ],
  stats: { expected: 2 },
};

const TREE = '- main:\n  - heading "Map" [level=1]\n  - button "Dark theme" [checked]\n  - link "Help":\n    - /url: /help\n';

function observation(title: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ project: "desktop", file: "map.spec.ts", title, retry: 0, requests: [{ method: "GET", url: "https://api.maps.example/styles/v1/acme/dark", count: 2 }], yaml: TREE, ...extra });
}

interface Setup { deps: E2eExecuteDeps; seen: { observe?: boolean | undefined }; cleanup(): void }

function withObservations(files: Record<string, string>): Setup {
  const root = mkdtempSync(join(tmpdir(), "qa-observed-"));
  const dumps = join(root, "dumps");
  mkdirSync(dumps);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dumps, name), text);
  const seen: Setup["seen"] = {};
  return {
    seen,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    deps: {
      allocateFailureDir: () => ({ dir: dumps, root, dispose: () => {} }),
      runSuite: async (args) => {
        seen.observe = args.observe;
        return { report: REPORT, logs: "ok", ran: true };
      },
    },
  };
}

const OPTS = { baseUrl: "https://dev", namespace: "ns", observe: true } as const;

test("runE2E hands the observation request to the runner and reports, per case that ran, its requests and the lines of its accessible tree", async () => {
  const setup = withObservations({ "observed-w0-a-r0.json": observation("applies the theme"), "observed-w0-b-r0.json": observation("keeps the zoom", { requests: [], yaml: '- main:\n  - heading "Zoom"\n' }) });
  try {
    const run = await runE2E("/dir", OPTS, setup.deps);
    assert.equal(setup.seen.observe, true);
    assert.deepEqual(run.observations, [
      { name: "map.spec.ts › applies the theme", requests: [{ method: "GET", url: "https://api.maps.example/styles/v1/acme/dark", count: 2 }], dom: ["main: (present)", "heading: Map", "button: Dark theme [checked]", "link: Help"] },
      { name: "map.spec.ts › keeps the zoom", requests: [], dom: ["main: (present)", "heading: Zoom"] },
    ]);
  } finally {
    setup.cleanup();
  }
});

test("a request is kept as method and origin + pathname whatever the file says: a query, a fragment or credentials never leave, and a secret is taken out", async () => {
  const token = `ghp_${"a1B2".repeat(9)}`;
  const setup = withObservations({
    "observed-w0-a-r0.json": observation("applies the theme", {
      requests: [{ method: "GET", url: `https://user:pw@api.maps.example/styles/v1/acme/dark?access_token=${token}#frag`, count: 1 }],
      yaml: `- main:\n  - heading "Key ${token}"\n`,
    }),
  });
  try {
    const run = await runE2E("/dir", OPTS, setup.deps);
    const page = run.observations?.[0];
    assert.deepEqual(page?.requests, [{ method: "GET", url: "https://api.maps.example/styles/v1/acme/dark", count: 1 }]);
    assert.doesNotMatch(JSON.stringify(run.observations), new RegExp(`${token}|access_token|frag|user:pw`));
  } finally {
    setup.cleanup();
  }
});

test("what a page reports is bounded: the requests past the cap are left out and a long line is cut", async () => {
  const requests = Array.from({ length: MAX_OBSERVED_REQUESTS + 20 }, (_, i) => ({ method: "GET", url: `https://dev.example.com/api/item/${i}`, count: 1 }));
  const setup = withObservations({ "observed-w0-a-r0.json": observation("applies the theme", { requests, yaml: `- main:\n  - heading "${"x".repeat(MAX_OBSERVED_LINE_CHARS * 3)}"\n` }) });
  try {
    const run = await runE2E("/dir", OPTS, setup.deps);
    assert.equal(run.observations?.[0]?.requests.length, MAX_OBSERVED_REQUESTS);
    assert.ok((run.observations?.[0]?.dom[1]?.length ?? 0) <= MAX_OBSERVED_LINE_CHARS + 1);
  } finally {
    setup.cleanup();
  }
});

test("a file that cannot be used leaves the observations unknown, not a part of them: the run's cases are unaffected", async () => {
  const bad: Array<Record<string, string>> = [
    { "observed-w0-a-r0.json": observation("applies the theme"), "observed-w0-b-r0.json": "not json" },
    { "observed-w0-a-r0.json": observation("applies the theme", { requests: [{ method: "GET", url: "file:///etc/passwd", count: 1 }] }) },
    { "observed-w0-a-r0.json": observation("applies the theme", { requests: [{ method: "get it", url: "https://dev.example.com/x", count: 1 }] }) },
    { "observed-w0-a-r0.json": observation("applies the theme", { requests: "all of them" }) },
  ];
  for (const files of bad) {
    const setup = withObservations(files);
    try {
      const run = await runE2E("/dir", OPTS, setup.deps);
      assert.equal(run.observations, undefined);
      assert.equal(run.cases.length, 2);
    } finally {
      setup.cleanup();
    }
  }
});

test("an observation that matches no case, and a run that was not asked to observe, report nothing", async () => {
  const stray = withObservations({ "observed-w0-a-r0.json": observation("a test that never ran") });
  const idle = withObservations({ "observed-w0-a-r0.json": observation("applies the theme") });
  try {
    assert.deepEqual((await runE2E("/dir", OPTS, stray.deps)).observations, []);
    const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "ns" }, idle.deps);
    assert.equal(idle.seen.observe, undefined);
    assert.equal("observations" in run, false);
  } finally {
    stray.cleanup();
    idle.cleanup();
  }
});

test("a run that reported no result reports no observations", async () => {
  const setup = withObservations({ "observed-w0-a-r0.json": observation("applies the theme") });
  try {
    const run = await runE2E("/dir", OPTS, { ...setup.deps, runSuite: async () => ({ report: {}, logs: "crashed", ran: false }) });
    assert.equal(run.verdict, "infra-error");
    assert.equal(run.observations, undefined);
  } finally {
    setup.cleanup();
  }
});
