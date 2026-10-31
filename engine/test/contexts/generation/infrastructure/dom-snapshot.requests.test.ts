/* The requests a captured page made reach its snapshot as the kernel ledger keeps them: method + origin + pathname with a count, within the same bounds as the authenticated browser's log, with the run's secrets taken out where the capture's output enters. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCaptureDomDeps, captureDomForRoutes, type CapturedPage } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import type { RouteSnapshot } from "@contexts/generation/domain/route-snapshot.ts";
import { MAX_LOGGED_PATH_CHARS, MAX_LOGGED_REQUESTS } from "@kernel/observed-requests.ts";
import { REDACTED } from "@kernel/ports/redaction.port.ts";
import { createRunSecretScope, withRunSecretScope } from "../../../../src/shared-kernel/run-secret-redaction.ts";
import { sharedTestExec } from "../../../support/exec-sandbox-harness.ts";

const SECRET = "hunter2-account-password";

/* What the capture script printed for one route, read back as the orchestrator reads it. */
async function readBack(lines: unknown[], inRun?: () => ReturnType<typeof createRunSecretScope>): Promise<RouteSnapshot[]> {
  const exec = sharedTestExec();
  const script = exec.writeScript("echo-capture.cjs", `process.stdout.write(${JSON.stringify(lines.map((line) => JSON.stringify(line)).join("\n"))});`);
  const wrapped = { ...exec, writeScript: () => script, spawn: (_cmd: string, _args: readonly string[], o: Parameters<typeof exec.spawn>[2]) => exec.spawn(process.execPath, [script], o) };
  const render = (): Promise<RouteSnapshot[]> => createCaptureDomDeps(wrapped).render(process.cwd(), "http://dev.example", ["/"]);
  return inRun ? withRunSecretScope(inRun(), render) : render();
}

test("a route's requests are read back as method, origin and path with a count, whatever query or fragment the script reported", async () => {
  const [snap] = await readBack([{ route: "/", yaml: "", requests: [{ method: "get", url: "https://maps.example/styles/v1/owner/id?access=x#top", count: 2 }, { method: "POST", url: "http://dev.example/api/orders", count: 1, failed: true }] }]);
  assert.deepEqual(snap?.requests, {
    listed: [{ method: "GET", url: "https://maps.example/styles/v1/owner/id", count: 2 }, { method: "POST", url: "http://dev.example/api/orders", count: 1, blocked: true }],
    omitted: 0,
  });
});

test("an entry that is no request of the network is not read back", async () => {
  const [snap] = await readBack([{ route: "/", yaml: "", requests: [{ method: "GET", url: "data:text/plain,hi", count: 1 }, { method: "not a method", url: "http://dev.example/a", count: 1 }, { method: "GET", url: "http://dev.example/b", count: 0 }, { method: "GET", url: 7, count: 1 }, { method: "GET", url: "http://dev.example/ok", count: 3 }] }]);
  assert.deepEqual(snap?.requests?.listed, [{ method: "GET", url: "http://dev.example/ok", count: 3 }]);
});

test("a route that reported no request has none", async () => {
  const [snap] = await readBack([{ route: "/", yaml: "" }]);
  assert.equal(snap?.requests, undefined);
});

test("a page that asked for more distinct requests than the bound is held to it and the rest is counted as omitted", async () => {
  const requests = Array.from({ length: MAX_LOGGED_REQUESTS + 5 }, (_, i) => ({ method: "GET", url: `http://dev.example/api/r${i}`, count: 1 }));
  const [snap] = await readBack([{ route: "/", yaml: "", requests, requestsOmitted: 7 }]);
  assert.equal(snap?.requests?.listed.length, MAX_LOGGED_REQUESTS);
  assert.equal(snap?.requests?.omitted, 5 + 7);
});

test("an address longer than the bound is cut and says so", async () => {
  const [snap] = await readBack([{ route: "/", yaml: "", requests: [{ method: "GET", url: `http://dev.example/${"x".repeat(MAX_LOGGED_PATH_CHARS * 2)}`, count: 1 }] }]);
  const url = snap?.requests?.listed[0]?.url ?? "";
  assert.ok(url.length < MAX_LOGGED_PATH_CHARS + 20);
  assert.ok(url.endsWith("[cut]"));
});

test("a run's secret in a request's path is taken out where the capture's output enters", async () => {
  const scope = createRunSecretScope();
  scope.addAccountSecrets([SECRET]);
  const [snap] = await readBack([{ route: "/", yaml: "", requests: [{ method: "GET", url: `http://dev.example/session/${SECRET}/refresh`, count: 1 }] }], () => scope);
  assert.equal(JSON.stringify(snap).includes(SECRET), false);
  assert.ok(JSON.stringify(snap?.requests).includes(REDACTED));
});

test("the pages a capture reports to its caller carry the requests their snapshots hold", async () => {
  const snap: RouteSnapshot = { route: "/map", nodes: ["heading: Map"], requests: { listed: [{ method: "GET", url: "https://maps.example/styles/v1/o/id", count: 1 }], omitted: 0 } };
  const reported: CapturedPage[] = [];
  await captureDomForRoutes(["/map"], { e2eDir: "/e2e", baseUrl: "http://dev.example", onPages: (pages) => reported.push(...pages) }, { render: async () => [snap] });
  assert.deepEqual(reported[0]?.requests, snap.requests);
});

test("a page whose snapshot holds no request reports none", async () => {
  const reported: CapturedPage[] = [];
  await captureDomForRoutes(["/map"], { e2eDir: "/e2e", baseUrl: "http://dev.example", onPages: (pages) => reported.push(...pages) }, { render: async () => [{ route: "/map", nodes: ["heading: Map"] }] });
  assert.equal(reported[0]?.requests, undefined);
});
