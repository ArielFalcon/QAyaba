/*
 * The one-shot child that tries an app's login before generation, without an agent. It opens a
 * bounded ladder of pages, picks the login form by its structure (never by label text), types the
 * account into it, submits it ONCE, watches what the submit did, and prints what it saw as one JSON
 * evidence line. Classifying that evidence is `classifyLoginEvidence`'s job; this script only observes.
 *
 * Credentials reach the child through its env alone (DEV_TEST_USER / DEV_TEST_PASS); the script's
 * source and its stdout hold none. Everything else (base URL, routes, budgets, the session path)
 * arrives as JSON in PW_LOGIN_INPUT. The child never fills or submits on a page whose origin is not
 * the app's, never submits twice, and asks the browser for no trace, screenshot, video or HAR. The
 * one in-page reader returns plain data.
 * This module is a protected path: a change here decides where the account is typed.
 */

import { FORM_STATE, MAX_RENDERED_REQUESTS } from "../../domain/helpers/login-evidence.ts";

/** The paths tried last, after everything the app itself pointed at. */
export const LOGIN_WELL_KNOWN_PATHS: readonly string[] = ["/login", "/signin", "/sign-in", "/auth/login", "/#/login"];
/** How many of the app's gated routes the ladder follows; each may redirect to the login page. */
export const MAX_GATED_ROUTES = 3;
/** The least the child waits for the password field to go after the submit: the stock seed's own wait. A slower DEV widens it through the action timeout. */
export const POST_SUBMIT_MIN_WAIT_MS = 8_000;

const DEFAULT_NAV_TIMEOUT_MS = 10_000;
const DEFAULT_SETTLE_MS = 5_000;
/* The attribute the page reader tags each input and button with, so the Node side addresses exactly the elements it was told about. */
const FIELD_ATTRIBUTE = "data-qa-login-field";
/* The kinds of request a login travels in: a script's call or a form post. Beacons, images and scripts are not the login. */
const LOGIN_REQUEST_TYPES = ["xhr", "fetch", "document"];

export function buildLoginDiscoveryScript(playwrightRequirePath = "playwright"): string {
  return String.raw`const { chromium } = require(${JSON.stringify(playwrightRequirePath)});
const input = JSON.parse(process.env.PW_LOGIN_INPUT || "{}");
const user = process.env.DEV_TEST_USER || "";
const pass = process.env.DEV_TEST_PASS || "";
const FORM = ${JSON.stringify(FORM_STATE)};
const WELL_KNOWN = ${JSON.stringify(LOGIN_WELL_KNOWN_PATHS)};
const MAX_GATED_ROUTES = ${MAX_GATED_ROUTES};
const FIELD_ATTRIBUTE = ${JSON.stringify(FIELD_ATTRIBUTE)};
const MAX_REQUESTS = ${MAX_RENDERED_REQUESTS};
const LOGIN_REQUEST_TYPES = ${JSON.stringify(LOGIN_REQUEST_TYPES)};
const NAV_TIMEOUT_MS = input.navTimeoutMs || ${DEFAULT_NAV_TIMEOUT_MS};
const SETTLE_MS = input.settleMs || ${DEFAULT_SETTLE_MS};
const POST_SUBMIT_WAIT_MS = Math.max(${POST_SUBMIT_MIN_WAIT_MS}, Number(input.actionTimeoutMs) || 0);
const USER_FIELD_TYPES = ["text", "email", "tel"];
const LOGIN_LINK_HINT = /log ?in|sign ?in|sign ?on/i;
const baseOrigin = new URL(input.baseUrl).origin;

/* Every way a URL, a form body, a JSON body or an HTML page can spell the account back; a text passes through here before it can leave. */
const secrets = [user, pass].filter(function (secret) { return secret.length > 0; });
function spellings(secret) {
  const json = JSON.stringify(secret).slice(1, -1);
  const form = encodeURIComponent(secret).replace(/%20/g, "+");
  const html = secret.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const jsonHtmlSafe = json.replace(/[&<>]/g, function (c) { return "\\u00" + c.charCodeAt(0).toString(16).padStart(2, "0"); });
  return [secret, encodeURIComponent(secret), encodeURI(secret), form, json, json.replace(/\//g, "\\/"), jsonHtmlSafe, html, secret.normalize("NFC"), secret.normalize("NFD")];
}
const escapeForRegExp = function (text) { return text.replace(/[.*+?^$|(){}\[\]\\\/]/g, "\\$&"); };
const SECRET_PATTERN = secrets.length === 0 ? null : new RegExp(
  Array.from(new Set(secrets.flatMap(spellings))).sort(function (a, b) { return b.length - a.length; }).map(escapeForRegExp).join("|"),
  "giu",
);
const scrub = function (text) { return SECRET_PATTERN === null ? String(text) : String(text).replace(SECRET_PATTERN, "[redacted]"); };

const emit = function (line) { process.stdout.write(JSON.stringify(line) + "\n"); };

function emptyEvidence() {
  return {
    ladder: [], form: FORM.ABSENT, ladderHadPasswordField: false, markers: { captcha: false, sso: false },
    challengeVisible: false, secondFactorVisible: false, filled: false, submitted: false, requests: [],
    inFlightAtDeadline: false, pageErrorCount: 0, firstPageError: null, newExceptionAfterSubmit: false, firstNewException: null,
    firstAlert: null, submitDisabled: false, finalPath: "/", passwordGone: false, freshContextChecked: false,
    freshContextPasswordGone: false, storageStateWritten: false,
  };
}

/* Runs in the page. Takes only the name of the attribute to tag elements with and returns plain data: what each input and button is, never what it holds. */
function describePage(attribute) {
  const visible = function (el) {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  };
  const all = function (selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); };
  const forms = Array.prototype.slice.call(document.forms);
  const fields = all("input, button").map(function (el, i) {
    el.setAttribute(attribute, String(i));
    return {
      i: i,
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute("type") || (el.tagName === "BUTTON" ? "submit" : "text")).toLowerCase(),
      visible: visible(el),
      disabled: el.disabled === true || el.readOnly === true,
      form: el.form ? forms.indexOf(el.form) : -1,
    };
  });
  const links = all("a[href]").slice(0, 50).map(function (a) {
    return { href: a.getAttribute("href"), text: (a.textContent || "").trim().slice(0, 60) };
  });
  /* A challenge widget by its provider's own element; the floating badge of an invisible one is not a challenge. */
  const widgets = all('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare"], .g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]');
  const captcha = { present: widgets.length > 0, visible: widgets.some(function (el) { return !el.closest(".grecaptcha-badge") && visible(el); }) };
  return { fields: fields, links: links, captcha: captcha, secondFactorVisible: all('input[autocomplete="one-time-code"]').some(visible) };
}

/* Runs in the page, polled until true: no password field is showing. */
function noVisiblePassword() {
  return Array.prototype.slice.call(document.querySelectorAll('input[type="password"]')).every(function (el) {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return !(box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none");
  });
}

/* The first form with exactly one visible password field. Two or more make a form ambiguous (a sign-up or a change of password). */
function pickLoginForm(fields) {
  const groups = [];
  fields.forEach(function (field) {
    if (field.tag !== "input" || field.type !== "password" || !field.visible) return;
    const group = groups.find(function (candidate) { return candidate.form === field.form; });
    if (group) group.passwords.push(field);
    else groups.push({ form: field.form, passwords: [field] });
  });
  const lone = groups.find(function (group) { return group.passwords.length === 1; });
  if (lone) return { state: FORM.FOUND, password: lone.passwords[0] };
  return { state: groups.length > 0 ? FORM.AMBIGUOUS : FORM.ABSENT };
}

/* The nearest visible, editable text-like input before the password, in the same form: label text plays no part. */
function pickUserField(fields, password) {
  const before = fields.filter(function (field) {
    return field.tag === "input" && field.form === password.form && field.i < password.i && field.visible && !field.disabled && USER_FIELD_TYPES.indexOf(field.type) >= 0;
  });
  return before[before.length - 1];
}

/* The form's own way to submit: the first visible, enabled submit button (or submit input) after the password in the same form. */
function pickSubmitControl(fields, password) {
  return fields.find(function (field) {
    return field.form === password.form && field.i > password.i && field.type === "submit" && field.visible && !field.disabled;
  });
}

function resolveStep(step, from) {
  let url;
  try { url = new URL(step, from); } catch (_invalid) { return null; }
  return url.origin === baseOrigin ? url : null;
}
const keyOf = function (url) { return url.pathname + url.hash; };
const noPasswordShowing = function (fields) {
  return !fields.some(function (field) { return field.tag === "input" && field.type === "password" && field.visible; });
};

function pickLoginLink(links, from) {
  for (const link of links) {
    if (!LOGIN_LINK_HINT.test(link.href) && !LOGIN_LINK_HINT.test(link.text)) continue;
    const url = resolveStep(link.href, from);
    if (url) return keyOf(url);
  }
  return null;
}

/* What the network does around the submit: the non-GET requests a login travels in, and whether any is still unanswered. Attached before the first navigation. */
function watch(page) {
  const state = { phase: "before", tracked: new Map(), inFlight: new Set(), requests: [] };
  page.on("request", function (request) {
    if (state.phase !== "after" || request.method() === "GET" || LOGIN_REQUEST_TYPES.indexOf(request.resourceType()) < 0) return;
    const entry = { method: request.method(), pathname: new URL(request.url()).pathname, status: null };
    state.requests.push(entry);
    state.tracked.set(request, entry);
    state.inFlight.add(request);
  });
  page.on("response", function (response) {
    const entry = state.tracked.get(response.request());
    if (entry) { entry.status = response.status(); state.inFlight.delete(response.request()); }
  });
  page.on("requestfailed", function (request) { state.inFlight.delete(request); });
  return state;
}

/* Reads a page's structure; a page that navigates under the read is read again once it has settled. */
async function readPage(page) {
  try { return await page.evaluate(describePage, FIELD_ATTRIBUTE); } catch (_moving) {
    await page.waitForLoadState("domcontentloaded", { timeout: SETTLE_MS }).catch(function () {});
    return page.evaluate(describePage, FIELD_ATTRIBUTE);
  }
}

/* Where the browser ended: its own path on the app's origin, else the last page the ladder asked for (a foreign address is not ours to report). */
function finalPathOf(page, evidence) {
  const now = new URL(page.url());
  return now.origin === baseOrigin ? keyOf(now) : evidence.ladder[evidence.ladder.length - 1] || "/";
}

/* Opens the ladder in order and stops at the first page with a login form. A page that ends on another origin is never inspected. */
async function findLoginForm(page, evidence) {
  const steps = [];
  if (input.loginPath) steps.push(input.loginPath);
  steps.push("/");
  (input.routes || []).slice(0, MAX_GATED_ROUTES).forEach(function (route) { steps.push(route); });
  WELL_KNOWN.forEach(function (path) { steps.push(path); });
  const visited = new Set();
  let linkTried = false;
  let ambiguous = false;
  for (let n = 0; n < steps.length; n++) {
    const url = resolveStep(steps[n], input.baseUrl);
    if (!url || visited.has(keyOf(url))) continue;
    visited.add(keyOf(url));
    evidence.ladder.push(keyOf(url));
    try {
      await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(function () {});
    } catch (_unreachable) { continue; }
    const landed = new URL(page.url());
    if (landed.origin !== baseOrigin) continue;
    const seen = await readPage(page);
    if (seen.fields.some(function (field) { return field.tag === "input" && field.type === "password"; })) evidence.ladderHadPasswordField = true;
    const pick = pickLoginForm(seen.fields);
    if (pick.state === FORM.FOUND) {
      evidence.form = FORM.FOUND;
      return { fields: seen.fields, password: pick.password };
    }
    if (pick.state === FORM.AMBIGUOUS) ambiguous = true;
    if (!linkTried && keyOf(url) === "/") {
      linkTried = true;
      const link = pickLoginLink(seen.links, landed);
      if (link) steps.splice(n + 1, 0, link);
    }
  }
  evidence.form = ambiguous ? FORM.AMBIGUOUS : FORM.ABSENT;
  return null;
}

/* The hard guard: whatever the ladder found, one attempt is all a phase gets. The marker goes out before the action so a crash still shows a submit was made. */
let submitCount = 0;
async function submitOnce(action, evidence, watching) {
  if (submitCount >= 1) return;
  submitCount += 1;
  watching.phase = "after";
  emit({ marker: "submitted" });
  evidence.submitted = true;
  await action();
}

/* One action: Enter in the password field when the field sits in a form (which submits it), else the form-less field's own submit control; with neither, nothing is submitted. */
async function fillAndSubmit(page, found, evidence, watching) {
  const userField = pickUserField(found.fields, found.password);
  if (!userField) return;
  const at = function (field) { return page.locator("[" + FIELD_ATTRIBUTE + '="' + field.i + '"]'); };
  await at(userField).fill(user);
  await at(found.password).fill(pass);
  evidence.filled = (await at(userField).inputValue()) === user && (await at(found.password).inputValue()) === pass;
  if (!evidence.filled) return;
  if (found.password.form >= 0) return submitOnce(async function () { await at(found.password).press("Enter"); }, evidence, watching);
  const control = pickSubmitControl(found.fields, found.password);
  if (control) return submitOnce(async function () { await at(control).click(); }, evidence, watching);
}

/* Waits for the password field to go, then reads the page once more: what the submit sent, what the page shows and what it threw. */
async function observeSubmit(page, evidence, found, watching) {
  await page.waitForFunction(noVisiblePassword, undefined, { timeout: POST_SUBMIT_WAIT_MS }).catch(function () {});
  evidence.inFlightAtDeadline = watching.inFlight.size > 0;
  const after = await readPage(page);
  evidence.requests = watching.requests.slice().sort(function (a, b) {
    return (a.method + " " + a.pathname + " " + a.status).localeCompare(b.method + " " + b.pathname + " " + b.status);
  }).slice(0, MAX_REQUESTS);
  evidence.passwordGone = noPasswordShowing(after.fields);
  if (after.captcha.present) evidence.markers.captcha = true;
  evidence.challengeVisible = after.captcha.visible;
  evidence.secondFactorVisible = after.secondFactorVisible;
  evidence.submitDisabled = !evidence.passwordGone && after.fields.some(function (field) { return field.form === found.password.form && field.type === "submit" && field.disabled; });
  evidence.finalPath = finalPathOf(page, evidence);
}

(async function () {
  const evidence = emptyEvidence();
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    const watching = watch(page);
    const found = await findLoginForm(page, evidence);
    if (found) await fillAndSubmit(page, found, evidence, watching);
    if (evidence.submitted) await observeSubmit(page, evidence, found, watching);
    else evidence.finalPath = finalPathOf(page, evidence);
    emit({ evidence: evidence });
  } catch (error) {
    process.stderr.write(scrub(error && error.message ? error.message : error) + "\n");
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(function () {});
  }
})();
`;
}
