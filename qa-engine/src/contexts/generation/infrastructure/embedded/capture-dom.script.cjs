// @ts-check
/* The capture of a page's DOM for the orchestrator, run as its own node process through the execution launcher (profile "suite"). Its input is PW_CAPTURE_INPUT (JSON: baseUrl, routes, probe, limits) and the PW_* / DEV_ENV_* names of its environment; its output is one JSON line per route on stdout. The page it reads is untrusted: every bound in `limits` caps what a page can make it report. PLAYWRIGHT_PATH is prepended by buildCaptureScript. */
/**
 * @typedef {{ navigationTimeoutMs: number, settleTimeoutMs: number, defaultDataStateWaitMs: number, retryDataStateWaitMs: number, maxLinksPerPage: number, maxHrefChars: number, maxRepeatedPerRoute: number, maxNamesResolved: number, maxScopeChars: number, maxScopeDepth: number }} CaptureLimits
 * @typedef {{ type: string, text: string }} RuntimeError
 * @typedef {{ readySelector?: string, resultSelector?: string, resultTextSelector?: string, locationSelector?: string, timeoutMs?: number }} DataStateSettings
 * @typedef {{ key: string, testId?: string, id?: string, name?: string, href?: string, inputType?: string, nameFallback?: string }} RawAttr
 * @typedef {{ group: string, of: number, scope: string[] }} Repeated
 */
const { chromium } = require(PLAYWRIGHT_PATH);
const { baseUrl, routes, probe: probeInput, limits } = JSON.parse(process.env.PW_CAPTURE_INPUT || "{}");
const probe = Array.isArray(probeInput) ? probeInput.filter(function(p) { return typeof p === "string"; }) : [];
const testIdAttr = process.env.PW_TEST_ID_ATTRIBUTE || "data-testid";
(async () => {
  let browser;
  try {
    browser = await chromium.launch();
    /* Gated routes: httpCredentials from DEV_ENV_USER / DEV_ENV_PASS (password may be empty). Scoped to baseUrl's origin so creds never leak to a different-origin auth provider. Gate is DEV_ENV_USER alone. App login arrives as PW_STORAGE_STATE; a software cert as PW_CLIENT_CERT_PATH. */
    const user = process.env.DEV_ENV_USER;
    const pass = process.env.DEV_ENV_PASS;
    const httpCredentials = user
      ? { username: user, password: pass ?? "", origin: new URL(baseUrl).origin }
      : undefined;
    /** @type {Record<string, unknown>} */
    const contextOptions = {};
    /* The app's browser position, when it declares one: the same names the seed's playwright.config.ts reads. */
    const geoLat = Number(process.env.PW_GEO_LAT);
    const geoLng = Number(process.env.PW_GEO_LNG);
    if (Number.isFinite(geoLat) && Number.isFinite(geoLng)) {
      contextOptions.geolocation = { latitude: geoLat, longitude: geoLng };
      contextOptions.permissions = ["geolocation"];
    }
    if (httpCredentials) contextOptions.httpCredentials = httpCredentials;
    if (process.env.PW_STORAGE_STATE) contextOptions.storageState = process.env.PW_STORAGE_STATE;
    if (process.env.PW_CLIENT_CERT_PATH) {
      contextOptions.clientCertificates = [{
        origin: new URL(baseUrl).origin,
        pfxPath: process.env.PW_CLIENT_CERT_PATH,
        passphrase: process.env.DEV_CLIENT_CERT_PASS ?? "",
      }];
    }
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    /** @type {RuntimeError[]} */
    let currentRouteErrors = [];
    page.on("pageerror", function(/** @type {any} */ err) { currentRouteErrors.push({ type: "pageerror", text: String(err && err.message || err) }); });
    page.on("console", function(/** @type {any} */ msg) { if (msg.type() === "error") currentRouteErrors.push({ type: "console", text: msg.text() }); });
    /* The app's declared data-state selectors (dev.dataState), read from the child's env: readiness/result/location per route path, keyed like the routes the capture is asked for. */
    /** @type {Record<string, DataStateSettings> | any} */
    let stateRoutes = null;
    try {
      const ds = process.env.PW_CAPTURE_DATA_STATE;
      if (ds) {
        const parsed = JSON.parse(ds);
        if (parsed && parsed.routes && typeof parsed.routes === "object") stateRoutes = parsed.routes;
      }
    } catch(_e) { stateRoutes = null; }
    /* Whether a pathname fills a key with parameters segment by segment (the orchestrator's fillsDataStateTemplate). */
    /**
     * @param {string} key
     * @param {string} path
     * @returns {boolean}
     */
    function fillsTemplate(key, path) {
      const keyParts = key.split('/').filter(function(part) { return part !== ''; });
      if (!keyParts.some(function(part) { return part.charAt(0) === ':'; })) return false;
      const parts = path.split('/').filter(function(part) { return part !== ''; });
      if (keyParts.length !== parts.length) return false;
      for (let i = 0; i < keyParts.length; i++) {
        if (keyParts[i].charAt(0) === ':') { if (keyParts[i].length < 2) return false; }
        else if (keyParts[i] !== parts[i]) return false;
      }
      return true;
    }
    /* The data-state settings of one path (the orchestrator's dataStateRouteFor): an exact key, then a key with parameters, then a key ending "/*" (a prefix and its root). */
    /**
     * @param {string | null} path
     * @returns {DataStateSettings | null}
     */
    function stateFor(path) {
      if (!path) return null;
      if (Object.prototype.hasOwnProperty.call(stateRoutes, path)) return stateRoutes[path];
      const keys = Object.keys(stateRoutes);
      for (let i = 0; i < keys.length; i++) if (fillsTemplate(keys[i], path)) return stateRoutes[keys[i]];
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key.endsWith('/*') && (path === key.slice(0, -2) || path.startsWith(key.slice(0, -1)))) return stateRoutes[key];
      }
      return null;
    }
    /* Select the data-state settings for a page: its final pathname first, then the route asked for. */
    /**
     * @param {string | null} pathname
     * @param {string} requested
     * @returns {DataStateSettings | null}
     */
    function matchState(pathname, requested) {
      if (!stateRoutes) return null;
      return stateFor(pathname) || stateFor(requested);
    }
    /* The same unconfirmed rule the orchestrator applies: a declared data state whose result stayed empty, or whose readiness never appeared. */
    /** @param {Record<string, any>} entry */
    function unconfirmed(entry) {
      if (entry.dataState !== true) return false;
      if (entry.resultExpected === true) return entry.resultCount === undefined || entry.resultCount === 0;
      return entry.ready === false;
    }
    /* One pass of a route: navigate, settle, read its data state (when one matches) and the DOM. A retry caps the data-state waits at 2s. */
    /**
     * @param {string} route
     * @param {boolean} retry
     * @returns {Promise<Record<string, any>>}
     */
    async function readRoute(route, retry) {
      currentRouteErrors = [];
      const routeStartedAt = Date.now();
      try {
        const response = await page.goto(new URL(route, baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: limits.navigationTimeoutMs });
        /* How the document arrived: its status, how many server redirects led to it and the pathname it was served at. A redirect after it loaded is the page's own (client-side). */
        /** @type {Record<string, any>} */
        const navigation = { sessionAttached: Boolean(process.env.PW_STORAGE_STATE) };
        if (response) {
          try {
            navigation.documentStatus = response.status();
            let request = response.request();
            let hops = 0;
            while (request.redirectedFrom() && hops < 20) { request = request.redirectedFrom(); hops++; }
            navigation.serverRedirects = hops;
            const documentPath = new URL(response.url()).pathname;
            if (documentPath.length <= limits.maxHrefChars) navigation.documentPath = documentPath;
          } catch(_n) { /* the navigation facts stay as far as they were read */ }
        }
        let settled = false;
        try { await page.waitForLoadState("networkidle", { timeout: limits.settleTimeoutMs }); settled = true; } catch (_settle) { /* the page never went quiet: settled stays false */ }
        const finalUrl = page.url();
        let pathname = null;
        try { pathname = new URL(finalUrl).pathname; } catch(_e) { pathname = null; }
        const settings = matchState(pathname, route);
        let ready;
        let resultExpected;
        let resultCount;
        let effectiveLocation;
        let dataState = false;
        if (settings) {
          dataState = true;
          const waitMs = retry ? Math.min(settings.timeoutMs || limits.defaultDataStateWaitMs, limits.retryDataStateWaitMs) : (settings.timeoutMs || limits.defaultDataStateWaitMs);
          const deadline = Date.now() + waitMs;
          /* Every read of the data state waits only for what is left of its wait: a read with no time of its own would wait the browser's default for an element the page never shows. */
          const left = function() { return Math.max(1, deadline - Date.now()); };
          if (settings.readySelector) {
            const left = deadline - Date.now();
            if (left <= 0) ready = false;
            else {
              try { await page.waitForSelector(settings.readySelector, { timeout: left }); ready = true; } catch(_e) { ready = false; }
            }
          }
          if (settings.resultTextSelector || settings.resultSelector) {
            resultExpected = true;
            try {
              let count;
              while (true) {
                try {
                  if (settings.resultTextSelector) {
                    const text = await page.locator(settings.resultTextSelector).first().innerText({ timeout: left() });
                    const m = (text || "").match(/-?\d+/);
                    count = m ? parseInt(m[0], 10) : undefined;
                  } else {
                    count = await page.locator(settings.resultSelector).count();
                  }
                } catch(_e) { count = undefined; }
                if (count !== undefined && count > 0) break;
                if (Date.now() >= deadline) break;
                await new Promise(function(r) { setTimeout(r, 200); });
              }
              resultCount = count;
            } catch(_e) { /* resultCount stays undefined */ }
          }
          if (settings.locationSelector) {
            try {
              const raw = await page.locator(settings.locationSelector).first().innerText({ timeout: left() });
              const cleaned = (raw || "").replace(/\s+/g, " ").trim().slice(0, 200);
              if (cleaned) effectiveLocation = cleaned;
            } catch(_e) { /* no location text: effectiveLocation stays unset */ }
          }
        }
        let yaml = await page.locator('body').ariaSnapshot();
        /* The last stable read is the tree the capture uses; settled still means networkidle succeeded, so the catalog gate stays fail-closed. */
        try {
          for (let i = 0; i < 2; i++) {
            await new Promise(function(r) { setTimeout(r, 200); });
            const next = await page.locator('body').ariaSnapshot();
            if (next === yaml) break;
            yaml = next;
          }
        } catch(_e) { /* the tree stays as the last stable read */ }
        /* After ariaSnapshot(), query interactive/labelled nodes for stable HTML attributes. Chromium-only computedRole/computedName; if it throws, attrs is empty and the run degrades to a11y-only grounding. */
        let rawAttrs = [];
        try {
          rawAttrs = await page.evaluate(function(/** @type {string} */ testIdAttrName) {
            var sel = 'a[href], button, input, select, textarea, [role], [' + testIdAttrName + '], [id], [name]';
            var els = Array.from(document.querySelectorAll(sel));
            return els.map(function(el) {
              /** @type {any} */
              var casted = el;
              var computedRole = '';
              var computedName = '';
              try { computedRole = casted.computedRole || ''; } catch(_e) { /* no computed role: the element is skipped below */ }
              try { computedName = casted.computedName || ''; } catch(_e) { /* no computed name: the key says (present) */ }
              if (!computedRole) return null;
              var key = computedRole + ': ' + (computedName || '(present)');
              /** @type {RawAttr} */
              var result = { key: key };
              var testIdVal = el.getAttribute(testIdAttrName);
              if (testIdVal) result.testId = testIdVal;
              var idVal = el.getAttribute('id');
              if (idVal) result.id = idVal;
              var nameVal = el.getAttribute('name');
              if (nameVal) result.name = nameVal;
              var href = el.getAttribute('href');
              if (href && href.startsWith('/')) result.href = href;
              var tagName = el.tagName.toLowerCase();
              if (tagName === 'input' || tagName === 'textarea') {
                var typeVal = el.getAttribute('type');
                if (typeVal && typeVal !== 'text') result.inputType = typeVal;
                if (!computedName) {
                  var placeholder = el.getAttribute('placeholder');
                  var ariaLabel = el.getAttribute('aria-label');
                  var ariaLabelledby = el.getAttribute('aria-labelledby');
                  var fallback = placeholder || ariaLabel || '';
                  if (!fallback && ariaLabelledby) {
                    var labelEl = document.getElementById(ariaLabelledby);
                    if (labelEl) fallback = (labelEl.textContent || '').trim();
                  }
                  if (fallback) result.nameFallback = fallback;
                }
              }
              if (!result.testId && !result.id && !result.name && !result.href && !result.inputType && !result.nameFallback) return null;
              return result;
            }).filter(Boolean);
          }, testIdAttr);
        } catch(_attrErr) { rawAttrs = []; }
        let testIdRawList = [];
        try {
          testIdRawList = await page.evaluate(function(/** @type {string} */ a) {
            return Array.from(document.querySelectorAll('[' + a + ']')).map(function(el) { return el.getAttribute(a); }).filter(function(v) { return v; });
          }, testIdAttr);
        } catch(_e) { testIdRawList = []; }
        /* Every link the page shows, resolved by the browser. The page decides what it shows, so the script reports only the links of the site's own origin, each within the bound, and no more than the bound: one hostile page cannot make the output too big to read for every route. */
        let hrefs = [];
        try {
          hrefs = await page.evaluate(function(/** @type {{ origin: string, maxLinks: number, maxHrefChars: number }} */ args) {
            var seen = Object.create(null);
            /** @type {string[]} */
            var found = [];
            Array.from(document.querySelectorAll('a[href]')).forEach(function(a) {
              var href = /** @type {HTMLAnchorElement} */ (a).href;
              if (found.length >= args.maxLinks || typeof href !== 'string' || href.length > args.maxHrefChars || seen[href]) return;
              seen[href] = true;
              try { if (new URL(href).origin === args.origin) found.push(href); } catch (_u) { /* not a URL: the link is not reported */ }
            });
            return found;
          }, { origin: new URL(baseUrl).origin, maxLinks: limits.maxLinksPerPage, maxHrefChars: limits.maxHrefChars });
        } catch(_e) { hrefs = []; }
        /* A name the page shows more than once for one role, case and punctuation aside (an icon glyph in the name included): for each occurrence, the containers on its way up that some other occurrence is not in, nearest first. Playwright's own role engine resolves the occurrences, as it will for a test's getByRole. A container is named by its test id, else its id, else its tag when it is a custom element; the rest name nothing a locator can reach. */
        /** @type {Repeated[]} */
        let repeated = [];
        try {
          const queried = new Set();
          const named = /^\s*- ([a-z]+) "((?:\\.|[^"\\])*)"/;
          for (const line of yaml.split("\n")) {
            if (repeated.length >= limits.maxRepeatedPerRoute || queried.size >= limits.maxNamesResolved) break;
            const m = named.exec(line);
            if (!m) continue;
            const words = m[2].replace(/\\(["\\])/g, "$1").toLowerCase().match(/[\p{L}\p{N}]+/gu);
            if (!words) continue;
            const group = m[1] + "|" + words.join(" ");
            if (queried.has(group)) continue;
            queried.add(group);
            const gap = "[^\\p{L}\\p{N}]";
            const name = new RegExp("^" + gap + "*" + words.join(gap + "+") + gap + "*$", "iu");
            const chains = await page.getByRole(m[1], { name }).evaluateAll(function(/** @type {Element[]} */ els, /** @type {{ testIdAttr: string, maxChars: number }} */ args) {
              var hook = function(/** @type {Element} */ el) {
                var t = el.getAttribute(args.testIdAttr);
                if (t) return '[' + args.testIdAttr + '="' + t.slice(0, args.maxChars) + '"]';
                var id = el.getAttribute('id');
                if (id) return '#' + id.slice(0, args.maxChars);
                var tag = el.tagName.toLowerCase();
                return tag.indexOf('-') > 0 ? tag.slice(0, args.maxChars) : null;
              };
              return els.map(function(el) {
                /** @type {string[]} */
                var chain = [];
                for (var e = el.parentElement; e && e !== document.body; e = e.parentElement) { var h = hook(e); if (h) chain.push(h); }
                return chain;
              });
            }, { testIdAttr: testIdAttr, maxChars: limits.maxScopeChars });
            if (chains.length < 2) continue;
            chains.forEach(function(/** @type {string[]} */ chain) {
              const own = chain.filter(function(/** @type {string} */ h) { return chains.some(function(/** @type {string[]} */ other) { return other.indexOf(h) === -1; }); });
              if (repeated.length < limits.maxRepeatedPerRoute) repeated.push({ group: group, of: chains.length, scope: own.slice(0, limits.maxScopeDepth) });
            });
          }
        } catch(_e) { repeated = []; }
        /* Which of the change's containers this page shows none of. */
        let absent = [];
        if (probe.length > 0) {
          try {
            absent = await page.evaluate(function(/** @type {{ testIdAttr: string, maxChars: number, probe: string[] }} */ args) {
              var hook = function(/** @type {Element} */ el) {
                var t = el.getAttribute(args.testIdAttr);
                if (t) return '[' + args.testIdAttr + '="' + t.slice(0, args.maxChars) + '"]';
                var id = el.getAttribute('id');
                if (id) return '#' + id.slice(0, args.maxChars);
                var tag = el.tagName.toLowerCase();
                return tag.indexOf('-') > 0 ? tag.slice(0, args.maxChars) : null;
              };
              var shown = Object.create(null);
              Array.from(document.querySelectorAll('*')).forEach(function(el) { var h = hook(el); if (h) shown[h] = true; });
              return args.probe.filter(function(/** @type {string} */ name) { return !shown[name]; });
            }, { testIdAttr: testIdAttr, maxChars: limits.maxScopeChars, probe: probe });
          } catch(_e) { absent = []; }
        }
        /** @type {Record<string, any>} */
        const entry = { route, yaml, rawAttrs, testIdRawList, testIdAttr, settled, runtimeErrors: currentRouteErrors, finalUrl, hrefs, repeated, absent, ms: Date.now() - routeStartedAt, ...navigation };
        if (dataState) {
          entry.dataState = true;
          if (ready !== undefined) entry.ready = ready;
          if (resultExpected !== undefined) entry.resultExpected = resultExpected;
          if (resultCount !== undefined) entry.resultCount = resultCount;
          if (effectiveLocation !== undefined) entry.effectiveLocation = effectiveLocation;
          entry.captureAttempts = retry ? 2 : 1;
        }
        return entry;
      } catch (/** @type {any} */ e) { return { route, error: String(e && e.message || e).slice(0, 200), runtimeErrors: currentRouteErrors, ms: Date.now() - routeStartedAt }; }
    }
    /* Each route is written as one JSON line as soon as it is read, so a capture killed at its time limit keeps the routes it finished. */
    for (const route of routes) {
      const first = await readRoute(route, false);
      const entry = first.dataState === true && unconfirmed(first) ? await readRoute(route, true) : first;
      await new Promise(function(r) { process.stdout.write(JSON.stringify(entry) + "\n", r); });
    }
  } catch (e) { process.stderr.write(String(e)); } finally { if (browser) await browser.close().catch(() => {}); }
})();