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
function locator() {
  return {
    ariaSnapshot: async () => page.aria || "",
    first() { return locator(); },
    innerText: async () => page.text || "",
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
            return {
              on() {},
              async goto(target) { url = target; record({ goto: target }); },
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
