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
