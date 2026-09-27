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
