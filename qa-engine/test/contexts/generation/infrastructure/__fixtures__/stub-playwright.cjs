/* A stand-in for the `playwright` package: records what the capture script asks of it and answers from the page described by STUB_PAGE. */
const fs = require("node:fs");
const page = JSON.parse(process.env.STUB_PAGE || "{}");
const record = (event) => { if (process.env.STUB_RECORD) fs.appendFileSync(process.env.STUB_RECORD, JSON.stringify(event) + "\n"); };
const anchors = (page.anchors || []).map((href) => ({ href }));
const elements = (page.elements || []).map((spec) => ({
  tagName: (spec.tag || "div").toUpperCase(),
  parentElement: null,
  getAttribute(name) {
    if (name === "data-testid") return spec.testId ?? null;
    if (name === "id") return spec.id ?? null;
    return null;
  },
}));
elements.forEach((el, i) => { el.parentElement = i % 2 === 0 ? elements[i + 1] ?? null : null; });
function withDocument(run) {
  const document = {
    body: {},
    querySelectorAll(selector) {
      if (selector === "a[href]") return anchors;
      if (selector === "*") return elements;
      return [];
    },
    getElementById() { return null; },
  };
  globalThis.document = document;
  try { return run(); } finally { delete globalThis.document; }
}
/* `ariaCycle` answers successive tree reads from its entries in turn (a page that keeps changing); `text` null is a result text the page does not show. */
let treeReads = 0;
function locator() {
  return {
    ariaSnapshot: async () => (page.ariaCycle ? page.ariaCycle[treeReads++ % page.ariaCycle.length] : page.aria || ""),
    first() { return locator(); },
    innerText: async (options) => {
      record({ innerText: options && options.timeout });
      if (page.text === null) throw new Error("no such element");
      return page.text || "";
    },
    count: async () => page.count || 0,
  };
}
const chromium = {
  async launch() {
    record({ launch: true });
    return {
      async newContext(options) {
        record({ newContext: options });
        return {
          async newPage() {
            let url = "about:blank";
            const handlers = {};
            return {
              on(event, handler) { (handlers[event] ||= []).push(handler); },
              /* `dataRequestInFlight`: the page starts a data request on opening and never finishes it. */
              async goto(target) {
                url = target;
                record({ goto: target });
                if (page.dataRequestInFlight) for (const handler of handlers.request || []) handler({ resourceType: () => "fetch" });
                /* `requests`: what the page asks the network on opening; one marked `failed` is then reported failed. */
                for (const spec of page.requests || []) {
                  const request = { resourceType: () => spec.type, method: () => spec.method || "GET", url: () => spec.url };
                  for (const handler of handlers.request || []) handler(request);
                  if (spec.failed) for (const handler of handlers.requestfailed || []) handler(request);
                }
                /* `responses`: the answers the page reads on opening; `body` is the JSON text the network returned (or `bodyBytes` bytes of filler), `bodyError` a body that cannot be read. */
                for (const spec of page.responses || []) {
                  const request = { resourceType: () => spec.type || "fetch", method: () => spec.method || "GET", url: () => spec.url };
                  const response = {
                    request: () => request,
                    url: () => spec.url,
                    status: () => spec.status || 200,
                    headers: () => ({ "content-type": spec.contentType || "application/json" }),
                    body: async () => {
                      if (spec.bodyError) throw new Error("no body");
                      return Buffer.from(spec.bodyBytes ? "x".repeat(spec.bodyBytes) : spec.body ?? "null");
                    },
                  };
                  for (const handler of handlers.request || []) handler(request);
                  for (const handler of handlers.response || []) handler(response);
                }
              },
              async waitForLoadState() {},
              url: () => url,
              locator,
              async waitForSelector() {},
              getByRole: () => ({ evaluateAll: async (fn, args) => withDocument(() => fn(elements, args)) }),
              evaluate: async (fn, arg) => withDocument(() => fn(arg)),
            };
          },
        };
      },
      async close() {},
    };
  },
};
module.exports = { chromium };
