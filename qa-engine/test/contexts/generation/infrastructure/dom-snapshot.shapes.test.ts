/* The response shapes a captured page reports reach its snapshot as names and counts only, within bounds, with the run's secrets taken out where the capture's output enters. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCaptureDomDeps, captureDomForRoutes, MAX_SHAPE_KEYS, MAX_SHAPE_KEY_CHARS, MAX_SHAPES_PER_ROUTE, type CapturedPage } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import type { RouteSnapshot } from "@contexts/generation/domain/route-snapshot.ts";
import { MAX_LOGGED_PATH_CHARS } from "@kernel/observed-requests.ts";
import { REDACTED } from "@kernel/ports/redaction.port.ts";
import { createRunSecretScope, withRunSecretScope } from "../../../../src/shared-kernel/run-secret-redaction.ts";
import { sharedTestExec } from "../../../support/exec-sandbox-harness.ts";

const SECRET = "hunter2-account-password";
const ITEMS = "http://dev.example/api/items";

async function readBack(lines: unknown[], inRun?: () => ReturnType<typeof createRunSecretScope>): Promise<RouteSnapshot[]> {
  const exec = sharedTestExec();
  const script = exec.writeScript("echo-capture.cjs", `process.stdout.write(${JSON.stringify(lines.map((line) => JSON.stringify(line)).join("\n"))});`);
  const wrapped = { ...exec, writeScript: () => script, spawn: (_cmd: string, _args: readonly string[], o: Parameters<typeof exec.spawn>[2]) => exec.spawn(process.execPath, [script], o) };
  const render = (): Promise<RouteSnapshot[]> => createCaptureDomDeps(wrapped).render(process.cwd(), "http://dev.example", ["/"]);
  return inRun ? withRunSecretScope(inRun(), render) : render();
}

const reported = (shapes: unknown, extra: Record<string, unknown> = {}) => [{ route: "/", yaml: "", shapes, ...extra }];

test("a route's shapes are read back as operation, item count and sorted key names, whatever query the script reported", async () => {
  const [snap] = await readBack(reported([{ method: "get", url: `${ITEMS}?lat=1#top`, items: 3, keys: ["name", "id", "name"], complete: true }]));
  assert.deepEqual(snap?.shapes, { listed: [{ method: "GET", url: ITEMS, items: 3, keys: ["id", "name"], complete: true }], omitted: 0 });
});

test("an entry that is no shape of a network answer is not read back", async () => {
  const [snap] = await readBack(reported([
    { method: "GET", url: "data:text/plain,hi", items: 1, keys: ["a"], complete: true },
    { method: "not a method", url: ITEMS, items: 1, keys: ["a"], complete: true },
    { method: "GET", url: `${ITEMS}/neg`, items: -1, keys: ["a"], complete: true },
    { method: "GET", url: `${ITEMS}/frac`, items: 1.5, keys: ["a"], complete: true },
    { method: "GET", url: `${ITEMS}/keys`, items: 1, keys: "a", complete: true },
    { method: "GET", url: `${ITEMS}/ok`, items: 2, keys: ["a"], complete: true },
  ]));
  assert.deepEqual(snap?.shapes?.listed.map((s) => s.url), [`${ITEMS}/ok`]);
});

test("a key that is no name of a field is dropped and the keys are then not all of them", async () => {
  const [snap] = await readBack(reported([{ method: "GET", url: ITEMS, items: 1, keys: ["id", "two words", "line\nbreak", "", 7, "category"], complete: true }]));
  assert.deepEqual(snap?.shapes?.listed[0]?.keys, ["category", "id"]);
  assert.equal(snap?.shapes?.listed[0]?.complete, false);
});

test("a shape the script said was incomplete stays incomplete", async () => {
  const [snap] = await readBack(reported([{ method: "GET", url: ITEMS, items: 9, keys: ["id"], complete: false }]));
  assert.equal(snap?.shapes?.listed[0]?.complete, false);
});

test("more keys than the bound are cut to it and the keys are then not all of them; a key longer than the bound is dropped", async () => {
  const keys = Array.from({ length: MAX_SHAPE_KEYS + 4 }, (_, i) => `k${String(i).padStart(4, "0")}`);
  const [snap] = await readBack(reported([{ method: "GET", url: ITEMS, items: 1, keys: [...keys, "x".repeat(MAX_SHAPE_KEY_CHARS + 1)], complete: true }]));
  assert.equal(snap?.shapes?.listed[0]?.keys.length, MAX_SHAPE_KEYS);
  assert.equal(snap?.shapes?.listed[0]?.complete, false);
});

test("more operations than the bound are cut to it and the rest, with what the script left out, is counted", async () => {
  const shapes = Array.from({ length: MAX_SHAPES_PER_ROUTE + 5 }, (_, i) => ({ method: "GET", url: `${ITEMS}/r${i}`, items: 1, keys: ["id"], complete: true }));
  const [snap] = await readBack(reported(shapes, { shapesOmitted: 7 }));
  assert.equal(snap?.shapes?.listed.length, MAX_SHAPES_PER_ROUTE);
  assert.equal(snap?.shapes?.omitted, 5 + 7);
});

test("an address longer than the bound is cut and says so", async () => {
  const [snap] = await readBack(reported([{ method: "GET", url: `${ITEMS}/${"x".repeat(MAX_LOGGED_PATH_CHARS * 2)}`, items: 1, keys: ["id"], complete: true }]));
  const url = snap?.shapes?.listed[0]?.url ?? "";
  assert.ok(url.length < MAX_LOGGED_PATH_CHARS + 20);
  assert.ok(url.endsWith("[cut]"));
});

test("a run's secret in an address or a key is taken out where the capture's output enters", async () => {
  const scope = createRunSecretScope();
  scope.addAccountSecrets([SECRET]);
  const [snap] = await readBack(reported([{ method: "GET", url: `${ITEMS}/${SECRET}/list`, items: 1, keys: [`k${SECRET}`], complete: true }]), () => scope);
  assert.equal(JSON.stringify(snap).includes(SECRET), false);
  assert.ok(JSON.stringify(snap?.shapes).includes(REDACTED));
});

test("a route that reported no shape has none", async () => {
  const [snap] = await readBack([{ route: "/", yaml: "" }]);
  assert.equal(snap?.shapes, undefined);
});

test("the pages a capture reports to its caller carry the shapes their snapshots hold", async () => {
  const snap: RouteSnapshot = { route: "/browse", nodes: ["heading: Browse"], shapes: { listed: [{ method: "GET", url: ITEMS, items: 2, keys: ["id"], complete: true }], omitted: 0 } };
  const pages: CapturedPage[] = [];
  await captureDomForRoutes(["/browse"], { e2eDir: "/e2e", baseUrl: "http://dev.example", onPages: (p) => pages.push(...p) }, { render: async () => [snap] });
  assert.deepEqual(pages[0]?.shapes, snap.shapes);
});
