/* A name a page shows more than once is only usable in a locator scoped to what tells its occurrences apart: the capture reports that, per occurrence, and the pack shows it on the node line. */
import { sharedTestExec } from "../../../support/exec-sandbox-harness.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCaptureDomDeps, formatDomSnapshot } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import { type RouteSnapshot } from "@contexts/generation/domain/route-snapshot.ts";

interface FakeEl { tag: string; attrs?: Record<string, string>; role?: string; name?: string; children?: FakeEl[] }

/* A stand-in `playwright` whose page is the given element tree: its aria snapshot lists the named elements, and getByRole matches them by role and name the way Playwright does. Elements carry no computedRole/computedName, as in the browser the capture runs. */
function withFakePage<T>(tree: FakeEl[], body: (e2eDir: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "fake-page-"));
  const module = join(root, "node_modules", "playwright");
  mkdirSync(module, { recursive: true });
  writeFileSync(join(module, "index.js"), `
const tree = ${JSON.stringify(tree)};
const body = { tagName: "BODY", parentElement: null, getAttribute: () => null };
const all = [];
function build(spec, parent) {
  const attrs = spec.attrs || {};
  const el = { tagName: spec.tag.toUpperCase(), parentElement: parent, id: attrs.id || "", getAttribute: (n) => (n in attrs ? attrs[n] : null), role: spec.role, name: spec.name, href: attrs.href || "" };
  all.push(el);
  (spec.children || []).forEach((c) => build(c, el));
}
tree.forEach((t) => build(t, body));
const yaml = all.filter((e) => e.role).map((e) => "- " + e.role + " " + JSON.stringify(e.name)).join("\\n");
const withDocument = () => { globalThis.document = { body, querySelectorAll: () => all, getElementById: () => null }; };
let current = "";
const page = {
  on() {},
  goto: async (url) => { current = url; },
  waitForLoadState: async () => {},
  url: () => current,
  locator: () => ({ ariaSnapshot: async () => yaml }),
  getByRole: (role, opts) => ({
    evaluateAll: async (fn, arg) => { withDocument(); return fn(all.filter((e) => e.role === role && opts.name.test(e.name)), arg); },
  }),
  evaluate: async (fn, arg) => { withDocument(); return fn(arg); },
};
exports.chromium = { launch: async () => ({ newContext: async () => ({ newPage: async () => page }), close: async () => {} }) };
`);
  return body(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

const LIST_PAGE: FakeEl[] = [{
  tag: "app-restaurant-list",
  children: [
    { tag: "div", children: [{ tag: "button", role: "button", name: "Cambiar filtros" }] },
    { tag: "nm-infinite-scroll", children: [{ tag: "p-button", children: [{ tag: "button", role: "button", name: " Cambiar filtros" }] }] },
    { tag: "button", role: "button", name: "Ordenar" },
  ],
}];

test("a capture reports, for each occurrence of a name the page repeats, the containers only that occurrence is in", { timeout: 30_000 }, async () => {
  await withFakePage(LIST_PAGE, async (e2eDir) => {
    const [snap] = await createCaptureDomDeps(sharedTestExec()).render(e2eDir, "http://dev.example", ["/restaurantes/madrid"]);
    assert.deepEqual(snap?.repeated, [
      { group: "button|cambiar filtros", of: 2, scope: [] },
      { group: "button|cambiar filtros", of: 2, scope: ["p-button", "nm-infinite-scroll"] },
    ]);
  });
});

test("a test id or an id on a container names it, before its tag", { timeout: 30_000 }, async () => {
  const page: FakeEl[] = [
    { tag: "section", attrs: { id: "filters" }, children: [{ tag: "a", role: "link", name: "Ver", attrs: { href: "/a" } }] },
    { tag: "nm-card", attrs: { "data-testid": "card-1" }, children: [{ tag: "a", role: "link", name: "Ver", attrs: { href: "/b" } }] },
  ];
  await withFakePage(page, async (e2eDir) => {
    const [snap] = await createCaptureDomDeps(sharedTestExec()).render(e2eDir, "http://dev.example", ["/"]);
    assert.deepEqual(snap?.repeated?.map((r) => r.scope), [["#filters"], ['[data-testid="card-1"]']]);
  });
});

test("a name the page shows once is not reported", { timeout: 30_000 }, async () => {
  await withFakePage([{ tag: "nm-bar", children: [{ tag: "button", role: "button", name: "Guardar" }] }], async (e2eDir) => {
    const [snap] = await createCaptureDomDeps(sharedTestExec()).render(e2eDir, "http://dev.example", ["/"]);
    assert.equal(snap?.repeated, undefined);
  });
});

const REPEATED: RouteSnapshot = {
  route: "/restaurantes/madrid",
  nodes: ["button: Cambiar filtros", "button: Ordenar", "button:  Cambiar filtros"],
  repeated: [
    { group: "button|cambiar filtros", of: 2, scope: [] },
    { group: "button|cambiar filtros", of: 2, scope: ["p-button", "nm-infinite-scroll"] },
  ],
};

test("the pack shows each occurrence of a repeated name with what tells it apart", () => {
  const lines = formatDomSnapshot([REPEATED]).split("\n").filter((l) => l.includes("Cambiar filtros"));
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /2 on this page/);
  assert.match(lines[0]!, /no container of its own/);
  assert.match(lines[1]!, /2 on this page/);
  assert.match(lines[1]!, /in p-button < nm-infinite-scroll/);
  assert.doesNotMatch(formatDomSnapshot([REPEATED]), /Ordenar.*on this page/);
});

test("a changed text of several words marks a name that carries it after an icon glyph", () => {
  const snap: RouteSnapshot = { route: "/", nodes: ["button:  Cambiar filtros", "button: Cambiar", "button: Filtros de cambiar"] };
  const lines = formatDomSnapshot([snap], [{ file: "a.html", line: 1, text: "Cambiar filtros", raw: "" }]).split("\n");
  assert.match(lines[1]!, /\[CHANGED: added text "Cambiar filtros"\]/);
  assert.doesNotMatch(lines[2]!, /CHANGED/);
  assert.doesNotMatch(lines[3]!, /CHANGED/);
});

test("a change whose containers are known marks only the occurrence inside them", () => {
  const changed = [{ file: "list.html", line: 164, text: "Cambiar filtros", scope: ["nm-infinite-scroll"], raw: 'endActionLabel="Cambiar filtros"' }];
  const lines = formatDomSnapshot([REPEATED], changed).split("\n").filter((l) => l.includes("Cambiar filtros"));
  assert.doesNotMatch(lines[0]!, /CHANGED/);
  assert.match(lines[1]!, /\[CHANGED: added text "Cambiar filtros" in nm-infinite-scroll\]/);
});

test("a change whose containers no occurrence on the page is in still marks every occurrence of its text", () => {
  const changed = [{ file: "List.tsx", line: 40, text: "Cambiar filtros", scope: ["ListFooter"], raw: 'label="Cambiar filtros"' }];
  const lines = formatDomSnapshot([REPEATED], changed).split("\n").filter((l) => l.includes("Cambiar filtros"));
  assert.ok(lines.every((l) => l.includes('[CHANGED: added text "Cambiar filtros"]')));
});

test("a change whose containers are not known still marks every occurrence of its text", () => {
  const changed = [{ file: "list.html", line: 164, text: "Cambiar filtros", raw: 'endActionLabel="Cambiar filtros"' }];
  const lines = formatDomSnapshot([REPEATED], changed).split("\n").filter((l) => l.includes("Cambiar filtros"));
  assert.ok(lines.every((l) => l.includes('[CHANGED: added text "Cambiar filtros"]')));
});

const EMPTY_LIST_PAGE: FakeEl[] = [{
  tag: "app-restaurant-list",
  children: [
    { tag: "div", children: [{ tag: "button", role: "button", name: "Cambiar filtros" }] },
    { tag: "app-restaurant-empty-state", children: [{ tag: "button", role: "button", name: "Cambiar filtros" }] },
  ],
}];

test("a capture told the change's containers reports the ones a page does not show", { timeout: 30_000 }, async () => {
  await withFakePage(EMPTY_LIST_PAGE, async (e2eDir) => {
    const [snap] = await createCaptureDomDeps(sharedTestExec()).render(e2eDir, "http://dev.example", ["/restaurantes"], undefined, ["nm-infinite-scroll", "app-restaurant-list"]);
    assert.deepEqual(snap?.absent, ["nm-infinite-scroll"]);
  });
});

test("a capture told no containers reports none absent", { timeout: 30_000 }, async () => {
  await withFakePage(EMPTY_LIST_PAGE, async (e2eDir) => {
    const [snap] = await createCaptureDomDeps(sharedTestExec()).render(e2eDir, "http://dev.example", ["/restaurantes"]);
    assert.equal(snap?.absent, undefined);
  });
});

const EMPTY_STATE: RouteSnapshot = {
  route: "/restaurantes",
  nodes: ["text: 0 resultados", "button: Cambiar filtros", "button: Cambiar filtros"],
  repeated: [
    { group: "button|cambiar filtros", of: 2, scope: [] },
    { group: "button|cambiar filtros", of: 2, scope: ["app-restaurant-empty-state"] },
  ],
  absent: ["nm-infinite-scroll"],
};
const END_ACTION_CHANGE = [{ file: "list.html", line: 164, text: "Cambiar filtros", scope: ["nm-infinite-scroll"], raw: 'endActionLabel="Cambiar filtros"' }];

test("a change whose container a page does not show marks nothing on that page", () => {
  assert.doesNotMatch(formatDomSnapshot([EMPTY_STATE], END_ACTION_CHANGE), /\[CHANGED/);
});

test("a page that does not show the change's container says so, as a fact", () => {
  const text = formatDomSnapshot([EMPTY_STATE], END_ACTION_CHANGE);
  assert.match(text, /changed text "Cambiar filtros" is in nm-infinite-scroll/);
  assert.match(text, /this page shows no nm-infinite-scroll now/);
});
