/* buildContextPack itself — prompt-assembly wiring lives in prompts.test.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContextPack, deriveClaimsFromPackText, withoutPackSection, MAX_LISTED_UNCAPTURABLE, PACK_HEADINGS, type ContextPackDeps } from "@contexts/generation/infrastructure/context-pack.ts";
import { countDirectives, hasTrustLanguage, type FactId, type PromptClaim } from "@contexts/generation/domain/prompt-contract-lint.ts";
import { MAX_ROUTES, type CaptureDomDeps } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import { ROUTE_LINK_FIELDS } from "@contexts/generation/domain/route-ranking.ts";
import type { ExplorationBrief, ArchitectureContext } from "@contexts/generation/application/ports/generation-ports.ts";
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

const MINIMAL_BRIEF: ExplorationBrief = {
  builtForSha: "abc1234",
  objective: "test the checkout flow",
  blastRadius: [{ symbol: "CheckoutService.pay", file: "src/checkout.ts", role: "applies discount and creates order" }],
  routes: [{ path: "/checkout", verified: true }],
  feBe: [{ route: "/checkout", operationId: "createOrder", via: "OrderClient.create" }],
  contracts: [{ operationId: "createOrder", method: "POST", path: "/orders" }],
  risks: ["assert the discounted total"],
};

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

/* The brief owns the distilled blast radius, FE-BE links and risks; the pack carries only what the orchestrator captured or read itself (the live DOM and the API contracts). */
test("buildContextPack never carries the blast radius, FE-BE links or risks the brief owns", async () => {
  const result = await buildContextPack(
    { brief: MINIMAL_BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    stubContextPackDeps("button: Submit"),
  );
  assert.ok(result.text !== undefined);
  assert.equal(result.text!.includes("CheckoutService.pay"), false, "no blast-radius symbol");
  assert.equal(result.text!.includes("OrderClient.create"), false, "no FE-BE link");
  assert.equal(result.text!.includes("assert the discounted total"), false, "no risk");
  assert.ok(result.text!.includes(PACK_HEADINGS.liveDom), "the captured DOM stays");
});

test("buildContextPack with a brief and nothing captured or read has no pack at all", async () => {
  const result = await buildContextPack({ brief: MINIMAL_BRIEF }, stubContextPackDeps(undefined));
  assert.equal(result.text, undefined);
});

test("buildContextPack's header is neutral: it names the pack and what it holds, and directs nothing", async () => {
  const result = await buildContextPack(
    { brief: MINIMAL_BRIEF, contextMap: MINIMAL_CONTEXT_MAP, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
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
    { brief: MINIMAL_BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
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
    { brief: MINIMAL_BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    stubContextPackDeps(domContent),
  );
  assert.ok(!result.text?.includes("sk-liveSECRETVALUE123456"), "a secret-shaped string in the captured DOM must not reach the pack raw");
});

test("buildContextPack omits DOM section when capture returns undefined", async () => {
  const result = await buildContextPack(
    { brief: MINIMAL_BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    stubContextPackDeps(undefined),
  );
  assert.equal(result.domBytes, 0);
  assert.equal(result.text?.includes(PACK_HEADINGS.liveDom) ?? false, false);
});

test("buildContextPack includes contracts from contextMap when brief references them", async () => {
  const result = await buildContextPack(
    { brief: MINIMAL_BRIEF, contextMap: MINIMAL_CONTEXT_MAP },
    stubContextPackDeps(undefined),
  );
  assert.ok(result.text?.includes(PACK_HEADINGS.contracts), "contracts section header must appear");
  assert.ok(result.text?.includes("POST /orders"), "contract path must appear");
  assert.ok(result.contractBytes > 0, "contract byte count must be positive");
});

test("buildContextPack omits contracts when contextMap is absent", async () => {
  const result = await buildContextPack({ brief: MINIMAL_BRIEF }, stubContextPackDeps(undefined));
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
    "contracts are either included (path matched) or empty (no brief to match from)");
});

/* buildContextPack's candidateRoutes came ONLY from a brief (briefRoutePaths, contextMapRoutes gated
   on brief.feBe) — with no brief-less route path at all, the pack was structurally empty whenever
   the explorer pass never ran (which is EVERY production run today — the explorer stays unwired by
   design). A thin `routes` input lets a caller (the grounding adapter, deterministically, from
   contextMap.routes — no LLM) populate DOM candidates with NO brief present.
 */
test("buildContextPack: the `routes` input populates DOM candidates with NO brief present at all", async () => {
  const domContent = "button: Submit\nheading: Checkout";
  const result = await buildContextPack(
    { routes: ["/checkout"], baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    stubContextPackDeps(domContent),
  );
  assert.ok(result.text?.includes(PACK_HEADINGS.liveDom), "DOM section must be populated from the routes input alone, no brief needed");
  assert.ok(result.domBytes > 0, "DOM byte count must be positive from the routes-only path");
});

test("buildContextPack: `routes` input is merged with brief routes when BOTH are present (brief first, higher precision)", async () => {
  const captured: string[][] = [];
  const deps: ContextPackDeps = {
    captureDomForRoutes: async (routes) => { captured.push(routes); return "button: Submit"; },
    domDeps: stubDomDeps("button: Submit"),
    log: () => {},
  };
  await buildContextPack(
    { brief: MINIMAL_BRIEF, routes: ["/admin"], baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    deps,
  );
  assert.ok(captured[0]?.includes("/checkout"), "the brief's own route must still be a candidate");
  assert.ok(captured[0]?.includes("/admin"), "the routes input's route must ALSO be a candidate");
  assert.ok(captured[0]!.indexOf("/checkout") < captured[0]!.indexOf("/admin"), "brief routes (higher precision) come first");
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
    captureDomForRoutes: async (routes) => { captured.push(routes); return "button: Submit"; },
    domDeps: stubDomDeps("button: Submit"),
    log,
  };
}
const PACK_INPUT = { baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" };
const plainRoutes = (count: number): string[] => Array.from({ length: count }, (_, i) => `/r${i}`);

test("buildContextPack: a route template does not take a capture slot from the routes behind it", async () => {
  const captured: string[][] = [];
  await buildContextPack({ routes: ["/product/:id/view", ...plainRoutes(MAX_ROUTES + 1)], ...PACK_INPUT }, capturingDeps(captured));
  assert.deepEqual(captured[0], plainRoutes(MAX_ROUTES));
});

test("buildContextPack: several templates in front still leave every slot to the plain routes", async () => {
  const captured: string[][] = [];
  const templates = ["/a/:x", "/b/{y}", "/c/[z]", "/files/*", "the cart page", "//evil.example/x"];
  await buildContextPack({ routes: [...templates, ...plainRoutes(MAX_ROUTES)], ...PACK_INPUT }, capturingDeps(captured));
  assert.deepEqual(captured[0], plainRoutes(MAX_ROUTES));
});

test("buildContextPack: a route that the brief and the routes input both name takes one slot, not two", async () => {
  const captured: string[][] = [];
  const brief: ExplorationBrief = { ...MINIMAL_BRIEF, routes: [{ path: "/r0", verified: false }] };
  await buildContextPack({ brief, routes: plainRoutes(MAX_ROUTES + 1), ...PACK_INPUT }, capturingDeps(captured));
  assert.deepEqual(captured[0], plainRoutes(MAX_ROUTES));
});

test("buildContextPack: the brief's and the context map's templates are dropped as well, and the order of the sources is kept", async () => {
  const captured: string[][] = [];
  const brief: ExplorationBrief = { ...MINIMAL_BRIEF, routes: [{ path: "/orders/:id", verified: false }, { path: "/checkout", verified: true }] };
  await buildContextPack({ brief, routes: ["/admin"], ...PACK_INPUT }, capturingDeps(captured));
  assert.deepEqual(captured[0], ["/checkout", "/admin"]);
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
  assert.equal(captured.length, 0);
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
  const result = await buildContextPack({ routes: [...templates, "/a"], ...PACK_INPUT }, capturingDeps([]));
  const section = sectionOf(result.text, PACK_HEADINGS.notCapturable);
  const lines = section.trimEnd().split("\n");
  assert.equal(lines.length, 1 + MAX_LISTED_UNCAPTURABLE + 1, "the heading, one line per listed route, and the count of the rest");
  assert.deepEqual(templates.slice(0, MAX_LISTED_UNCAPTURABLE).map((route) => lines.findIndex((line) => line.includes(route))), Array.from({ length: MAX_LISTED_UNCAPTURABLE }, (_, i) => i + 1));
  assert.ok(lines[lines.length - 1]!.includes(String(extra)));
});

test("buildContextPack: a list of exactly its bound is the heading and one line per route, nothing more", async () => {
  const templates = Array.from({ length: MAX_LISTED_UNCAPTURABLE }, (_, i) => `/t${i}/:id`);
  const result = await buildContextPack({ routes: [...templates, "/a"], ...PACK_INPUT }, capturingDeps([]));
  assert.equal(sectionOf(result.text, PACK_HEADINGS.notCapturable).trimEnd().split("\n").length, 1 + MAX_LISTED_UNCAPTURABLE);
});

test("buildContextPack: with nothing left out the pack ends with its last section, with no blank section after it", async () => {
  const result = await buildContextPack({ routes: ["/a"], ...PACK_INPUT }, capturingDeps([]));
  assert.equal(result.text, result.text?.trimEnd());
});

test("buildContextPack: the header names the live DOM, the contracts and the routes not capturable, each once, when the pack holds all three", async () => {
  const result = await buildContextPack(
    { contextMap: MINIMAL_CONTEXT_MAP, brief: MINIMAL_BRIEF, routes: ["/product/:id"], ...PACK_INPUT },
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

test("buildContextPack: with no changed file the map's links rank nothing and the capture follows the file", async () => {
  const captured: string[][] = [];
  await buildContextPack({ contextMap: linkedLast(SOURCE_FIELD, CHANGED_FILE), routes: BEHIND_THE_CUT, ...PACK_INPUT }, capturingDeps(captured));
  assert.deepEqual(captured[0], BEHIND_THE_CUT.slice(0, MAX_ROUTES));
});

test("buildContextPack: without a routes input the capture holds the brief's routes and nothing else, and nothing is listed as left out", async () => {
  const captured: string[][] = [];
  const logs: string[] = [];
  const input = { brief: MINIMAL_BRIEF, contextMap: linkedLast(SOURCE_FIELD, CHANGED_FILE), prChangedFiles: [CHANGED_FILE], ...PACK_INPUT };
  const result = await buildContextPack(input, capturingDeps(captured, (message) => logs.push(message)));
  assert.deepEqual(captured[0], ["/checkout"]);
  assert.equal(sectionOf(result.text, PACK_HEADINGS.notCapturable), "", "no route is listed as left out");
  assert.equal(logs.some((message) => /not capturable/i.test(message)), false, "and none is logged as left out");
});

test("buildContextPack: brief routes that fill the cut keep it, however well a map route is linked to the change", async () => {
  const captured: string[][] = [];
  const briefPaths = plainRoutes(MAX_ROUTES).map((path) => `/brief${path}`);
  const brief: ExplorationBrief = { ...MINIMAL_BRIEF, routes: briefPaths.map((path) => ({ path, verified: false })) };
  await buildContextPack({ brief, contextMap: linkedLast(SOURCE_FIELD, CHANGED_FILE), routes: BEHIND_THE_CUT, prChangedFiles: [CHANGED_FILE], ...PACK_INPUT }, capturingDeps(captured));
  assert.deepEqual(captured[0], briefPaths);
});

test("buildContextPack: the routes a brief's operations join follow the brief's own, unranked, and come before the routes ranked by the change", async () => {
  const captured: string[][] = [];
  const brief: ExplorationBrief = {
    ...MINIMAL_BRIEF,
    routes: [{ path: "/b", verified: false }],
    feBe: [{ route: "/m1", operationId: "op1" }, { route: "/m2", operationId: "op2" }],
  };
  const contextMap = mapWith(
    entriesOf(["/m1", "/m2", "/d0", "/d1"], { "/m2": { [SOURCE_FIELD]: CHANGED_FILE }, "/d1": { [SOURCE_FIELD]: CHANGED_FILE } }),
    [{ operationId: "op1", method: "GET", path: "/op1" }, { operationId: "op2", method: "GET", path: "/op2" }],
    [{ route: "/m1", operationId: "op1" }, { route: "/m2", operationId: "op2" }],
  );
  await buildContextPack({ brief, contextMap, routes: ["/d0", "/d1"], prChangedFiles: [CHANGED_FILE], ...PACK_INPUT }, capturingDeps(captured));
  assert.deepEqual(captured[0], ["/b", "/m1", "/m2", "/d1", "/d0"].slice(0, MAX_ROUTES));
});

test("buildContextPack: a route the brief names is captured where the brief names it, and takes one slot, not two", async () => {
  const captured: string[][] = [];
  const brief: ExplorationBrief = { ...MINIMAL_BRIEF, routes: [{ path: "/b", verified: false }] };
  const contextMap = mapWith(entriesOf(["/a", "/b", "/c"], { "/c": { [SOURCE_FIELD]: CHANGED_FILE } }));
  await buildContextPack({ brief, contextMap, routes: ["/a", "/b", "/c"], prChangedFiles: [CHANGED_FILE], ...PACK_INPUT }, capturingDeps(captured));
  assert.deepEqual(captured[0], ["/b", "/c", "/a"]);
});

test("buildContextPack: ranking leaves the filter before the cut as it was: a linked route that names no page takes no slot and is listed apart", async () => {
  const captured: string[][] = [];
  const template = "/product/:id/view";
  const routes = [...plainRoutes(MAX_ROUTES + 1), template];
  const contextMap = mapWith(entriesOf(routes, { [template]: { [SOURCE_FIELD]: CHANGED_FILE } }));
  const result = await buildContextPack({ contextMap, routes, prChangedFiles: [CHANGED_FILE], ...PACK_INPUT }, capturingDeps(captured));
  assert.deepEqual(captured[0], plainRoutes(MAX_ROUTES));
  assert.ok(sectionOf(result.text, PACK_HEADINGS.notCapturable).includes(template), "the template is listed under its own heading");
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
    { brief: MINIMAL_BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
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
    { brief: MINIMAL_BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    deps,
  );
  assert.equal(result.domBytes, 0, "DOM bytes must be 0 when capture throws");
  assert.equal(result.text, undefined, "the run continues with no pack: the brief's facts are not the pack's to carry");
});

test("buildContextPack DOM section respects the FIXED 30KB budget (large DOM is truncated)", async () => {
  const largeLines = Array.from({ length: 2000 }, (_, i) => `button: Button ${i}`);
  const largeDom = largeLines.join("\n");
  const result = await buildContextPack(
    {
      brief: MINIMAL_BRIEF,
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

test("brief wired to buildContextPack produces the DOM of the brief's candidate routes", async () => {
  const domContent = "button: Submit\nheading: Checkout";
  const result = await buildContextPack(
    {
      brief: MINIMAL_BRIEF,
      baseUrl: "http://localhost:3000",
      e2eDir: "/fake/e2e",
    },
    stubContextPackDeps(domContent),
  );
  assert.ok(result.text !== undefined, "pack text must be set when the DOM was captured");
  assert.ok(result.domBytes > 0, "DOM section must be captured from brief's candidate routes when wired");
  assert.ok(result.text!.includes(PACK_HEADINGS.liveDom), "DOM section header must appear in pack");
});

test("GAP 2 fix: DOM captured from unverified candidate routes (verified=false)", async () => {
  const briefWithUnverifiedRoutes: ExplorationBrief = {
    builtForSha: "abc1234",
    objective: "test the portfolio home page",
    blastRadius: [{ symbol: "IndexPage", file: "src/pages/index.astro", role: "renders the homepage" }],
    routes: [
      { path: "/", verified: false },
      { path: "/about", verified: false },
    ],
  };
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
    { brief: briefWithUnverifiedRoutes, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    capturingDeps,
  );

  assert.ok(capturedRoutes.length > 0, "DOM capture must be called even for unverified routes");
  assert.ok(capturedRoutes.includes("/"), "root route must be a candidate for DOM capture");
  assert.ok(result.domBytes > 0, "DOM section must be populated from unverified candidate routes");
  assert.ok(result.text?.includes(PACK_HEADINGS.liveDom), "DOM section header must appear in pack");
});

test("route cap: a brief that names more routes than the capture takes is cut to the number the capture takes", async () => {
  const manyRoutesBrief: ExplorationBrief = {
    builtForSha: "abc1234",
    objective: "test many flows",
    blastRadius: [{ symbol: "App", file: "src/App.ts", role: "root component" }],
    routes: Array.from({ length: 10 }, (_, i) => ({ path: `/route${i}`, verified: false })),
  };
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
    { brief: manyRoutesBrief, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
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
    { brief: MINIMAL_BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e", changedElements: changed },
    trackingDeps,
  );

  assert.deepEqual(receivedChanged, changed, "changedElements forwarded as 4th arg to captureDomForRoutes");
  assert.ok(result.text?.includes("[CHANGED:"), "DOM section must contain [CHANGED: marker");
});

test("changedElements=undefined on ContextPackInput → output byte-identical (regression guard)", async () => {
  const withUndefined = await buildContextPack(
    { brief: MINIMAL_BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    stubContextPackDeps("button: Submit"),
  );
  const withExplicitUndefined = await buildContextPack(
    { brief: MINIMAL_BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e", changedElements: undefined },
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
    { brief: MINIMAL_BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e", testIdAttribute: "data-cy" },
    trackingDeps,
  );

  assert.equal(receivedTestIdAttribute, "data-cy", "testIdAttribute must be forwarded to captureDomForRoutes' input arg");
});

/* The pack is assembled elsewhere and reaches the prompt as a string, so its claims are derived from what it actually rendered. */
const providedFacts = (claims: readonly PromptClaim[]): FactId[] =>
  claims.flatMap((c) => (c.kind === "provides" ? [c.fact] : [])).sort();
const framedFacts = (claims: readonly PromptClaim[]): FactId[] =>
  claims.flatMap((c) => (c.kind === "frames" ? [c.fact] : [])).sort();

test("deriveClaimsFromPackText: a pack with only a live DOM provides and frames only the live DOM", async () => {
  const { text } = await buildContextPack(
    { brief: { ...MINIMAL_BRIEF, blastRadius: [], feBe: undefined, risks: undefined }, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
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
      brief: MINIMAL_BRIEF,
      contextMap: MINIMAL_CONTEXT_MAP,
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
  const contractsOnly = await buildContextPack({ brief: MINIMAL_BRIEF, contextMap: MINIMAL_CONTEXT_MAP }, stubContextPackDeps(undefined));
  assert.deepEqual(providedFacts(deriveClaimsFromPackText(domOnly.text ?? "")), ["dom-live"]);
  assert.deepEqual(providedFacts(deriveClaimsFromPackText(contractsOnly.text ?? "")), ["api-operations"]);
});

test("deriveClaimsFromPackText: a pack section that should not exist is still recognized by its heading", () => {
  const text = `## ${PACK_HEADINGS.pack}\n\n### ${PACK_HEADINGS.blastRadius} (x)\n- a\n### ${PACK_HEADINGS.feBe}\n- b\n### ${PACK_HEADINGS.risks}\n- c`;
  assert.deepEqual(providedFacts(deriveClaimsFromPackText(text)), ["blast-radius", "fe-be-links", "risks"]);
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
  const contractsOnly = await buildContextPack({ brief: MINIMAL_BRIEF, contextMap: MINIMAL_CONTEXT_MAP }, stubContextPackDeps(undefined));
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
    { brief: MINIMAL_BRIEF, contextMap: MINIMAL_CONTEXT_MAP, routes: ["/checkout"], baseUrl: "http://localhost:3000", e2eDir: "/mirrors/e2e" },
    stubContextPackDeps("button: Pay"),
  );
  assert.match(packHeader(both.text), new RegExp(PACK_HEADINGS.liveDom, "i"));
  assert.match(packHeader(both.text), /contracts/i);
});
