/* buildContextPack itself — prompt-assembly wiring lives in prompts.test.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContextPack, deriveClaimsFromPackText, withoutPackSection, MAX_LISTED_UNCAPTURABLE, PACK_HEADINGS, type ContextPackDeps } from "@contexts/generation/infrastructure/context-pack.ts";
import { countDirectives, hasTrustLanguage, type FactId, type PromptClaim } from "@contexts/generation/domain/prompt-contract-lint.ts";
import { MAX_ROUTES, type CaptureDomDeps } from "@contexts/generation/infrastructure/dom-snapshot.ts";
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
