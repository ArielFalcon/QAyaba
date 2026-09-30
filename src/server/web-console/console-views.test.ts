/*
 * The web console (console.js over api.js) booted in live mode against a scripted control API.
 * Assertions read what the operator sees — the rendered text of the view, the toast, the login
 * screen — and what the browser asks of the server; never the console's internal state or markup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appView, controlApi, loadConsole, runRecord, sseEvent } from "./console-harness";

test("a run queued from the console is followed to its verdict, offered in a toast, and its stream released", async () => {
  const h = await loadConsole({
    withConsole: true,
    token: "t",
    routes: controlApi({
      apps: [appView("shop")],
      runs: [],
      extra: (req) => {
        if (req.method === "POST" && req.path === "/api/v1/runs") return { status: 202, json: { id: "run-queued", status: "enqueued" } };
        if (req.path === "/api/v1/runs/run-queued/events") {
          return { status: 200, hold: true, sse: [sseEvent("run-queued", 0, { type: "run.verdict", verdict: "pass", engineStatus: "success" })] };
        }
        return undefined;
      },
    }),
  });

  h.click("trigger");
  h.click("dialog-submit");
  await h.advance(5_000);

  assert.match(h.toastText(), /finished/);
  assert.match(h.toastText(), /view run/);
  const streams = h.requestsTo("/api/v1/runs/run-queued/events");
  assert.ok(streams.length > 0, "the queued run is followed live");
  assert.ok(streams.every((s) => s.released), "no connection to the finished run stays open");
});

/* A finished run's post-run report and agent turns (read lazily when the run is opened). */
function runExtrasRoutes(runId: string) {
  return (req: { path: string }) => {
    if (req.path === `/api/v1/runs/${runId}/report`) {
      const insight = { id: "i1", title: "Pass rate held", intent: "single-value", chart: "gauge", value: 0.9, unit: "ratio", delta: null, multiplier: null, direction: "flat", goodWhen: "up", score: 0.8 };
      const report = { app: "shop", generatedAt: new Date().toISOString(), window: { current: 5, previous: 0 }, headline: "h", insights: [insight] };
      return { status: 200, json: { current: report, evolution: null } };
    }
    if (req.path === `/api/v1/runs/${runId}/turns`) {
      return { status: 200, json: [{ runId, sessionId: "s", role: "qa-generator", round: 0, isRepair: false, ts: new Date().toISOString(), objective: null, promptText: "p", outputText: "wrote the login spec", promptBytes: 1, tokensInput: 10, tokensOutput: 5 }] };
    }
    return undefined;
  };
}

test("a finished run's report and agent turns render while another run is live", async () => {
  const h = await loadConsole({
    withConsole: true,
    token: "t",
    routes: controlApi({
      apps: [appView("shop")],
      runs: [runRecord("run-live", { status: "running", verdict: undefined, step: "generate" }), runRecord("run-done")],
      running: { id: "run-live", app: "shop" },
      extra: runExtrasRoutes("run-done"),
    }),
  });

  h.click("open-run", "run-done");
  await h.advance(1_000);

  assert.match(h.text(), /What this run means/);
  assert.match(h.text(), /Pass rate held/);
  assert.match(h.text(), /What the agents did/);
});

function turnsRoute(runId: string, turns: unknown[]) {
  return (req: { path: string }) => (req.path === `/api/v1/runs/${runId}/turns` ? { status: 200, json: turns } : undefined);
}

const baseTurn = { runId: "run-done", sessionId: "s", role: "qa-generator", round: 0, isRepair: false, ts: new Date().toISOString(), objective: null, promptText: "p", outputText: "wrote the login spec", promptBytes: 1, tokensInput: 10, tokensOutput: 5 };

test("an agent turn shows its efficiency measurements, including when it hit the step limit", async () => {
  const h = await loadConsole({
    withConsole: true,
    token: "t",
    routes: controlApi({
      apps: [appView("shop")],
      runs: [runRecord("run-done")],
      extra: turnsRoute("run-done", [{
        ...baseTurn, totalCalls: 31, stepsUsed: 50, maxSteps: 50, callsBeforeFirstWrite: 27, writeCount: 2,
        redundantReadCount: 6, duplicateCallCount: 4, promptProvidedReadCount: 3, exhausted: true, callBuckets: { code_read: 20 },
      }]),
    }),
  });

  h.click("open-run", "run-done");
  await h.advance(1_000);

  assert.match(h.text(), /calls 31/);
  assert.match(h.text(), /before 1st write 27/);
  assert.match(h.text(), /steps 50\/50/);
  assert.match(h.text(), /redundant reads 6/);
  assert.match(h.text(), /step limit hit/);
});

test("an agent turn with unmeasured efficiency shows n/a, never a zero, whether the fields are null or absent", async () => {
  const h = await loadConsole({
    withConsole: true,
    token: "t",
    routes: controlApi({
      apps: [appView("shop")],
      runs: [runRecord("run-done")],
      extra: turnsRoute("run-done", [
        { ...baseTurn, totalCalls: null, stepsUsed: null, maxSteps: null, callsBeforeFirstWrite: null, writeCount: null, redundantReadCount: null, duplicateCallCount: null, promptProvidedReadCount: null, exhausted: null, callBuckets: null },
        { ...baseTurn, sessionId: "s2" },
      ]),
    }),
  });

  h.click("open-run", "run-done");
  await h.advance(1_000);

  assert.match(h.text(), /calls n\/a/);
  assert.match(h.text(), /steps n\/a/);
  assert.match(h.text(), /step limit n\/a/);
  assert.doesNotMatch(h.text(), /calls 0/);
});

test("opening the live run keeps a single stream to it when its lazy reads arrive", async () => {
  const h = await loadConsole({
    withConsole: true,
    token: "t",
    routes: controlApi({
      apps: [appView("shop")],
      runs: [runRecord("run-live", { status: "running", verdict: undefined, step: "generate" })],
      running: { id: "run-live", app: "shop" },
      extra: runExtrasRoutes("run-live"),
    }),
  });

  h.click("open-run", "run-live");
  await h.advance(1_000);

  assert.equal(h.requestsTo("/api/v1/runs/run-live/events").length, 1);
});

/* The run-detail "Re-run" continues a run by re-running its FAILED cases; the server refuses a
   run without any (409), so the console must only offer it where it can succeed. */
test("re-run is offered for a finished run with failed cases, and not for a run without any", async () => {
  const h = await loadConsole({
    withConsole: true,
    token: "t",
    routes: controlApi({
      apps: [appView("shop")],
      runs: [
        runRecord("run-failed", { verdict: "fail", cases: [{ name: "checkout", status: "fail", detail: "boom" }] }),
        runRecord("run-green", { verdict: "pass", cases: [{ name: "login", status: "pass" }] }),
        runRecord("run-flaky", { verdict: "flaky", cases: [{ name: "search", status: "flaky" }] }),
      ],
    }),
  });

  h.click("open-run", "run-failed");
  assert.match(h.text(), /Re-run/);
  for (const id of ["run-green", "run-flaky"]) {
    h.click("open-run", id);
    assert.doesNotMatch(h.text(), /Re-run/, `${id} has no failed case to re-run`);
  }
});

test("a refused re-run tells the operator the server's reason", async () => {
  const reason = "run run-failed is not finished yet (status: running)";
  const h = await loadConsole({
    withConsole: true,
    token: "t",
    routes: controlApi({
      apps: [appView("shop")],
      runs: [runRecord("run-failed", { verdict: "fail", cases: [{ name: "checkout", status: "fail" }] })],
      extra: (req) => (req.method === "POST" && req.path === "/api/v1/runs/run-failed/continue" ? { status: 409, json: { error: reason } } : undefined),
    }),
  });

  h.click("open-run", "run-failed");
  h.click("rerun", "run-failed");
  await h.advance(100);

  assert.ok(h.toastText().includes(reason), `toast: ${h.toastText()}`);
});

/* Report insights from each app's GET /apps/:name/report, as the contract serves them. */
function appReport(app: string, titles: string[]) {
  return {
    app, generatedAt: new Date().toISOString(), window: { current: 5, previous: 3 }, headline: `${app} report`,
    insights: titles.map((title, i) => ({
      id: `metric-${i}`, title, intent: "single-value", chart: "gauge", value: 0.5, unit: "ratio", delta: null,
      multiplier: null, direction: "flat", goodWhen: "up", score: 0.9 - i / 10,
    })),
  };
}

/* The rendered report blocks, one text chunk per ranked insight ("#1 …", "#2 …"). */
function reportBlocks(text: string): string[] {
  return text.split(/(?=#\d+ )/).slice(1);
}

test("live report insights from every app are shown, each attributed to its app", async () => {
  const h = await loadConsole({
    withConsole: true,
    token: "t",
    routes: controlApi({
      apps: [appView("shop"), appView("blog")],
      runs: [],
      extra: (req) => {
        if (req.path === "/api/v1/apps/shop/report") return { status: 200, json: appReport("shop", ["Checkout coverage fell"]) };
        if (req.path === "/api/v1/apps/blog/report") return { status: 200, json: appReport("blog", ["Comment flow is flaky"]) };
        return undefined;
      },
    }),
  });

  h.click("nav", "reports");
  const blocks = reportBlocks(h.text());

  const shop = blocks.find((b) => b.includes("Checkout coverage fell"));
  const blog = blocks.find((b) => b.includes("Comment flow is flaky"));
  assert.ok(shop && /\bshop\b/.test(shop), `shop's insight names its app: ${shop}`);
  assert.ok(blog && /\bblog\b/.test(blog), `blog's insight names its app: ${blog}`);
});

test("live views never claim to show mock data", async () => {
  const h = await loadConsole({ withConsole: true, token: "t", routes: controlApi({ apps: [appView("shop")], runs: [] }) });

  for (const section of ["overview", "runs", "integrity", "learning", "reports"]) {
    h.click("nav", section);
    assert.doesNotMatch(h.text(), /mock data/i, `${section} is live data`);
  }
});

test("an infra-error run with no specs is never called a valid no-op, and its note is what the operator reads", async () => {
  const note = "Step budget exhausted with no spec reported (steps 30/30; writes 0).";
  const h = await loadConsole({
    withConsole: true,
    token: "t",
    routes: controlApi({ apps: [appView("shop")], runs: [runRecord("run-exhausted", { verdict: "infra-error", note })] }),
  });
  h.click("open-run", "run-exhausted");
  await h.advance(1_000);
  assert.match(h.text(), /Step budget exhausted/);
  assert.doesNotMatch(h.text(), /valid no-op/i);
});

test("a skipped run with no specs is still shown as a valid no-op", async () => {
  const h = await loadConsole({
    withConsole: true,
    token: "t",
    routes: controlApi({ apps: [appView("shop")], runs: [runRecord("run-skipped", { verdict: "skipped", note: "nothing to test" })] }),
  });
  h.click("open-run", "run-skipped");
  await h.advance(1_000);
  assert.match(h.text(), /valid no-op/i);
});

test("the integrity view does not blame DEV for every infra-error", async () => {
  const h = await loadConsole({ withConsole: true, token: "t", routes: controlApi({ apps: [appView("shop")], runs: [] }) });
  h.click("nav", "integrity");
  assert.doesNotMatch(h.text(), /DEV down/i);
});

test("the mock console flags its demo data as mock", async () => {
  const h = await loadConsole({ withConsole: true, mode: "mock", routes: controlApi({ apps: [], runs: [] }) });

  h.click("nav", "integrity");
  assert.match(h.text(), /mock data/i);
});

test("a session that expires while the console is open brings up the login prompt", async () => {
  const h = await loadConsole({
    withConsole: true,
    token: "expired",
    routes: controlApi({
      apps: [appView("shop")],
      runs: [runRecord("run-live", { status: "running", verdict: undefined, step: "generate" })],
      running: { id: "run-live", app: "shop" },
      extra: (req) => (req.path === "/api/v1/runs/run-live/events" ? { status: 401, json: { error: "unauthorized" } } : undefined),
    }),
  });
  assert.equal(h.loginVisible(), false, "the console booted normally");

  h.click("open-run", "run-live");
  await h.advance(1_000);

  assert.equal(h.loginVisible(), true);
});

test("a stale stored token at boot brings up the login prompt instead of an error screen", async () => {
  const h = await loadConsole({
    withConsole: true,
    token: "stale",
    routes: (req) => (req.path === "/api/v1/apps" ? { status: 401, json: { error: "unauthorized" } } : controlApi({ apps: [], runs: [] })(req)),
  });
  await h.advance(1_000);

  assert.equal(h.requestsTo("/api/v1/auth/local").length, 1, "the loopback auto-login is tried before the prompt");
  assert.equal(h.loginVisible(), true);
  assert.doesNotMatch(h.text(), /Could not load the console/);
});

/* Every "Xm YYs" duration the view shows, in minutes. */
function minutesShown(text: string): number[] {
  return [...text.matchAll(/\b(\d+)m (\d{2})s\b/g)].map((m) => Number(m[1]) + Number(m[2]) / 60);
}

test("the live run's elapsed time counts from the run's start, not from its current step", async () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
  const fiveSecondsAgo = new Date(Date.now() - 5_000).toISOString();
  const h = await loadConsole({
    withConsole: true,
    token: "t",
    routes: controlApi({
      apps: [appView("shop")],
      runs: [runRecord("run-live", { status: "running", verdict: undefined, step: "execute", at: twoHoursAgo, stepStartedAt: fiveSecondsAgo })],
      running: { id: "run-live", app: "shop" },
    }),
  });

  const hero = minutesShown(h.text());
  assert.ok(hero.length > 0 && hero.every((m) => m >= 119), `overview timer: ${hero}`);
  h.click("open-run", "run-live");
  const detail = minutesShown(h.text());
  assert.ok(detail.length > 0 && detail.every((m) => m >= 119), `live detail: ${detail}`);
});

/* SignalsView carries current-window values only — there is no previous window to compare to. */
const currentWindowSignals = {
  valueOracle: { measured: true, avgScore: 0.8, measuredRuns: 4, totalRuns: 6 },
  reviewer: { passRate: 0.75, runs: 4 },
  coverage: { measured: false, avgRatio: null, measuredRuns: 0, totalRuns: 6 },
};

test("fleet KPIs show no period-over-period change when the API has no previous window", async () => {
  const h = await loadConsole({
    withConsole: true,
    token: "t",
    routes: controlApi({
      apps: [appView("shop")],
      runs: [],
      extra: (req) => (req.path === "/api/v1/signals" ? { status: 200, json: currentWindowSignals } : undefined),
    }),
  });

  const text = h.text();
  assert.match(text, /75%/, "the current reviewer pass-rate is shown");
  assert.doesNotMatch(text, /[+-]\d+ pts/, "no pass-rate change against a window that does not exist");
  assert.doesNotMatch(text, /×\d/, "no value-oracle multiplier against a missing baseline");
  assert.doesNotMatch(text, /\+0\b/, "no zero change fabricated from the current value");
});

test("the mock console still shows its period-over-period changes", async () => {
  const h = await loadConsole({ withConsole: true, mode: "mock", routes: controlApi({ apps: [], runs: [] }) });
  assert.match(h.text(), /[+-]\d+ pts/);
});

test("the engine is reported operational only when its health check says so", async () => {
  const healthy = await loadConsole({
    withConsole: true,
    token: "t",
    routes: controlApi({
      apps: [appView("shop")],
      runs: [],
      extra: (req) => (req.path === "/api/v1/health" ? { status: 200, json: { ok: true, openSessions: 2 } } : undefined),
    }),
  });
  assert.match(healthy.text(), /engine operational/);

  const unknown = await loadConsole({
    withConsole: true,
    token: "t",
    routes: controlApi({
      apps: [appView("shop")],
      runs: [],
      extra: (req) => (req.path === "/api/v1/health" ? { status: 503, json: { error: "down" } } : undefined),
    }),
  });
  assert.doesNotMatch(unknown.text(), /engine operational/);
});

test("the learning view says an app's stored curriculum is corrupt, and only for that app", async () => {
  const intelligence = (app: string, curriculumCorrupt: boolean) => ({ app, rules: [], scorecard: null, curriculum: null, curriculumCorrupt });
  const h = await loadConsole({
    withConsole: true,
    token: "t",
    routes: controlApi({
      apps: [appView("shop"), appView("blog")],
      runs: [],
      extra: (req) => {
        if (req.path === "/api/v1/apps/shop/intelligence") return { status: 200, json: intelligence("shop", true) };
        if (req.path === "/api/v1/apps/blog/intelligence") return { status: 200, json: intelligence("blog", false) };
        return undefined;
      },
    }),
  });

  h.click("nav", "learning");
  const text = h.text();

  const mentions = [...text.matchAll(/[^.]*corrupt[^.]*/gi)].map((m) => m[0]);
  assert.ok(mentions.some((m) => /\bshop\b/.test(m)), `shop's corrupt curriculum is reported: ${mentions}`);
  assert.ok(mentions.every((m) => !/\bblog\b/.test(m)), `blog has no curriculum yet, not a corrupt one: ${mentions}`);
});
