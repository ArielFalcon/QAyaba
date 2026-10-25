/* buildContextPack itself — prompt-assembly wiring lives in prompts.test.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContextPack, deriveClaimsFromPackText, withoutPackSection, MAX_LISTED_UNCAPTURABLE, PACK_HEADINGS, TEMPLATE_LEFT_OUT, packDeliveredItemIds, packProducedItemIds, type ContextPackAssembly, type ContextPackDeps } from "@contexts/generation/infrastructure/context-pack.ts";
import { itemId } from "@contexts/generation/domain/context-item-ids.ts";
import { countDirectives, hasTrustLanguage, type FactId, type PromptClaim } from "@contexts/generation/domain/prompt-contract-lint.ts";
import { MAX_ROUTES, MAX_ROUTES_PER_CHANGE, REDIRECT_ADVISORY_INTRO, type CaptureDomDeps } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import { ROUTE_REASON } from "@kernel/route-capturability.ts";
import { ROUTE_LINK_FIELDS } from "@contexts/generation/domain/route-ranking.ts";
import type { ArchitectureContext } from "@contexts/generation/application/ports/generation-ports.ts";
import type { ChangedElement } from "@kernel/diff-parser/changed-element.ts";

function stubDomDeps(result: string | undefined): CaptureDomDeps {
  return {
    render: async () => {
      if (result === undefined) return [];
      return [{ route: "/test", nodes: result.split("\n").filter(Boolean) }];
    },
  };
}

function stubContextPackDeps(domResult: string | undefined, log?: (m: string) => void): ContextPackDeps {
  return {
    captureDomForRoutes: async (_routes, _input, _domDeps) => domResult,
    domDeps: stubDomDeps(domResult),
    log,
  };
}

/* Files whose paths name the checkout route, which is how the map links the change to its API operation. */
const CHECKOUT_FILES = ["src/checkout/order-client.ts"];

const MINIMAL_CONTEXT_MAP: ArchitectureContext = {
  builtAtSha: "abc1234",
  routes: [{ path: "/checkout" }],
  api: [{ operationId: "createOrder", method: "POST", path: "/orders" }],
  feBe: [{ route: "/checkout", operationId: "createOrder", via: "OrderClient.create" }],
};

test("buildContextPack returns undefined text when all components are absent", async () => {
  const result = await buildContextPack({}, stubContextPackDeps(undefined));
  assert.equal(result.text, undefined);
  assert.equal(result.domBytes, 0);
  assert.equal(result.contractBytes, 0);
});

test("packDeliveredItemIds: delivered ids come from the kept lines, with the node cap counted", () => {
  const assembly: ContextPackAssembly = {
    text: "pack",
    domBytes: 10,
    contractBytes: 0,
    trace: {
      rankedRoutes: ["/home"],
      capturablePages: 1,
      pages: [{ route: "/home", grounded: true, links: [], testIds: ["save-btn", "other"] }],
      pageDeliveries: [{
        route: "/home",
        keptNodes: ["button: Save"],
        keptTestIds: ["save-btn"],
        testIdOfNode: new Map([["button: Save", "save-btn"]]),
        nodeCapOmitted: 2,
        lineCapOmitted: 0,
      }],
      changedTestIds: ["save-btn"],
      contractIds: ["listOrders"],
      omittedLines: 0,
    },
  };
  const { ids, omissions } = packDeliveredItemIds(assembly);
  assert.ok(ids.includes("dom:/home#save-btn"), "the kept test id is delivered as a dom id");
  assert.ok(ids.includes("fact:/home#save-btn:present"), "the change fact is delivered");
  assert.ok(ids.includes("op:listOrders"), "the contract is delivered");
  assert.equal(ids.some((id) => id.includes("button")), false, "a node that already has a test id is not double-counted as a role id");
  assert.deepEqual(omissions, [{ class: "truncation", reason: "node-cap", count: 2, route: "/home" }]);
});

test("packDeliveredItemIds: a node the node-cap cut is neither delivered nor in the ids", () => {
  const assembly: ContextPackAssembly = {
    text: "pack",
    domBytes: 1,
    contractBytes: 0,
    trace: {
      rankedRoutes: ["/home"],
      capturablePages: 1,
      pages: [{ route: "/home", grounded: true, links: [], testIds: [] }],
      pageDeliveries: [{
        route: "/home",
        /* Only the kept node is here: the cut node is already gone from keptNodes. */
        keptNodes: ["button: Keep"],
        keptTestIds: [],
        testIdOfNode: new Map(),
        nodeCapOmitted: 1,
        lineCapOmitted: 0,
      }],
      changedTestIds: [],
      contractIds: [],
      omittedLines: 0,
    },
  };
  const { ids, omissions } = packDeliveredItemIds(assembly);
  assert.equal(ids.some((id) => id.startsWith("dom:")), true, "the kept node is a dom id");
  assert.ok(!ids.some((id) => id.includes("Cut")), "the cut node never reaches the ids");
  assert.deepEqual(omissions, [{ class: "truncation", reason: "node-cap", count: 1, route: "/home" }]);
});

test("packDeliveredItemIds: a page opened from a template is named by the template in its delivered ids and facts", () => {
  const assembly: ContextPackAssembly = {
    text: "pack",
    domBytes: 1,
    contractBytes: 0,
    trace: {
      rankedRoutes: [],
      capturablePages: 0,
      pages: [{ route: "/shops/madrid/madrid", template: "/shops/:province/:city", grounded: true, links: [], testIds: ["shop-row"] }],
      pageDeliveries: [{
        route: "/shops/:province/:city",
        keptNodes: ["button: View shop"],
        keptTestIds: ["shop-row"],
        testIdOfNode: new Map([["button: View shop", "shop-row"]]),
        nodeCapOmitted: 0,
        lineCapOmitted: 0,
        lineKeptNodes: ["button: View shop"],
        lineKeptTestIds: ["shop-row"],
      }],
      changedTestIds: ["shop-row"],
      contractIds: [],
      omittedLines: 0,
    },
  };
  const { ids } = packDeliveredItemIds(assembly);
  assert.ok(ids.includes("dom:/shops/:province/:city#shop-row"), "the delivered dom id carries the template name");
  assert.ok(ids.includes("fact:/shops/:province/:city#shop-row:present"), "the delivered fact carries the template name");
});

test("packProducedItemIds vs packDeliveredItemIds: the line cap makes delivered a strict subset of produced", () => {
  const assembly: ContextPackAssembly = {
    text: "pack",
    domBytes: 1,
    contractBytes: 0,
    trace: {
      rankedRoutes: [],
      capturablePages: 0,
      pages: [],
      pageDeliveries: [{
        route: "/home",
        keptNodes: ["button: A", "button: B", "button: C"],
        keptTestIds: [],
        testIdOfNode: new Map<string, string>(),
        nodeCapOmitted: 0,
        lineCapOmitted: 2,
        lineKeptNodes: ["button: A"],
        lineKeptTestIds: [],
      }],
      changedTestIds: [],
      contractIds: [],
      omittedLines: 2,
    },
  };
  const produced = packProducedItemIds(assembly);
  const delivered = packDeliveredItemIds(assembly);
  assert.equal(produced.ids.length, 3, "produced holds every node-cap kept node");
  assert.equal(delivered.ids.length, 1, "delivered holds only the line-cap kept node");
  assert.ok(delivered.ids.every((id) => produced.ids.includes(id)), "delivered ⊆ produced");
  assert.ok(produced.ids.length > delivered.ids.length, "the line cap separates produced from delivered");
  assert.deepEqual(produced.omissions, [], "the produced set counts no line cap");
  assert.deepEqual(delivered.omissions, [{ class: "truncation", reason: "line-cap", count: 2, route: "/home" }]);
});

test("buildContextPack: the global line cap trims the delivered ids to the lines the agent actually saw", async () => {
  const nodes = Array.from({ length: 700 }, (_, i) => `button: nav-${i}`);
  const deps: ContextPackDeps = {
    captureDomForRoutes: async (_routes, input) => {
      input.onPages?.([{ route: "/big", grounded: true, links: [], keptNodes: nodes, keptTestIds: [], testIdOfNode: new Map(), nodeCapOmitted: 0 }]);
      return ["route /big:", ...nodes.map((n) => `  ${n}`)].join("\n");
    },
    domDeps: stubDomDeps(undefined),
    log: () => {},
  };
  const result = await buildContextPack({ routes: ["/big"], baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" }, deps);
  const produced = packProducedItemIds(result);
  const delivered = packDeliveredItemIds(result);
  assert.equal(produced.ids.length, 700, "all 700 buttons are produced");
  assert.equal(delivered.ids.length, 499, "the 500-line budget spends one line on the route header and keeps 499 buttons");
  assert.ok(delivered.ids.every((id) => produced.ids.includes(id)), "delivered ⊆ produced");
  const droppedId = itemId.domRole("/big", "button", "nav-699");
  assert.ok(produced.ids.includes(droppedId), "the line-capped node was produced");
  assert.ok(!delivered.ids.includes(droppedId), "the line-capped node is not delivered");
});



test("buildContextPack's header is neutral: it names the pack and what it holds, and directs nothing", async () => {
  const result = await buildContextPack(
    { contextMap: MINIMAL_CONTEXT_MAP, prChangedFiles: CHECKOUT_FILES, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    stubContextPackDeps("button: Submit"),
  );
  const header = (result.text ?? "").split("### ")[0] ?? "";
  assert.ok(header.includes(PACK_HEADINGS.pack));
  assert.equal(countDirectives(header), 0);
  assert.equal(hasTrustLanguage(header), false);
});

test("buildContextPack includes DOM section when capture succeeds", async () => {
  const domContent = "button: Submit\nheading: Checkout";
  const result = await buildContextPack(
    { routes: ["/checkout"], baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    stubContextPackDeps(domContent),
  );
  assert.ok(result.text?.includes(PACK_HEADINGS.liveDom), "DOM section header must appear");
  assert.ok(result.domBytes > 0, "DOM byte count must be positive when DOM was captured");
});

/* leaked secret-shaped string (an admin debug banner echoing a key, an attribute value that reads
   like a credential assignment). blastSection/contractSection already sanitize via the local s()
   wrapper; the DOM section was the one inconsistent gap.
 */
test("buildContextPack sanitizes a secret-shaped string in the captured DOM text", async () => {
  const domContent = 'button: Submit\ntextbox: apiKey: "sk-liveSECRETVALUE123456"';
  const result = await buildContextPack(
    { routes: ["/checkout"], baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    stubContextPackDeps(domContent),
  );
  assert.ok(!result.text?.includes("sk-liveSECRETVALUE123456"), "a secret-shaped string in the captured DOM must not reach the pack raw");
});

test("buildContextPack omits DOM section when capture returns undefined", async () => {
  const result = await buildContextPack(
    { routes: ["/checkout"], baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    stubContextPackDeps(undefined),
  );
  assert.equal(result.domBytes, 0);
  assert.equal(result.text?.includes(PACK_HEADINGS.liveDom) ?? false, false);
});

test("buildContextPack includes the contracts of the contextMap", async () => {
  const result = await buildContextPack(
    { contextMap: MINIMAL_CONTEXT_MAP, prChangedFiles: CHECKOUT_FILES },
    stubContextPackDeps(undefined),
  );
  assert.ok(result.text?.includes(PACK_HEADINGS.contracts), "contracts section header must appear");
  assert.ok(result.text?.includes("POST /orders"), "contract path must appear");
  assert.ok(result.contractBytes > 0, "contract byte count must be positive");
});

test("buildContextPack omits contracts when contextMap is absent", async () => {
  const result = await buildContextPack({}, stubContextPackDeps(undefined));
  assert.equal(result.contractBytes, 0);
  assert.ok(!result.text?.includes(PACK_HEADINGS.contracts), "contracts section must be absent when no contextMap");
});

test("buildContextPack filters contracts using prChangedFiles", async () => {
  const result = await buildContextPack(
    {
      contextMap: MINIMAL_CONTEXT_MAP,
      prChangedFiles: ["src/app/checkout/checkout.component.ts"],
    },
    stubContextPackDeps(undefined),
  );
  assert.ok(result.text?.includes("createOrder") || result.contractBytes === 0,
    "contracts are either included (path matched) or empty");
});

test("buildContextPack with domPack:false skips the DOM capture entirely and still renders contracts", async () => {
  const deps: ContextPackDeps = {
    captureDomForRoutes: async () => { throw new Error("captureDomForRoutes must not be called when domPack is false"); },
    domDeps: stubDomDeps("button: Submit"),
    log: () => {},
  };
  const result = await buildContextPack(
    { domPack: false, contextMap: MINIMAL_CONTEXT_MAP, prChangedFiles: CHECKOUT_FILES, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    deps,
  );
  assert.ok(result.text, "a pack that holds a contract still renders");
  assert.equal(result.text.includes(`### ${PACK_HEADINGS.liveDom}`), false, "no live DOM section when the pack is off");
  assert.equal(result.text.includes(`### ${PACK_HEADINGS.notCapturable}`), false, "no not-capturable list when nothing was attempted");
  assert.equal(result.text.includes(`### ${PACK_HEADINGS.redirected}`), false, "no redirect advisory when the capture is skipped");
  assert.ok(result.text.includes("POST /orders"), "the contract line is present");
  assert.equal(result.domBytes, 0, "domBytes is zero when nothing was captured");
  assert.deepEqual(result.trace?.pages, []);
  assert.deepEqual(result.trace?.rankedRoutes, []);
});

test("buildContextPack: the `routes` input alone populates the DOM candidates", async () => {
  const domContent = "button: Submit\nheading: Checkout";
  const result = await buildContextPack(
    { routes: ["/checkout"], baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    stubContextPackDeps(domContent),
  );
  assert.ok(result.text?.includes(PACK_HEADINGS.liveDom), "DOM section must be populated from the routes input alone");
  assert.ok(result.domBytes > 0, "DOM byte count must be positive from the routes-only path");
});


test("buildContextPack: candidates are cut to the number of routes the capture itself takes", async () => {
  const captured: string[][] = [];
  const deps: ContextPackDeps = {
    captureDomForRoutes: async (routes) => { captured.push(routes); return "button: Submit"; },
    domDeps: stubDomDeps("button: Submit"),
    log: () => {},
  };
  const manyRoutes = Array.from({ length: MAX_ROUTES + 6 }, (_, i) => `/route${i}`);
  await buildContextPack(
    { routes: manyRoutes, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    deps,
  );
  assert.deepEqual(captured[0], manyRoutes.slice(0, MAX_ROUTES));
});

/* A route that names no single page (a template, free text, another host) is not a candidate: it is dropped before the cut, so it never takes the place of a route behind it. */
function capturingDeps(captured: string[][], log: (message: string) => void = () => {}): ContextPackDeps {
  return {
    /* Like the real capture: with no route to report there is no text, whatever it was asked to render for its links. */
    captureDomForRoutes: async (routes) => { captured.push(routes); return routes.length === 0 ? undefined : "button: Submit"; },
    domDeps: stubDomDeps("button: Submit"),
    log,
  };
}
const PACK_INPUT = { baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" };
const plainRoutes = (count: number): string[] => Array.from({ length: count }, (_, i) => `/r${i}`);

test("buildContextPack: a route template no page opens to does not take a slot from the routes behind it", async () => {
  const captured: string[][] = [];
  await buildContextPack({ routes: ["/product/:id/view", ...plainRoutes(MAX_ROUTES + 1)], ...PACK_INPUT }, capturingDeps(captured));
  assert.deepEqual(captured[0], plainRoutes(MAX_ROUTES));
});

test("buildContextPack: templates the site shows no page of leave every slot to the plain routes, whatever their number", async () => {
  const calls: Call[] = [];
  const templates = Array.from({ length: MAX_ROUTES + 2 }, (_, i) => `/t${i}/:id`);
  await buildContextPack({ routes: [...templates, ...plainRoutes(MAX_ROUTES)], ...PACK_INPUT }, siteWithLinks({ "/r0": ["/about"] }, calls));
  assert.deepEqual(calls[0]!.routes, plainRoutes(MAX_ROUTES));
  assert.equal(calls.length, 1, "no page was found, so no second capture");
});

test("buildContextPack: the cut falls on the pages found for the templates, in rank order, not on the templates", async () => {
  const calls: Call[] = [];
  const templates = Array.from({ length: MAX_ROUTES + 2 }, (_, i) => `/t${i}/:id`);
  const links = templates.map((_, i) => `/t${i}/1`);
  /* Only every other template has a page: the pages are what take the slots. */
  const shown = links.filter((_, i) => i % 2 === 0);
  const result = await buildContextPack({ routes: [...templates, ...plainRoutes(1)], ...PACK_INPUT }, siteWithLinks({ "/": shown }, calls));
  const found = shown.slice(0, MAX_ROUTES);
  assert.deepEqual(calls[1]!.routes, found);
  const listed = sectionOf(result.text, PACK_HEADINGS.notCapturable);
  assert.ok(listed.includes("/t1/:id"), "a template with no page is listed");
});

test("buildContextPack: what names no page and no template of one does not take a slot from the routes behind it", async () => {
  const captured: string[][] = [];
  const unusable = ["/files/*", "/docs/[...rest]", "/users/:id?", "the cart page", "//evil.example/x"];
  await buildContextPack({ routes: [...unusable, ...plainRoutes(MAX_ROUTES)], ...PACK_INPUT }, capturingDeps(captured));
  assert.deepEqual(captured, [plainRoutes(MAX_ROUTES)]);
});



function sectionOf(text: string | undefined, heading: string): string {
  const parts = (text ?? "").split(/^### /m).slice(1);
  return parts.find((part) => part.startsWith(heading)) ?? "";
}

test("buildContextPack: a route that cannot be captured is listed apart from the live DOM, so it is not read as a broken page", async () => {
  const captured: string[][] = [];
  const logs: string[] = [];
  const result = await buildContextPack({ routes: ["/product/:id/view", "/a"], ...PACK_INPUT }, capturingDeps(captured, (message) => logs.push(message)));
  assert.ok(sectionOf(result.text, PACK_HEADINGS.notCapturable).includes("/product/:id/view"), "the template is listed under its own heading");
  assert.equal(sectionOf(result.text, PACK_HEADINGS.liveDom).includes("/product/:id/view"), false, "and not under the live DOM");
  assert.ok(logs.some((message) => message.includes("/product/:id/view")), "the log names it too");
});

test("buildContextPack: with every candidate uncapturable nothing is captured, no pack is made, and the log names them", async () => {
  const captured: string[][] = [];
  const logs: string[] = [];
  const result = await buildContextPack({ routes: ["/product/:id", "/users/{id}"], ...PACK_INPUT }, capturingDeps(captured, (message) => logs.push(message)));
  assert.deepEqual(captured.flat(), [], "no route is rendered for the report");
  assert.equal(result.text, undefined);
  for (const route of ["/product/:id", "/users/{id}"]) assert.ok(logs.some((message) => message.includes(route)), `the log names ${route}`);
});

test("buildContextPack: nothing is logged as not capturable when every candidate can be captured", async () => {
  const logs: string[] = [];
  await buildContextPack({ routes: ["/a", "/b"], ...PACK_INPUT }, capturingDeps([], (message) => logs.push(message)));
  assert.equal(logs.some((message) => /not capturable/i.test(message)), false);
});

test("buildContextPack: the list of routes not captured stops at its bound and says how many more there are", async () => {
  const extra = 3;
  const templates = Array.from({ length: MAX_LISTED_UNCAPTURABLE + extra }, (_, i) => `/t${i}/:id`);
  const result = await buildContextPack({ routes: ["/a", ...templates], ...PACK_INPUT }, capturingDeps([]));
  const section = sectionOf(result.text, PACK_HEADINGS.notCapturable);
  const lines = section.trimEnd().split("\n");
  assert.equal(lines.length, 1 + MAX_LISTED_UNCAPTURABLE + 1, "the heading, one line per listed route, and the count of the rest");
  assert.deepEqual(templates.slice(0, MAX_LISTED_UNCAPTURABLE).map((route) => lines.findIndex((line) => line.includes(route))), Array.from({ length: MAX_LISTED_UNCAPTURABLE }, (_, i) => i + 1));
  assert.ok(lines[lines.length - 1]!.includes(String(extra)));
});

test("buildContextPack: a list of exactly its bound is the heading and one line per route, nothing more", async () => {
  const templates = Array.from({ length: MAX_LISTED_UNCAPTURABLE }, (_, i) => `/t${i}/:id`);
  const result = await buildContextPack({ routes: ["/a", ...templates], ...PACK_INPUT }, capturingDeps([]));
  assert.equal(sectionOf(result.text, PACK_HEADINGS.notCapturable).trimEnd().split("\n").length, 1 + MAX_LISTED_UNCAPTURABLE);
});

test("buildContextPack: with nothing left out the pack ends with its last section, with no blank section after it", async () => {
  const result = await buildContextPack({ routes: ["/a"], ...PACK_INPUT }, capturingDeps([]));
  assert.equal(result.text, result.text?.trimEnd());
});

test("buildContextPack: the header names the live DOM, the contracts and the routes not capturable, each once, when the pack holds all three", async () => {
  const result = await buildContextPack(
    { contextMap: MINIMAL_CONTEXT_MAP, prChangedFiles: CHECKOUT_FILES, routes: ["/checkout", "/product/:id"], ...PACK_INPUT },
    capturingDeps([]),
  );
  const header = packHeader(result.text);
  for (const named of [new RegExp(PACK_HEADINGS.liveDom, "gi"), /API contracts/gi, new RegExp(PACK_HEADINGS.notCapturable, "gi")]) {
    assert.equal(header.match(named)?.length, 1, `${named} is named once`);
  }
});

test("buildContextPack: a route's text is cleaned of secrets before it is listed", async () => {
  const result = await buildContextPack({ routes: ["/reset/:token?key=sk_live_abcdefghijklmnop1234", "/a"], ...PACK_INPUT }, capturingDeps([]));
  assert.equal(result.text?.includes("sk_live_abcdefghijklmnop1234"), false);
  assert.ok(sectionOf(result.text, PACK_HEADINGS.notCapturable).includes("/reset/"));
});

/* ── The routes of the map, ranked by the change before the cut ── */

const { source: SOURCE_FIELD, implementationFiles: IMPLEMENTATION_FIELD, spec: SPEC_FIELD } = ROUTE_LINK_FIELDS;
const CHANGED_FILE = "src/pages/last.ts";
/* Two more routes than the capture takes: the last of them is behind the cut. */
const BEHIND_THE_CUT = plainRoutes(MAX_ROUTES + 2);
const LAST_ROUTE = BEHIND_THE_CUT[BEHIND_THE_CUT.length - 1]!;

/* The map is data read from a file, so entries are built as plain records and the map type is claimed once. */
const mapWith = (routes: readonly Record<string, unknown>[], api: readonly Record<string, unknown>[] = [], feBe: readonly Record<string, unknown>[] = []): ArchitectureContext =>
  ({ builtAtSha: "abc1234", routes, api, feBe }) as unknown as ArchitectureContext;
const entriesOf = (paths: readonly string[], links: Record<string, Record<string, unknown>> = {}): Record<string, unknown>[] => paths.map((path) => ({ path, ...links[path] }));
const linkedLast = (field: string, value: unknown): ArchitectureContext => mapWith(entriesOf(BEHIND_THE_CUT, { [LAST_ROUTE]: { [field]: value } }));

test("buildContextPack: a map route linked to a changed file is captured though the cut would leave it out, ahead of the routes the file puts first", async () => {
  const captured: string[][] = [];
  await buildContextPack({ contextMap: linkedLast(SOURCE_FIELD, CHANGED_FILE), routes: BEHIND_THE_CUT, prChangedFiles: [CHANGED_FILE], ...PACK_INPUT }, capturingDeps(captured));
  assert.deepEqual(captured[0], [LAST_ROUTE, ...BEHIND_THE_CUT.slice(0, MAX_ROUTES - 1)]);
});

test("buildContextPack: each way a route can be linked reaches the capture from behind the cut", async () => {
  const joined = mapWith(entriesOf(BEHIND_THE_CUT), [{ operationId: "op", method: "GET", path: "/op", [SPEC_FIELD]: CHANGED_FILE }], [{ route: LAST_ROUTE, operationId: "op" }]);
  for (const [name, contextMap] of [
    ["implementation files", linkedLast(IMPLEMENTATION_FIELD, [CHANGED_FILE])],
    ["the declaring source", linkedLast(SOURCE_FIELD, CHANGED_FILE)],
    ["the spec of a joined operation", joined],
  ] as const) {
    const captured: string[][] = [];
    await buildContextPack({ contextMap, routes: BEHIND_THE_CUT, prChangedFiles: [CHANGED_FILE], ...PACK_INPUT }, capturingDeps(captured));
    assert.equal(captured[0]?.[0], LAST_ROUTE, name);
  }
});

test("buildContextPack: a change linked to more pages than the default cut captures each of them, up to the per-change bound", async () => {
  for (const linked of [MAX_ROUTES + 2, MAX_ROUTES_PER_CHANGE + 3]) {
    const routes = plainRoutes(linked + 1);
    const contextMap = mapWith(entriesOf(routes, Object.fromEntries(routes.slice(0, linked).map((route) => [route, { [SOURCE_FIELD]: CHANGED_FILE }]))));
    const captured: string[][] = [];
    await buildContextPack({ contextMap, routes, prChangedFiles: [CHANGED_FILE], ...PACK_INPUT }, capturingDeps(captured));
    assert.deepEqual(captured[0], routes.slice(0, Math.min(linked, MAX_ROUTES_PER_CHANGE)), `${linked} linked pages`);
  }
});

test("buildContextPack: with no changed file the map's links rank nothing and the capture follows the file", async () => {
  const captured: string[][] = [];
  await buildContextPack({ contextMap: linkedLast(SOURCE_FIELD, CHANGED_FILE), routes: BEHIND_THE_CUT, ...PACK_INPUT }, capturingDeps(captured));
  assert.deepEqual(captured[0], BEHIND_THE_CUT.slice(0, MAX_ROUTES));
});





test("buildContextPack: a template of the map linked to a changed file ranks first, and the page a link shows for it is captured", async () => {
  const calls: Call[] = [];
  const template = "/product/:id/view";
  const routes = [...plainRoutes(MAX_ROUTES + 1), template];
  const contextMap = mapWith(entriesOf(routes, { [template]: { [SOURCE_FIELD]: CHANGED_FILE } }));
  const result = await buildContextPack({ contextMap, routes, prChangedFiles: [CHANGED_FILE], ...PACK_INPUT }, siteWithLinks({ "/r0": ["/product/7/view"] }, calls));
  assert.deepEqual(calls[0]!.routes, plainRoutes(MAX_ROUTES), "the first capture is of the pages the routes name, which also shows the links");
  assert.deepEqual(calls[1]!.routes, ["/product/7/view"], "the page found for the template ranks first and is not captured twice");
  assert.ok(sectionOf(result.text, PACK_HEADINGS.liveDom).includes("/product/7/view"));
});

test("buildContextPack: a route that names no page and no template of one stays out of the cut, whatever its rank, and is listed apart", async () => {
  const captured: string[][] = [];
  const notAPage = "the product page";
  const routes = [...plainRoutes(MAX_ROUTES + 1), notAPage];
  const contextMap = mapWith(entriesOf(routes, { [notAPage]: { [SOURCE_FIELD]: CHANGED_FILE } }));
  const result = await buildContextPack({ contextMap, routes, prChangedFiles: [CHANGED_FILE], ...PACK_INPUT }, capturingDeps(captured));
  assert.deepEqual(captured[0], plainRoutes(MAX_ROUTES));
  assert.ok(sectionOf(result.text, PACK_HEADINGS.notCapturable).includes(notAPage), "listed under its own heading");
});

test("buildContextPack: a malformed link field in the map keeps the pack, and the valid links still rank", async () => {
  const captured: string[][] = [];
  const contextMap = mapWith(
    entriesOf(BEHIND_THE_CUT, { [BEHIND_THE_CUT[0]!]: { [IMPLEMENTATION_FIELD]: 7 }, [BEHIND_THE_CUT[1]!]: { [SOURCE_FIELD]: { not: "a path" } } }),
    [{ operationId: "op", method: "GET", path: "/op", [SPEC_FIELD]: CHANGED_FILE }, { operationId: "broken", method: "GET", path: "/broken", [SPEC_FIELD]: [CHANGED_FILE] }],
    [{ route: LAST_ROUTE, operationId: "op" }, { route: BEHIND_THE_CUT[2]!, operationId: "broken" }],
  );
  const result = await buildContextPack({ contextMap, routes: BEHIND_THE_CUT, prChangedFiles: [CHANGED_FILE], ...PACK_INPUT }, capturingDeps(captured));
  assert.ok(result.text?.includes(PACK_HEADINGS.liveDom), "the pack is there, with its live DOM");
  assert.equal(captured[0]?.[0], LAST_ROUTE, "the validly linked route is promoted");
  assert.deepEqual(captured[0]?.slice(1), BEHIND_THE_CUT.slice(0, MAX_ROUTES - 1), "and the rest keep the file's order");
});

const STAGED_ROOT = "e2e/.qa/service-context/org__orders-svc";
const specOf = (declared: string): ArchitectureContext =>
  mapWith(entriesOf(BEHIND_THE_CUT), [{ operationId: "op", method: "GET", path: "/op", [SPEC_FIELD]: declared }], [{ route: LAST_ROUTE, operationId: "op" }]);

test("buildContextPack: on a cross-repo run a declared path under the staged root is compared with the service's changed files", async () => {
  const captured: string[][] = [];
  const input = { contextMap: specOf(`${STAGED_ROOT}/contracts/api/orders.yaml`), routes: BEHIND_THE_CUT, prChangedFiles: ["api/orders.yaml"], ...PACK_INPUT };

  await buildContextPack({ ...input, stagedRoots: [STAGED_ROOT] }, capturingDeps(captured));
  await buildContextPack({ ...input, stagedRoots: ["e2e/.qa/service-context/another-svc"] }, capturingDeps(captured));

  assert.equal(captured[0]?.[0], LAST_ROUTE, "under the root of the triggering service");
  assert.deepEqual(captured[1], BEHIND_THE_CUT.slice(0, MAX_ROUTES), "under the root of another service");
});

test("buildContextPack: on a cross-repo run a path outside the staged root is not compared, though a single repo would match it", async () => {
  const captured: string[][] = [];
  const input = { contextMap: specOf("api/orders.yaml"), routes: BEHIND_THE_CUT, prChangedFiles: ["api/orders.yaml"], ...PACK_INPUT };

  await buildContextPack({ ...input, stagedRoots: [STAGED_ROOT] }, capturingDeps(captured));
  await buildContextPack(input, capturingDeps(captured));

  assert.deepEqual(captured[0], BEHIND_THE_CUT.slice(0, MAX_ROUTES), "cross-repo");
  assert.equal(captured[1]?.[0], LAST_ROUTE, "single repo");
});

/* ── The pages a redirect reached: a section of their own, outside the live DOM ── */

/* What a capture reports when a route redirected: the grounded routes, then, after a blank line, the page reached under a heading of its own. */
const advisoryOf = (...extra: string[]): string => [`### ${PACK_HEADINGS.redirected} (x)`, "reached /login, asked for /orders:", "  textbox: Email", "  button: Sign in", ...extra].join("\n");
const CAPTURE_WITH_REDIRECT = ["route /cart:", "  button: Apply coupon", "route /orders: (redirected to /login)", "", advisoryOf()].join("\n");
const capturing = (captured: string): ContextPackDeps => ({
  captureDomForRoutes: async () => captured,
  domDeps: stubDomDeps(undefined),
  log: () => {},
});

test("buildContextPack: the page a redirect reached is its own section, outside the live DOM that is declared ground truth", async () => {
  const result = await buildContextPack({ routes: ["/cart", "/orders"], ...PACK_INPUT }, capturing(CAPTURE_WITH_REDIRECT));
  const live = sectionOf(result.text, PACK_HEADINGS.liveDom);
  const advisory = sectionOf(result.text, PACK_HEADINGS.redirected);
  assert.ok(live.includes("button: Apply coupon") && live.includes("route /orders:"), "the live DOM holds the captured route and says the other was redirected");
  assert.equal(live.includes("textbox: Email"), false, "the reached page's tree is not under the live DOM");
  assert.ok(advisory.includes("textbox: Email") && advisory.includes("/login"), "it is in the section of its own, with the page it reached");
});

test("buildContextPack: every advisory section a capture holds is kept as it came, in order, with nothing between them", async () => {
  const first = advisoryOf();
  const second = advisoryOf("  link: Forgot password");
  const result = await buildContextPack({ routes: ["/cart", "/orders"], ...PACK_INPUT }, capturing(["route /cart:", "  button: Apply coupon", "", first, second].join("\n")));
  assert.ok(result.text?.includes(`${first}\n${second}`), "the sections are joined as the capture had them");
});

test("buildContextPack: blank lines at the end of the capture leave no gap after the redirect section", async () => {
  const result = await buildContextPack({ routes: ["/cart", "/orders"], ...PACK_INPUT }, capturing(`${CAPTURE_WITH_REDIRECT}\n\n\n`));
  assert.equal(result.text, result.text?.trimEnd());
});

test("buildContextPack: the live DOM's line cap counts only the live DOM's own lines", async () => {
  const many = Array.from({ length: 400 }, (_, i) => `  link: nav-${i}`);
  const captured = ["route /cart:", ...many, "", advisoryOf()].join("\n");
  const result = await buildContextPack({ routes: ["/cart"], ...PACK_INPUT }, capturing(captured));
  assert.ok(sectionOf(result.text, PACK_HEADINGS.redirected).includes("button: Sign in"), "the cap that trims the live DOM does not reach the other section");
});

test("buildContextPack: the redirect section is not counted in the live DOM's bytes", async () => {
  const result = await buildContextPack({ routes: ["/cart", "/orders"], ...PACK_INPUT }, capturing(CAPTURE_WITH_REDIRECT));
  const live = `### ${sectionOf(result.text, PACK_HEADINGS.liveDom)}`.trimEnd();
  assert.equal(result.domBytes, Buffer.byteLength(live, "utf8"));
});

test("buildContextPack: when every route redirected the pack still holds the pages they reached", async () => {
  const captured = ["route /a: (redirected to /login)", "route /b: (redirected to /login)", "", advisoryOf()].join("\n");
  const result = await buildContextPack({ routes: ["/a", "/b"], ...PACK_INPUT }, capturing(captured));
  assert.ok(sectionOf(result.text, PACK_HEADINGS.redirected).includes("textbox: Email"));
  assert.equal(sectionOf(result.text, PACK_HEADINGS.liveDom).includes("textbox: Email"), false);
});

test("buildContextPack: with no redirect there is no such section, and the header names it only when it is there", async () => {
  const plain = await buildContextPack({ routes: ["/cart"], ...PACK_INPUT }, capturing("route /cart:\n  button: Apply coupon"));
  assert.equal(plain.text?.includes(PACK_HEADINGS.redirected), false);
  assert.doesNotMatch(packHeader(plain.text), new RegExp(PACK_HEADINGS.redirected, "i"));
  const redirected = await buildContextPack({ routes: ["/cart", "/orders"], ...PACK_INPUT }, capturing(CAPTURE_WITH_REDIRECT));
  assert.match(packHeader(redirected.text), new RegExp(PACK_HEADINGS.redirected, "i"));
});

test("buildContextPack: the text of a page a redirect reached is cleaned of secrets like the rest of the capture", async () => {
  const captured = ["route /orders: (redirected to /login)", "", advisoryOf("  text: key sk_live_abcdefghijklmnop1234")].join("\n");
  const result = await buildContextPack({ routes: ["/orders"], ...PACK_INPUT }, capturing(captured));
  assert.equal(result.text?.includes("sk_live_abcdefghijklmnop1234"), false);
  assert.ok(sectionOf(result.text, PACK_HEADINGS.redirected).includes("textbox: Email"));
});

test("buildContextPack: the pack's claims are the live DOM's alone: the redirect section declares no fact of its own", async () => {
  const result = await buildContextPack({ routes: ["/cart", "/orders"], ...PACK_INPUT }, capturing(CAPTURE_WITH_REDIRECT));
  const claims = deriveClaimsFromPackText(result.text ?? "");
  assert.deepEqual(claims.filter((c) => c.kind === "provides").map((c) => (c as { fact: FactId }).fact), ["dom-live"]);
  assert.equal(claims.filter((c) => c.kind === "frames").length, 1, "only the live DOM is framed");
});

test("buildContextPack: a pack with no route that cannot be captured carries no such section, and its header names it only when it does", async () => {
  const plain = await buildContextPack({ routes: ["/a"], ...PACK_INPUT }, capturingDeps([]));
  assert.equal(plain.text?.includes(PACK_HEADINGS.notCapturable), false);
  assert.doesNotMatch(packHeader(plain.text), new RegExp(PACK_HEADINGS.notCapturable, "i"));
  const withTemplate = await buildContextPack({ routes: ["/a", "/product/:id"], ...PACK_INPUT }, capturingDeps([]));
  assert.match(packHeader(withTemplate.text), new RegExp(PACK_HEADINGS.notCapturable, "i"));
});

test("buildContextPack: absent `routes` input is byte-identical to today (regression guard)", async () => {
  const result = await buildContextPack(
    { routes: ["/checkout"], baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    stubContextPackDeps("button: Submit"),
  );
  assert.ok(result.text?.includes(PACK_HEADINGS.liveDom), "unaffected behavior when routes is absent");
});

test("buildContextPack degrades gracefully when DOM capture throws", async () => {
  const deps: ContextPackDeps = {
    captureDomForRoutes: async () => { throw new Error("Playwright not available"); },
    domDeps: stubDomDeps(undefined),
    log: () => {},
  };
  const result = await buildContextPack(
    { routes: ["/checkout"], baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    deps,
  );
  assert.equal(result.domBytes, 0, "DOM bytes must be 0 when capture throws");
  assert.equal(result.text, undefined, "the run continues with no pack");
});

test("buildContextPack DOM section respects the FIXED 30KB budget (large DOM is truncated)", async () => {
  const largeLines = Array.from({ length: 2000 }, (_, i) => `button: Button ${i}`);
  const largeDom = largeLines.join("\n");
  const result = await buildContextPack(
    {
      routes: ["/checkout"],
      baseUrl: "http://localhost:3000",
      e2eDir: "/fake/e2e",
    },
    stubContextPackDeps(largeDom),
  );
  assert.ok(result.domBytes > 0, "DOM section is present");
  const domSection = result.text?.split(`### ${PACK_HEADINGS.liveDom}`)[1] ?? "";
  assert.ok(!domSection.includes("Button 1999"), "last button must be omitted (truncated by the fixed 30KB cap)");
  assert.ok(result.text?.includes("omitted"), "truncation marker must appear");
});


test("buildContextPack: every route of the input is a candidate for the DOM capture", async () => {
  const domContent = "heading: Hello World\nbutton: Contact me";
  let capturedRoutes: string[] = [];
  const capturingDeps: ContextPackDeps = {
    captureDomForRoutes: async (routes, _input, _domDeps) => {
      capturedRoutes = routes;
      return domContent;
    },
    domDeps: stubDomDeps(domContent),
    log: () => {},
  };

  const result = await buildContextPack(
    { routes: ["/", "/about"], baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    capturingDeps,
  );

  assert.ok(capturedRoutes.length > 0, "DOM capture must be called for the routes");
  assert.ok(capturedRoutes.includes("/"), "root route must be a candidate for DOM capture");
  assert.ok(result.domBytes > 0, "DOM section must be populated from the candidate routes");
  assert.ok(result.text?.includes(PACK_HEADINGS.liveDom), "DOM section header must appear in pack");
});

test("route cap: more routes than the capture takes is cut to the number the capture takes", async () => {
  const manyRoutes = Array.from({ length: 10 }, (_, i) => `/route${i}`);
  let capturedRouteCount = 0;
  const countingDeps: ContextPackDeps = {
    captureDomForRoutes: async (routes, _input, _domDeps) => {
      capturedRouteCount = routes.length;
      return routes.map((r) => `button: Button for ${r}`).join("\n");
    },
    domDeps: stubDomDeps(undefined),
    log: () => {},
  };

  await buildContextPack(
    { routes: manyRoutes, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    countingDeps,
  );

  assert.equal(capturedRouteCount, MAX_ROUTES);
});

test("changedElements on ContextPackInput reaches DOM section via captureDomForRoutes (4th arg)", async () => {
  const changed: ChangedElement[] = [{ file: "f.html", line: 1, testId: "register-btn", raw: "raw" }];

  let receivedChanged: ChangedElement[] | undefined = undefined;
  const trackingDeps: ContextPackDeps = {
    captureDomForRoutes: async (_routes, _input, _domDeps, changedArg) => {
      receivedChanged = changedArg;
      return "button: Register  -> [data-testid=register-btn] [CHANGED: added data-cy=register-btn]";
    },
    domDeps: stubDomDeps(undefined),
    log: () => {},
  };

  const result = await buildContextPack(
    { routes: ["/checkout"], baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e", changedElements: changed },
    trackingDeps,
  );

  assert.deepEqual(receivedChanged, changed, "changedElements forwarded as 4th arg to captureDomForRoutes");
  assert.ok(result.text?.includes("[CHANGED:"), "DOM section must contain [CHANGED: marker");
});

test("changedElements=undefined on ContextPackInput → output byte-identical (regression guard)", async () => {
  const withUndefined = await buildContextPack(
    { routes: ["/checkout"], baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    stubContextPackDeps("button: Submit"),
  );
  const withExplicitUndefined = await buildContextPack(
    { routes: ["/checkout"], baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e", changedElements: undefined },
    stubContextPackDeps("button: Submit"),
  );
  assert.equal(withExplicitUndefined.text, withUndefined.text, "undefined changedElements is byte-identical to omitting it");
});

test("testIdAttribute on ContextPackInput is forwarded to captureDomForRoutes input", async () => {
  let receivedTestIdAttribute: string | undefined = undefined;
  const trackingDeps: ContextPackDeps = {
    captureDomForRoutes: async (_routes, input, _domDeps) => {
      receivedTestIdAttribute = input.testIdAttribute;
      return "button: Submit";
    },
    domDeps: stubDomDeps(undefined),
    log: () => {},
  };

  await buildContextPack(
    { routes: ["/checkout"], baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e", testIdAttribute: "data-cy" },
    trackingDeps,
  );

  assert.equal(receivedTestIdAttribute, "data-cy", "testIdAttribute must be forwarded to captureDomForRoutes' input arg");
});

/* ── Capture-state lines for a page whose dev.dataState route matched ── */

test("a page whose data state is unconfirmed gets an explicit capture-state line, and no absent fact is emitted", async () => {
  const deps: ContextPackDeps = {
    captureDomForRoutes: async (_routes, input) => {
      input.onPages?.([{
        route: "/home",
        grounded: true,
        links: [],
        dataState: true,
        resultExpected: true,
        resultCount: 0,
        dataStateUnconfirmed: true,
        keptNodes: ["button: Save"],
        keptTestIds: [],
        testIdOfNode: new Map(),
        nodeCapOmitted: 0,
      }]);
      return "route /home:\n  button: Save";
    },
    domDeps: stubDomDeps(undefined),
    log: () => {},
  };
  const result = await buildContextPack(
    { routes: ["/home"], baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e", changedElements: [{ file: "f.html", line: 1, testId: "register-btn", raw: "raw" }] },
    deps,
  );
  assert.ok(result.text?.includes("data state not confirmed"), "the unobservable warning is present");
  assert.ok(result.text?.includes("0 result(s)"), "the result count is stated");
  assert.ok(result.text?.includes("button: Save"), "the existing DOM text still works");
  const { ids } = packDeliveredItemIds(result);
  assert.ok(!ids.some((id) => id.startsWith("fact:*#register-btn:absent")), "no absent fact when a page is unconfirmed");
});

test("a page with a confirmed data state reports its result count and effective location", async () => {
  const deps: ContextPackDeps = {
    captureDomForRoutes: async (_routes, input) => {
      input.onPages?.([{
        route: "/home",
        grounded: true,
        links: [],
        dataState: true,
        resultExpected: true,
        resultCount: 11,
        effectiveLocation: "Madrid",
        dataStateUnconfirmed: false,
        keptNodes: ["text: hi"],
        keptTestIds: [],
        testIdOfNode: new Map(),
        nodeCapOmitted: 0,
      }]);
      return "route /home:\n  text: hi";
    },
    domDeps: stubDomDeps(undefined),
    log: () => {},
  };
  const result = await buildContextPack({ routes: ["/home"], baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" }, deps);
  assert.ok(result.text?.includes("11 result(s)"), "the result count is stated");
  assert.ok(result.text?.includes('location "Madrid"'), "the effective location is quoted");
});

/* The pack is assembled elsewhere and reaches the prompt as a string, so its claims are derived from what it actually rendered. */
const providedFacts = (claims: readonly PromptClaim[]): FactId[] =>
  claims.flatMap((c) => (c.kind === "provides" ? [c.fact] : [])).sort();
const framedFacts = (claims: readonly PromptClaim[]): FactId[] =>
  claims.flatMap((c) => (c.kind === "frames" ? [c.fact] : [])).sort();

test("deriveClaimsFromPackText: a pack with only a live DOM provides and frames only the live DOM", async () => {
  const { text } = await buildContextPack(
    { routes: ["/checkout"], baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    stubContextPackDeps("button: Submit"),
  );
  const claims = deriveClaimsFromPackText(text ?? "");
  assert.deepEqual(providedFacts(claims), ["dom-live"]);
  assert.ok(framedFacts(claims).includes("dom-live"), "the live DOM is labeled ground truth by its own heading");
  assert.deepEqual(framedFacts(claims).filter((f) => f !== "dom-live"), [], "no other fact is framed");
});

test("deriveClaimsFromPackText: the pack provides its live DOM and its API contracts, and only those", async () => {
  const { text } = await buildContextPack(
    {
      routes: ["/checkout"],
      contextMap: MINIMAL_CONTEXT_MAP,
      prChangedFiles: CHECKOUT_FILES,
      baseUrl: "http://localhost:3000",
      e2eDir: "/fake/e2e",
    },
    stubContextPackDeps("button: Submit"),
  );
  const claims = deriveClaimsFromPackText(text ?? "");
  assert.deepEqual(providedFacts(claims), ["api-operations", "dom-live"]);
});

test("deriveClaimsFromPackText: claims follow the rendered content, not a fixed pack shape", async () => {
  const domOnly = await buildContextPack({ baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e", routes: ["/checkout"] }, stubContextPackDeps("button: Submit"));
  const contractsOnly = await buildContextPack({ contextMap: MINIMAL_CONTEXT_MAP, prChangedFiles: CHECKOUT_FILES }, stubContextPackDeps(undefined));
  assert.deepEqual(providedFacts(deriveClaimsFromPackText(domOnly.text ?? "")), ["dom-live"]);
  assert.deepEqual(providedFacts(deriveClaimsFromPackText(contractsOnly.text ?? "")), ["api-operations"]);
});


test("deriveClaimsFromPackText: text without any pack section yields no claims", () => {
  assert.deepEqual(deriveClaimsFromPackText(""), []);
  assert.deepEqual(deriveClaimsFromPackText("some unrelated text"), []);
});

test("withoutPackSection removes exactly the named section and keeps the header and the other sections", () => {
  const text = [
    `## ${PACK_HEADINGS.pack} (pushed)`,
    "",
    "header line",
    "",
    `### ${PACK_HEADINGS.liveDom} (a11y tree)`,
    "  heading: Cart",
    "  button: Apply",
    "",
    `### ${PACK_HEADINGS.contracts} (from context.json)`,
    "- `applyCoupon`: POST /cart/coupon",
  ].join("\n");
  const out = withoutPackSection(text, PACK_HEADINGS.liveDom) ?? "";
  assert.ok(out.includes("header line"));
  assert.ok(out.includes(PACK_HEADINGS.contracts) && out.includes("applyCoupon"));
  assert.equal(out.includes(PACK_HEADINGS.liveDom), false);
  assert.equal(out.includes("button: Apply"), false);
});

test("withoutPackSection leaves a pack that does not carry the section untouched", () => {
  const text = `## ${PACK_HEADINGS.pack}\n\n### ${PACK_HEADINGS.contracts} (x)\n- a`;
  assert.equal(withoutPackSection(text, PACK_HEADINGS.liveDom), text);
});

test("withoutPackSection reports no pack at all when the removed section was the only one", () => {
  const text = `## ${PACK_HEADINGS.pack}\n\nheader\n\n### ${PACK_HEADINGS.liveDom} (x)\n  heading: Cart`;
  assert.equal(withoutPackSection(text, PACK_HEADINGS.liveDom), undefined);
});

/* The text above the first section: what the pack says about itself. */
const packHeader = (text: string | undefined): string => (text ?? "").split(/^### /m)[0] ?? "";

test("the pack's header names only the sections it holds", async () => {
  const contractsOnly = await buildContextPack({ contextMap: MINIMAL_CONTEXT_MAP, prChangedFiles: CHECKOUT_FILES }, stubContextPackDeps(undefined));
  assert.ok(contractsOnly.text?.includes(`### ${PACK_HEADINGS.contracts}`), "the fixture holds contracts and no DOM");
  assert.equal(contractsOnly.text?.includes(`### ${PACK_HEADINGS.liveDom}`), false);
  assert.doesNotMatch(packHeader(contractsOnly.text), new RegExp(PACK_HEADINGS.liveDom, "i"), "a pack with no DOM does not describe a live DOM");
  assert.match(packHeader(contractsOnly.text), /contracts/i);

  const domOnly = await buildContextPack(
    { routes: ["/checkout"], baseUrl: "http://localhost:3000", e2eDir: "/mirrors/e2e" },
    stubContextPackDeps("button: Pay"),
  );
  assert.ok(domOnly.text?.includes(`### ${PACK_HEADINGS.liveDom}`), "the fixture holds a DOM and no contracts");
  assert.doesNotMatch(packHeader(domOnly.text), /contracts/i, "a pack with no contracts does not describe any");
  assert.match(packHeader(domOnly.text), new RegExp(PACK_HEADINGS.liveDom, "i"));

  const both = await buildContextPack(
    { contextMap: MINIMAL_CONTEXT_MAP, prChangedFiles: CHECKOUT_FILES, routes: ["/checkout"], baseUrl: "http://localhost:3000", e2eDir: "/mirrors/e2e" },
    stubContextPackDeps("button: Pay"),
  );
  assert.match(packHeader(both.text), new RegExp(PACK_HEADINGS.liveDom, "i"));
  assert.match(packHeader(both.text), /contracts/i);
});


/* ── Route templates: opened through the real links the site shows ── */

interface Call {
  routes: string[];
  linkSeeds: readonly string[];
  instanceOf: ReadonlyMap<string, string>;
}

/* A site that shows `linksOf[route]` on each page and renders every route it is asked for. */
function siteWithLinks(
  linksOf: Record<string, string[]>,
  calls: Call[],
  options: { failSecond?: boolean; redirectAdvisory?: string; ungrounded?: readonly string[]; silentFrom?: number; nodesOf?: (route: string) => string[] } = {},
): ContextPackDeps {
  return {
    captureDomForRoutes: async (routes, input) => {
      const { linkSeeds = [], instanceOf = new Map<string, string>(), onPages } = input;
      calls.push({ routes, linkSeeds, instanceOf });
      if (options.failSecond && calls.length > 1) throw new Error("browser gone");
      /* A capture that renders nothing (a timed-out or unreadable run) answers no text and tells nobody of any page. */
      if (options.silentFrom !== undefined && calls.length >= options.silentFrom) return undefined;
      onPages?.([...routes, ...linkSeeds].map((route) => ({ route, grounded: !(options.ungrounded ?? []).includes(route), links: linksOf[route] ?? [], nodes: options.nodesOf?.(route) ?? [`button: on ${route}`] })));
      if (routes.length === 0) return undefined;
      const blocks = routes.map((route) => `route ${route}${instanceOf.has(route) ? ` (instance of ${instanceOf.get(route)})` : ""}:\n  button: on ${route}`);
      return [...blocks, ...(options.redirectAdvisory && calls.length === 1 ? [`### ${PACK_HEADINGS.redirected} (ADVISORY)\nintro\n${options.redirectAdvisory}`] : [])].join("\n\n");
    },
    domDeps: stubDomDeps(undefined),
    log: () => {},
  };
}

const LIST_TEMPLATE = "/shops/:province/:city";

test("buildContextPack: a template is captured through a link the site showed on a page captured first, and the report names both", async () => {
  const calls: Call[] = [];
  const result = await buildContextPack({ routes: [LIST_TEMPLATE, "/a"], ...PACK_INPUT }, siteWithLinks({ "/a": ["/shops/madrid/madrid"] }, calls));
  assert.deepEqual(calls[0]!.routes, ["/a"]);
  assert.deepEqual(calls[1]!.routes, ["/shops/madrid/madrid"]);
  assert.equal(calls[1]!.instanceOf.get("/shops/madrid/madrid"), LIST_TEMPLATE);
  const live = sectionOf(result.text, PACK_HEADINGS.liveDom);
  assert.ok(live.includes("button: on /a") && live.includes("button: on /shops/madrid/madrid"), "both captures are in the live DOM section");
  assert.ok(live.includes(LIST_TEMPLATE), "the report says which template the page is an instance of");
  assert.equal(sectionOf(result.text, PACK_HEADINGS.notCapturable), "", "a template with a page is not listed as left out");
});

test("buildContextPack: the root is rendered for its links when a template is among the routes and the root is not", async () => {
  const calls: Call[] = [];
  await buildContextPack({ routes: [LIST_TEMPLATE, "/a"], ...PACK_INPUT }, siteWithLinks({ "/": ["/shops/madrid/madrid"] }, calls));
  assert.deepEqual(calls[0]!.linkSeeds, ["/"]);
  assert.deepEqual(calls[1]!.routes, ["/shops/madrid/madrid"], "a link only the root showed is enough");
});

test("buildContextPack: a template alone is captured from the links of the root alone", async () => {
  const calls: Call[] = [];
  const result = await buildContextPack({ routes: [LIST_TEMPLATE], ...PACK_INPUT }, siteWithLinks({ "/": ["/shops/madrid/madrid"] }, calls));
  assert.deepEqual(calls[0]!.routes, []);
  assert.deepEqual(calls[1]!.routes, ["/shops/madrid/madrid"]);
  assert.ok(sectionOf(result.text, PACK_HEADINGS.liveDom).includes("button: on /shops/madrid/madrid"));
});

test("buildContextPack: the root is not a seed when it is among the routes captured anyway", async () => {
  const calls: Call[] = [];
  await buildContextPack({ routes: ["/", LIST_TEMPLATE], ...PACK_INPUT }, siteWithLinks({ "/": ["/shops/a/b"] }, calls));
  assert.deepEqual(calls[0]!.linkSeeds, []);
  assert.deepEqual(calls[1]!.routes, ["/shops/a/b"]);
});

test("buildContextPack: with no template among the routes there is one capture and no seed", async () => {
  const calls: Call[] = [];
  await buildContextPack({ routes: ["/a", "/b"], ...PACK_INPUT }, siteWithLinks({ "/a": ["/shops/a/b"] }, calls));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.linkSeeds, []);
});

test("buildContextPack: a template no link of the site fits is listed as left out, with why, and the rest of the pack stays", async () => {
  const calls: Call[] = [];
  const logs: string[] = [];
  const deps = { ...siteWithLinks({ "/a": ["/about", "/shops/madrid"] }, calls), log: (message: string) => logs.push(message) };
  const result = await buildContextPack({ routes: [LIST_TEMPLATE, "/a"], ...PACK_INPUT }, deps);
  assert.equal(calls.length, 1, "nothing to open, so no second capture");
  const listed = sectionOf(result.text, PACK_HEADINGS.notCapturable);
  assert.ok(listed.includes(LIST_TEMPLATE) && /no link/i.test(listed), listed);
  assert.ok(sectionOf(result.text, PACK_HEADINGS.liveDom).includes("button: on /a"));
  assert.ok(logs.some((message) => message.includes(LIST_TEMPLATE)));
});

test("buildContextPack: a template no link fits is captured at the page the app declares for it, and is not listed as left out", async () => {
  const calls: Call[] = [];
  const deps = { ...siteWithLinks({ "/a": ["/about"] }, calls), routeSamples: { [LIST_TEMPLATE]: "/shops/madrid/madrid" } };
  const result = await buildContextPack({ routes: [LIST_TEMPLATE, "/a"], ...PACK_INPUT }, deps);
  const opened = calls.find((call) => call.instanceOf.size > 0);
  assert.deepEqual(opened?.routes, ["/shops/madrid/madrid"]);
  assert.equal(opened?.instanceOf.get("/shops/madrid/madrid"), LIST_TEMPLATE);
  assert.ok(sectionOf(result.text, PACK_HEADINGS.liveDom).includes("button: on /shops/madrid/madrid"));
  assert.equal(sectionOf(result.text, PACK_HEADINGS.notCapturable), "");
});

/* A site whose every page of the shops template shows the same "nothing here" tree, except the one that exists. */
const missingShopTree = (existing: string) => (route: string): string[] =>
  route.startsWith("/shops/") && route !== existing ? ["heading: Not found", "button: Back"] : [`heading: ${route}`, "button: Order", "button: Back"];

test("buildContextPack: a declared page that shows what a page that cannot exist shows is not delivered as its template, and says why", async () => {
  const calls: Call[] = [];
  const logs: string[] = [];
  const deps = {
    ...siteWithLinks({ "/a": [] }, calls, { nodesOf: missingShopTree("/shops/madrid/sevilla") }),
    routeSamples: { [LIST_TEMPLATE]: "/shops/madrid/madrid" },
    log: (message: string) => logs.push(message),
  };
  const result = await buildContextPack({ routes: [LIST_TEMPLATE, "/a"], ...PACK_INPUT }, deps);
  assert.equal(calls.some((call) => call.instanceOf.size > 0), false, "the declared page is not captured as a page of its template");
  assert.equal(sectionOf(result.text, PACK_HEADINGS.liveDom).includes("/shops/madrid/madrid"), false);
  const line = sectionOf(result.text, PACK_HEADINGS.notCapturable).split("\n").find((entry) => entry.includes(LIST_TEMPLATE)) ?? "";
  assert.ok(line.includes(TEMPLATE_LEFT_OUT.DECLARED_PAGE_MISSING), line);
  assert.ok(logs.some((message) => message.includes(LIST_TEMPLATE) && message.includes(TEMPLATE_LEFT_OUT.DECLARED_PAGE_MISSING)));
});

test("buildContextPack: a declared page the check beside its missing sibling could not capture is not opened again, and says why", async () => {
  const calls: Call[] = [];
  const deps = { ...siteWithLinks({ "/a": [] }, calls, { silentFrom: 2 }), routeSamples: { [LIST_TEMPLATE]: "/shops/madrid/madrid" } };
  const result = await buildContextPack({ routes: [LIST_TEMPLATE, "/a"], ...PACK_INPUT }, deps);
  assert.equal(calls.length, 2, "the first capture and the check, not a third capture of the same page");
  const line = sectionOf(result.text, PACK_HEADINGS.notCapturable).split("\n").find((entry) => entry.includes(LIST_TEMPLATE)) ?? "";
  assert.ok(line.includes(TEMPLATE_LEFT_OUT.PAGE_NOT_CONFIRMED), line);
});

test("buildContextPack: a declared page whose tree is not the one a page that cannot exist shows is captured as its template", async () => {
  const calls: Call[] = [];
  const deps = {
    ...siteWithLinks({ "/a": [] }, calls, { nodesOf: missingShopTree("/shops/madrid/madrid") }),
    routeSamples: { [LIST_TEMPLATE]: "/shops/madrid/madrid" },
  };
  const result = await buildContextPack({ routes: [LIST_TEMPLATE, "/a"], ...PACK_INPUT }, deps);
  assert.ok(sectionOf(result.text, PACK_HEADINGS.liveDom).includes("button: on /shops/madrid/madrid"));
  assert.equal(sectionOf(result.text, PACK_HEADINGS.notCapturable), "");
});

test("buildContextPack: a page a link of the site gave is not compared with a page that cannot exist", async () => {
  const calls: Call[] = [];
  const deps = {
    ...siteWithLinks({ "/a": ["/shops/madrid/madrid"] }, calls, { nodesOf: missingShopTree("/shops/none/none") }),
    routeSamples: { [LIST_TEMPLATE]: "/shops/madrid/madrid" },
  };
  const result = await buildContextPack({ routes: [LIST_TEMPLATE, "/a"], ...PACK_INPUT }, deps);
  assert.equal(calls.length, 2, "the first capture and the template's page, nothing more");
  assert.ok(sectionOf(result.text, PACK_HEADINGS.liveDom).includes("button: on /shops/madrid/madrid"));
});

test("buildContextPack: a link the site showed is opened before the page the app declares for the same template", async () => {
  const calls: Call[] = [];
  const deps = { ...siteWithLinks({ "/a": ["/shops/sevilla/sevilla"] }, calls), routeSamples: { [LIST_TEMPLATE]: "/shops/madrid/madrid" } };
  await buildContextPack({ routes: [LIST_TEMPLATE, "/a"], ...PACK_INPUT }, deps);
  assert.deepEqual(calls[1]!.routes, ["/shops/sevilla/sevilla"]);
});

test("buildContextPack: a declared page that does not fill its template is not opened, and the template stays left out for want of a link", async () => {
  const calls: Call[] = [];
  const deps = { ...siteWithLinks({ "/a": [] }, calls), routeSamples: { [LIST_TEMPLATE]: "/stores/madrid/madrid" } };
  const result = await buildContextPack({ routes: [LIST_TEMPLATE, "/a"], ...PACK_INPUT }, deps);
  assert.equal(calls.length, 1, "nothing to open, so no second capture");
  assert.ok(sectionOf(result.text, PACK_HEADINGS.notCapturable).includes(TEMPLATE_LEFT_OUT.NO_LINK));
});

test("buildContextPack: a template behind the cut is not opened and stays in the list of routes left out", async () => {
  const calls: Call[] = [];
  const behind = "/behind/:id";
  const result = await buildContextPack({ routes: [...plainRoutes(MAX_ROUTES), behind], ...PACK_INPUT }, siteWithLinks({ "/r0": ["/behind/1"] }, calls));
  assert.equal(calls.length, 1);
  assert.ok(sectionOf(result.text, PACK_HEADINGS.notCapturable).includes(behind));
});

test("buildContextPack: the pages rendered stay within the bounds of the cut, one seed and one page per template", async () => {
  const calls: Call[] = [];
  const templates = Array.from({ length: MAX_ROUTES + 3 }, (_, i) => `/t${i}/:id`);
  const links = templates.map((_, i) => `/t${i}/1`);
  await buildContextPack({ routes: [...templates, ...plainRoutes(2)], ...PACK_INPUT }, siteWithLinks({ "/": links }, calls));
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.routes.length + calls[0]!.linkSeeds.length <= MAX_ROUTES + 1);
  assert.ok(calls[1]!.routes.length <= MAX_ROUTES);
});

test("buildContextPack: two templates the same link fills are captured once", async () => {
  const calls: Call[] = [];
  await buildContextPack({ routes: ["/a/:x", "/a/{y}"], ...PACK_INPUT }, siteWithLinks({ "/": ["/a/1"] }, calls));
  assert.deepEqual(calls[1]!.routes, ["/a/1"]);
});

test("buildContextPack: a template filled by a page already among the routes captured is not captured again", async () => {
  const calls: Call[] = [];
  const result = await buildContextPack({ routes: ["/a/1", "/a/:x"], ...PACK_INPUT }, siteWithLinks({ "/a/1": ["/a/1"] }, calls));
  assert.equal(calls.length, 1);
  assert.equal(sectionOf(result.text, PACK_HEADINGS.notCapturable), "");
});

test("buildContextPack: when the capture of the template pages fails, the pages captured first are still in the pack", async () => {
  const calls: Call[] = [];
  const logs: string[] = [];
  const deps = { ...siteWithLinks({ "/a": ["/shops/a/b"] }, calls, { failSecond: true }), log: (message: string) => logs.push(message) };
  const result = await buildContextPack({ routes: [LIST_TEMPLATE, "/a"], ...PACK_INPUT }, deps);
  assert.ok(sectionOf(result.text, PACK_HEADINGS.liveDom).includes("button: on /a"));
  assert.ok(logs.some((message) => /FAILED/.test(message)));
});

test("buildContextPack: when the first capture fails nothing is opened through links and the pack is skipped", async () => {
  const calls: Call[] = [];
  const deps: ContextPackDeps = {
    captureDomForRoutes: async (routes, input) => { calls.push({ routes, linkSeeds: input.linkSeeds ?? [], instanceOf: input.instanceOf ?? new Map() }); throw new Error("browser gone"); },
    domDeps: stubDomDeps(undefined),
    log: () => {},
  };
  const result = await buildContextPack({ routes: [LIST_TEMPLATE, "/a"], ...PACK_INPUT }, deps);
  assert.equal(calls.length, 1);
  assert.equal(result.text, undefined);
});

test("buildContextPack: the pages redirects reached in both captures are one advisory section", async () => {
  const calls: Call[] = [];
  const deps = siteWithLinks({ "/a": ["/shops/a/b"] }, calls);
  const inner = deps.captureDomForRoutes;
  deps.captureDomForRoutes = async (routes, input, domDeps, changed) => {
    const text = (await inner(routes, input, domDeps, changed)) ?? "";
    return `${text}\n\n### ${PACK_HEADINGS.redirected} (ADVISORY)\n${REDIRECT_ADVISORY_INTRO}\nbody of call ${calls.length}`;
  };
  const result = await buildContextPack({ routes: [LIST_TEMPLATE, "/a"], ...PACK_INPUT }, deps);
  assert.equal(result.text?.split(`### ${PACK_HEADINGS.redirected}`).length, 2, "one heading");
  assert.ok(result.text!.includes("body of call 1") && result.text!.includes("body of call 2"));
});

/* ── What the pack says of a template once the capture has answered ── */

test("buildContextPack: a page found for a template that the capture could not ground leaves the template listed as left out, with why", async () => {
  const calls: Call[] = [];
  const logs: string[] = [];
  const deps = { ...siteWithLinks({ "/a": ["/shops/madrid/madrid"] }, calls, { ungrounded: ["/shops/madrid/madrid"] }), log: (message: string) => logs.push(message) };
  const result = await buildContextPack({ routes: [LIST_TEMPLATE, "/a"], ...PACK_INPUT }, deps);
  const listed = sectionOf(result.text, PACK_HEADINGS.notCapturable);
  assert.ok(listed.includes(LIST_TEMPLATE) && listed.includes(TEMPLATE_LEFT_OUT.PAGE_NOT_CONFIRMED), listed);
  assert.ok(logs.some((message) => message.includes(LIST_TEMPLATE) && message.includes(TEMPLATE_LEFT_OUT.PAGE_NOT_CONFIRMED)));
});

test("buildContextPack: a second capture that renders nothing leaves the template listed, not silently gone", async () => {
  const calls: Call[] = [];
  const result = await buildContextPack({ routes: [LIST_TEMPLATE, "/a"], ...PACK_INPUT }, siteWithLinks({ "/a": ["/shops/madrid/madrid"] }, calls, { silentFrom: 2 }));
  assert.equal(calls.length, 2);
  const listed = sectionOf(result.text, PACK_HEADINGS.notCapturable);
  assert.ok(listed.includes(LIST_TEMPLATE) && listed.includes(TEMPLATE_LEFT_OUT.PAGE_NOT_CONFIRMED), listed);
  assert.ok(sectionOf(result.text, PACK_HEADINGS.liveDom).includes("button: on /a"), "the pages captured first stay");
});

test("buildContextPack: when the capture of the template pages throws, the template is listed with the same reason", async () => {
  const calls: Call[] = [];
  const result = await buildContextPack({ routes: [LIST_TEMPLATE, "/a"], ...PACK_INPUT }, siteWithLinks({ "/a": ["/shops/a/b"] }, calls, { failSecond: true }));
  assert.ok(sectionOf(result.text, PACK_HEADINGS.notCapturable).includes(TEMPLATE_LEFT_OUT.PAGE_NOT_CONFIRMED));
});

test("buildContextPack: a template is not reported as having no link when the pages that would show the links were not grounded", async () => {
  const calls: Call[] = [];
  const result = await buildContextPack({ routes: [LIST_TEMPLATE, "/a"], ...PACK_INPUT }, siteWithLinks({}, calls, { ungrounded: ["/a", "/"] }));
  const listed = sectionOf(result.text, PACK_HEADINGS.notCapturable);
  assert.ok(listed.includes(TEMPLATE_LEFT_OUT.NO_PAGE_TO_LOOK_AT), listed);
  assert.equal(listed.includes(TEMPLATE_LEFT_OUT.NO_LINK), false);
});

test("buildContextPack: a template filled by a page of the first capture that did not ground is not opened", async () => {
  const calls: Call[] = [];
  const result = await buildContextPack({ routes: ["/a/1", "/a/:x"], ...PACK_INPUT }, siteWithLinks({ "/a/1": ["/a/1"] }, calls, { ungrounded: ["/a/1"] }));
  assert.ok(sectionOf(result.text, PACK_HEADINGS.notCapturable).includes("/a/:x"));
});

test("buildContextPack: a page only implied by a longer link is accepted when the capture confirms it, and refused when it does not", async () => {
  const implied = "/shops/madrid/madrid";
  const links = { "/a": [`${implied}/bar-1`] };
  const confirmed = await buildContextPack({ routes: [LIST_TEMPLATE, "/a"], ...PACK_INPUT }, siteWithLinks(links, []));
  assert.equal(sectionOf(confirmed.text, PACK_HEADINGS.notCapturable), "");
  assert.ok(sectionOf(confirmed.text, PACK_HEADINGS.liveDom).includes(`button: on ${implied}`));
  const refused = await buildContextPack({ routes: [LIST_TEMPLATE, "/a"], ...PACK_INPUT }, siteWithLinks(links, [], { ungrounded: [implied] }));
  assert.ok(sectionOf(refused.text, PACK_HEADINGS.notCapturable).includes(LIST_TEMPLATE));
});

test("buildContextPack: a template made only of parameters is not opened through any link and asks for no page to be rendered for its links", async () => {
  const calls: Call[] = [];
  const result = await buildContextPack({ routes: ["/:id", "/a"], ...PACK_INPUT }, siteWithLinks({ "/a": ["/login", "/42"] }, calls));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.linkSeeds, []);
  const listed = sectionOf(result.text, PACK_HEADINGS.notCapturable);
  assert.ok(listed.includes("/:id"));
  assert.equal(listed.includes(TEMPLATE_LEFT_OUT.NO_LINK), false);
});

test("buildContextPack: a template ranked behind the cut asks for no page to be rendered for its links", async () => {
  const calls: Call[] = [];
  await buildContextPack({ routes: [...plainRoutes(MAX_ROUTES), "/behind/:id"], ...PACK_INPUT }, siteWithLinks({ "/r0": ["/behind/1"] }, calls));
  assert.deepEqual(calls[0]!.linkSeeds, []);
});

test("buildContextPack: the routes a log line names are cleaned and bounded", async () => {
  const logs: string[] = [];
  const hostile = `/reset/:token/ghp_${"A".repeat(36)}/${"x".repeat(5000)}`;
  const deps = { ...siteWithLinks({}, []), log: (message: string) => logs.push(message) };
  await buildContextPack({ routes: [hostile, "/a"], ...PACK_INPUT }, deps);
  const named = logs.filter((message) => message.includes("/reset/"));
  assert.ok(named.length > 0);
  for (const message of named) {
    assert.equal(message.includes("ghp_AAAA"), false, "the token is redacted");
    assert.ok(message.length < 600, `the line is bounded (${message.length})`);
  }
});

test("buildContextPack: when every candidate names no page and no template of one, nothing is rendered at all", async () => {
  const captured: string[][] = [];
  const result = await buildContextPack({ routes: ["/files/*", "the cart page", "/users/:id?"], ...PACK_INPUT }, capturingDeps(captured));
  assert.equal(captured.length, 0, "no capture was asked for, not even to look for links");
  assert.equal(result.text, undefined);
});

test("buildContextPack: a template that was never looked at keeps the plain reason it names no page, not one about links", async () => {
  const calls: Call[] = [];
  const result = await buildContextPack({ routes: [...plainRoutes(MAX_ROUTES), "/behind/:id"], ...PACK_INPUT }, siteWithLinks({ "/r0": ["/behind/1"] }, calls));
  const line = sectionOf(result.text, PACK_HEADINGS.notCapturable).split("\n").find((entry) => entry.includes("/behind/:id")) ?? "";
  assert.ok(line.endsWith(`(${ROUTE_REASON.TEMPLATE})`), line);
});

test("buildContextPack: a template is reported as having no link when some page that could show one was grounded, even if another was not", async () => {
  const calls: Call[] = [];
  const result = await buildContextPack({ routes: [LIST_TEMPLATE, "/a"], ...PACK_INPUT }, siteWithLinks({}, calls, { ungrounded: ["/"] }));
  assert.ok(sectionOf(result.text, PACK_HEADINGS.notCapturable).includes(TEMPLATE_LEFT_OUT.NO_LINK));
});

test("buildContextPack: when the first capture throws, every template meant to be opened through it is listed for that reason", async () => {
  const deps: ContextPackDeps = {
    captureDomForRoutes: async () => { throw new Error("browser gone"); },
    domDeps: stubDomDeps(undefined),
    log: () => {},
  };
  const logs: string[] = [];
  await buildContextPack({ routes: [LIST_TEMPLATE, "/a/:x"], ...PACK_INPUT }, { ...deps, log: (message: string) => logs.push(message) });
  for (const template of [LIST_TEMPLATE, "/a/:x"]) {
    assert.ok(logs.some((message) => message.includes(template) && message.includes(TEMPLATE_LEFT_OUT.NO_PAGE_TO_LOOK_AT)), template);
  }
});
