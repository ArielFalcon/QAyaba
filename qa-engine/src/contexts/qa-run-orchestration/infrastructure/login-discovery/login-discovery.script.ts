/*
 * The one-shot child that tries an app's login before generation, without an agent. It opens a
 * bounded ladder of pages, picks the login form by its structure (never by label text), types the
 * account into it, submits it ONCE, watches what the submit did, and prints what it saw as one JSON
 * evidence line. Classifying that evidence is `classifyLoginEvidence`'s job; this script only observes.
 * It lists as the login's requests only those that started after the submit and carry the account.
 * Every wait it sets is cut to what is left before a fixed deadline, so it always prints its evidence before
 * the runner's hard kill, and a session it could not confirm is reported, never lost with the evidence.
 *
 * Credentials reach the child through its env alone (DEV_TEST_USER / DEV_TEST_PASS); the script's
 * source and its stdout hold none. Everything else (base URL, routes, budgets, the session path)
 * arrives as JSON in PW_LOGIN_INPUT. The child never fills or submits on a page whose origin is not
 * the app's (checked after every read of a page, before each field is typed and before the submit, and a
 * form or base address that points elsewhere is no login form), never submits twice, and asks the
 * browser for no trace, screenshot, video or HAR. Every
 * text it lets out (a page error, an alert, an exception) is scrubbed of the account by exact value in
 * every spelling BEFORE it is cut to its bound. The one in-page reader returns plain data.
 * This module is a protected path: a change here decides where the account is typed.
 */

import { EVIDENCE_TEXT_MAX, FORM_STATE, MAX_RENDERED_REQUESTS } from "../../domain/helpers/login-evidence.ts";
import { DESCRIBE_PAGE_SOURCE, INSTALL_SUBMIT_WATCH_SOURCE, NO_VISIBLE_PASSWORD_SOURCE, SUBMIT_WATCH_FIRED_SOURCE } from "./login-discovery.page-readers.ts";

/** The paths tried last, after everything the app itself pointed at. */
export const LOGIN_WELL_KNOWN_PATHS: readonly string[] = ["/login", "/signin", "/sign-in", "/auth/login", "/#/login"];
/** How many of the app's gated routes the ladder follows; each may redirect to the login page. */
export const MAX_GATED_ROUTES = 3;
/** The least the child waits for the password field to go after the submit: the stock seed's own wait. A slower DEV widens it through the action timeout. */
export const POST_SUBMIT_MIN_WAIT_MS = 8_000;
/** What the ladder may spend finding and submitting the form before the child stops looking. */
export const DEFAULT_LADDER_BUDGET_MS = 45_000;

/** How long one page navigation may take unless the action timeout says the app is slower. */
export const DEFAULT_NAV_TIMEOUT_MS = 10_000;
/** By when, counted from the child's start, it has stopped waiting on anything and prints its evidence: the hard kill is never what ends it. */
export const CHILD_DEADLINE_MS = 60_000;
const DEFAULT_SETTLE_MS = 5_000;
/* What one typed field, one read-back or one key press may take unless the action timeout says the app is slower. */
export const DEFAULT_ACTION_CALL_MS = 10_000;
/* The attribute the page reader tags each input and button with, so the Node side addresses exactly the elements it was told about. */
const FIELD_ATTRIBUTE = "data-qa-login-field";
/* The kinds of request a login travels in: a script's call or a form post. Beacons, images and scripts are not the login. */
const LOGIN_REQUEST_TYPES = ["xhr", "fetch", "document"];

export function buildLoginDiscoveryScript(playwrightRequirePath = "playwright"): string {
  return String.raw`const { chromium } = require(${JSON.stringify(playwrightRequirePath)});
const fs = require("node:fs");
const input = JSON.parse(process.env.PW_LOGIN_INPUT || "{}");
const user = process.env.DEV_TEST_USER || "";
const pass = process.env.DEV_TEST_PASS || "";
const FORM = ${JSON.stringify(FORM_STATE)};
const WELL_KNOWN = ${JSON.stringify(LOGIN_WELL_KNOWN_PATHS)};
const MAX_GATED_ROUTES = ${MAX_GATED_ROUTES};
const FIELD_ATTRIBUTE = ${JSON.stringify(FIELD_ATTRIBUTE)};
const TEXT_MAX = ${EVIDENCE_TEXT_MAX};
const MAX_REQUESTS = ${MAX_RENDERED_REQUESTS};
const LOGIN_REQUEST_TYPES = ${JSON.stringify(LOGIN_REQUEST_TYPES)};
const ACTION_TIMEOUT_MS = Number(input.actionTimeoutMs) || 0;
const NAV_TIMEOUT_MS = input.navTimeoutMs || ${DEFAULT_NAV_TIMEOUT_MS};
const SETTLE_MS = input.settleMs || ${DEFAULT_SETTLE_MS};
const BUDGET_MS = input.budgetMs === undefined ? ${DEFAULT_LADDER_BUDGET_MS} : input.budgetMs;
const POST_SUBMIT_WAIT_MS = Math.max(input.postSubmitMinWaitMs === undefined ? ${POST_SUBMIT_MIN_WAIT_MS} : Number(input.postSubmitMinWaitMs), ACTION_TIMEOUT_MS);
const VERIFY_NAV_TIMEOUT_MS = Math.max(NAV_TIMEOUT_MS, ACTION_TIMEOUT_MS);
const VERIFY_POLL_MS = Math.max(SETTLE_MS, ACTION_TIMEOUT_MS);
const ACTION_CALL_MS = Math.max(${DEFAULT_ACTION_CALL_MS}, ACTION_TIMEOUT_MS);
const USER_FIELD_TYPES = ["text", "email", "tel"];
const LOGIN_LINK_HINT = /log ?in|sign ?in|sign ?on/i;
const baseOrigin = new URL(input.baseUrl).origin;
const startedAt = Date.now();
/* Every wait is cut to what is left before the deadline, so no action timeout, however large, lets the child outlive the hard kill. A timeout of zero means no limit to the browser: never ask for one. */
const deadlineAt = startedAt + (input.deadlineMs === undefined ? ${CHILD_DEADLINE_MS} : Number(input.deadlineMs));
const room = function (ms) { return Math.max(1, Math.min(ms, deadlineAt - Date.now())); };

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
/* The same spellings, asked as a question: does this text carry the account? */
const ACCOUNT_PATTERN = SECRET_PATTERN === null ? null : new RegExp(SECRET_PATTERN.source, "iu");
const carriesAccount = function (text) { return ACCOUNT_PATTERN !== null && typeof text === "string" && ACCOUNT_PATTERN.test(text); };
/* The account comes out of the WHOLE text first (a secret may span lines), then the first line stands for it, its URLs lose their queries, and the cut comes last. */
const noteText = function (text) { return scrub(text).split("\n")[0].replace(/https?:\/\/\S+/g, "<url>").slice(0, TEXT_MAX); };
/* What makes two exceptions the same one: the first line without its error name (a console text and a page error then read alike), with its URLs, GUIDs, hex ids of six or more characters, tokens that mix letters and digits (an id, from four characters) and numbers normalized. */
const signature = function (text) {
  return String(text).split("\n")[0]
    .replace(/^(?:Uncaught\s+)?(?:[A-Za-z_$][\w$.]*)?(?:Error|Exception):\s*/, "")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{4,}\b/g, "<id>")
    .replace(/\b[0-9a-f]{6,}\b/gi, "<id>")
    .replace(/\d+/g, "#")
    .trim();
};

const emit = function (line) { process.stdout.write(JSON.stringify(line) + "\n"); };

function emptyEvidence() {
  return {
    ladder: [], form: FORM.ABSENT, ladderHadPasswordField: false, markers: { captcha: false, sso: false },
    challengeVisible: false, secondFactorVisible: false, filled: false, submitted: false, submitEventFired: false, requests: [],
    inFlightAtDeadline: false, pageErrorCount: 0, firstPageError: null, newExceptionAfterSubmit: false, firstNewException: null,
    firstAlert: null, submitDisabled: false, finalPath: "/", passwordGone: false, freshContextChecked: false,
    freshContextPasswordGone: false, storageStateWritten: false,
  };
}

/* Run in the page: see login-discovery.page-readers.ts. */
${DESCRIBE_PAGE_SOURCE}

${NO_VISIBLE_PASSWORD_SOURCE}

${INSTALL_SUBMIT_WATCH_SOURCE}

${SUBMIT_WATCH_FIRED_SOURCE}

/* A form (or, with no form, the page) whose submissions and script requests stay on the app's own origin: a base address or an action that leaves it makes the page no place to type the account. */
function staysHome(seen, formIndex) {
  return seen.baseSameOrigin === true && (formIndex < 0 || (seen.forms[formIndex] !== undefined && seen.forms[formIndex].sameOrigin === true));
}

/* The first form with exactly one visible password field. Two or more make a form ambiguous (a sign-up or a change of password). */
function pickLoginForm(seen) {
  const groups = [];
  seen.fields.forEach(function (field) {
    if (field.tag !== "input" || field.type !== "password" || !field.visible || !staysHome(seen, field.form)) return;
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

/* A ladder step is a string (resolved against where it came from) or an address already parsed: a parsed one is never read as text again, so a path that starts with two slashes cannot turn into a host. */
function resolveStep(step, from) {
  let url;
  try { url = step instanceof URL ? step : new URL(step, from); } catch (_invalid) { return null; }
  return url.origin === baseOrigin ? url : null;
}
const keyOf = function (url) { return url.pathname + url.hash; };
/* The address the browser is on belongs to the app: read at every moment something is typed or sent. */
const onAppOrigin = function (page) { return new URL(page.url()).origin === baseOrigin; };
const noPasswordShowing = function (fields) {
  return !fields.some(function (field) { return field.tag === "input" && field.type === "password" && field.visible; });
};

function pickLoginLink(links, from) {
  for (const link of links) {
    if (!LOGIN_LINK_HINT.test(link.href) && !LOGIN_LINK_HINT.test(link.text)) continue;
    const url = resolveStep(link.href, from);
    if (url) return url;
  }
  return null;
}

/* The browser context options: the dev gate's credentials scoped to the app's own origin, and nothing that records. */
function contextOptions(extra) {
  const options = Object.assign({}, extra);
  if (process.env.DEV_ENV_USER) options.httpCredentials = { username: process.env.DEV_ENV_USER, password: process.env.DEV_ENV_PASS || "", origin: baseOrigin };
  return options;
}

/* What the page and the network do around the submit. Attached before the first navigation so what was already going wrong is on record. */
function watch(page, evidence) {
  const state = { phase: "before", seenBefore: new Set(), pending: [], tracked: new Map(), inFlight: new Set(), requests: [], alertsBefore: new Set() };
  const exception = function (kind, text, phase) {
    if (phase === "before") { state.seenBefore.add(signature(text)); return; }
    if (kind === "pageerror") {
      evidence.pageErrorCount += 1;
      if (evidence.firstPageError === null) evidence.firstPageError = noteText(text);
    }
    if (!evidence.newExceptionAfterSubmit && !state.seenBefore.has(signature(text))) {
      evidence.newExceptionAfterSubmit = true;
      evidence.firstNewException = noteText(text);
    }
  };
  /* A console error counts only when one of its arguments is an Error object: plain text (a validation message) never does. */
  const carriesError = async function (message) {
    for (const arg of message.args()) {
      try { if (await arg.evaluate(function (value) { return value instanceof Error; })) return true; } catch (_gone) {}
    }
    return false;
  };
  page.on("pageerror", function (error) { exception("pageerror", error && error.message ? error.message : error, state.phase); });
  page.on("console", function (message) {
    if (message.type() !== "error") return;
    const phase = state.phase;
    state.pending.push(carriesError(message).then(function (yes) { if (yes) exception("console", message.text(), phase); }, function () {}));
  });
  /* A request is the login's when it starts after the submit and carries the account, in its address or its body. A native form that GETs puts the account in the address of a top-frame navigation. Everything else in the window (telemetry, a refresh, a poll) is the app's own traffic. */
  const isTopFrameNavigation = function (request) {
    /* A service worker's request has no frame to ask about, and is not a form submitting. */
    try { return request.isNavigationRequest() && request.frame().parentFrame() === null; } catch (_gone) { return false; }
  };
  const isTheLogin = function (request) {
    const address = new URL(request.url());
    const carriesInAddress = carriesAccount(address.pathname + address.search);
    return request.method() === "GET" ? isTopFrameNavigation(request) && carriesInAddress : carriesInAddress || carriesAccount(request.postData());
  };
  page.on("request", function (request) {
    if (state.phase !== "after" || LOGIN_REQUEST_TYPES.indexOf(request.resourceType()) < 0) return;
    const attributed = isTheLogin(request);
    if (request.method() === "GET" && !attributed) return;
    const entry = { method: request.method(), pathname: new URL(request.url()).pathname, status: null, attributed: attributed };
    state.requests.push(entry);
    if (!attributed) return;
    state.tracked.set(request, entry);
    state.inFlight.add(request);
  });
  const answered = function (request) {
    state.inFlight.delete(request);
    if (state.inFlight.size === 0 && state.onDrained) state.onDrained();
  };
  page.on("response", function (response) {
    const entry = state.tracked.get(response.request());
    if (entry) { entry.status = response.status(); answered(response.request()); }
  });
  page.on("requestfailed", function (request) { answered(request); });
  /* Resolves once none of the login's requests is in flight, or when the time is up, whichever comes first. */
  state.drained = function (ms) {
    if (state.inFlight.size === 0) return Promise.resolve();
    return new Promise(function (resolve) {
      const finish = function () { clearTimeout(timer); state.onDrained = null; resolve(); };
      const timer = setTimeout(finish, Math.max(0, ms));
      state.onDrained = finish;
    });
  };
  state.settle = async function () { while (state.pending.length > 0) await state.pending.shift(); };
  return state;
}

/* Reads a page's structure; a page that navigates under the read is read again once it has settled. A page that stands on another origin once it was read is not the app's and yields nothing. */
async function readPage(page) {
  let seen;
  try { seen = await page.evaluate(describePage, FIELD_ATTRIBUTE); } catch (_moving) {
    await page.waitForLoadState("domcontentloaded", { timeout: room(SETTLE_MS) }).catch(function () {});
    seen = await page.evaluate(describePage, FIELD_ATTRIBUTE);
  }
  return onAppOrigin(page) ? seen : null;
}

/* What a page that left the app's origin shows the app: nothing. */
const NOTHING_SHOWING = { fields: [], forms: [], baseSameOrigin: true, links: [], captcha: { present: false, visible: false }, alerts: [], secondFactorVisible: false };

/* Where the browser ended: its own path on the app's origin, else the last page the ladder asked for (a foreign address is not ours to report). */
function finalPathOf(page, evidence) {
  const now = new URL(page.url());
  return now.origin === baseOrigin ? keyOf(now) : evidence.ladder[evidence.ladder.length - 1] || "/";
}

/* Opens the ladder in order and stops at the first page with a login form. A page that ends on another origin is never inspected. */
async function findLoginForm(page, evidence, watching) {
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
    if (visited.size > 0 && Date.now() - startedAt >= BUDGET_MS) break;
    visited.add(keyOf(url));
    evidence.ladder.push(keyOf(url));
    try {
      await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: room(NAV_TIMEOUT_MS) });
      await page.waitForLoadState("networkidle", { timeout: room(SETTLE_MS) }).catch(function () {});
    } catch (_unreachable) { continue; }
    const landed = new URL(page.url());
    if (landed.origin !== baseOrigin) continue;
    const seen = await readPage(page);
    if (seen === null) continue;
    if (seen.fields.some(function (field) { return field.tag === "input" && field.type === "password"; })) evidence.ladderHadPasswordField = true;
    const pick = pickLoginForm(seen);
    if (pick.state === FORM.FOUND) {
      evidence.form = FORM.FOUND;
      seen.alerts.forEach(function (text) { watching.alertsBefore.add(text); });
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
async function submitOnce(page, action, evidence, watching) {
  if (submitCount >= 1) return;
  submitCount += 1;
  await watching.settle();
  if (!onAppOrigin(page)) return;
  await page.evaluate(installSubmitWatch);
  if (!onAppOrigin(page)) return;
  watching.phase = "after";
  emit({ marker: "submitted" });
  evidence.submitted = true;
  watching.submittedAt = Date.now();
  await action();
}

/* One action: Enter in the password field when the field sits in a form (which submits it), else the form-less field's own submit control; with neither, nothing is submitted. */
async function fillAndSubmit(page, found, evidence, watching) {
  const userField = pickUserField(found.fields, found.password);
  if (!userField) return;
  const at = function (field) { return page.locator("[" + FIELD_ATTRIBUTE + '="' + field.i + '"]'); };
  if (!onAppOrigin(page)) return;
  await at(userField).fill(user, { timeout: room(ACTION_CALL_MS) });
  if (!onAppOrigin(page)) return;
  await at(found.password).fill(pass, { timeout: room(ACTION_CALL_MS) });
  evidence.filled = (await at(userField).inputValue({ timeout: room(ACTION_CALL_MS) })) === user && (await at(found.password).inputValue({ timeout: room(ACTION_CALL_MS) })) === pass;
  if (!evidence.filled) return;
  if (found.password.form >= 0) return submitOnce(page, async function () { await at(found.password).press("Enter", { timeout: room(ACTION_CALL_MS) }); }, evidence, watching);
  const control = pickSubmitControl(found.fields, found.password);
  if (control) return submitOnce(page, async function () { await at(control).click({ timeout: room(ACTION_CALL_MS) }); }, evidence, watching);
}

/* Opens a fresh context with the saved session at the path the submit ended on and reads it once the password field has had time to go (an app may draw its form before its session is read). */
async function verifyInFreshContext(browser, now, evidence) {
  const fresh = await browser.newContext(contextOptions({ storageState: input.storageStatePath }));
  try {
    const freshPage = await fresh.newPage();
    const target = new URL(baseOrigin);
    target.pathname = now.pathname;
    target.hash = now.hash;
    await freshPage.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: room(VERIFY_NAV_TIMEOUT_MS) });
    await freshPage.waitForLoadState("networkidle", { timeout: room(SETTLE_MS) }).catch(function () {});
    if (!onAppOrigin(freshPage)) return;
    await freshPage.waitForFunction(noVisiblePassword, undefined, { timeout: room(VERIFY_POLL_MS) }).catch(function () {});
    const freshSeen = await readPage(freshPage);
    if (freshSeen === null) return;
    evidence.freshContextChecked = true;
    evidence.freshContextPasswordGone = noPasswordShowing(freshSeen.fields);
  } finally {
    await fresh.close().catch(function () {});
  }
}

/* A failure to confirm the session is reported on stderr, with the account removed, and leaves it unconfirmed: it never costs the evidence already gathered. */
const reportVerificationFailure = function (error) {
  process.stderr.write("session verification failed: " + scrub(error && error.message ? error.message : error) + "\n");
};

/* Saves the session and verifies it in a fresh context, once more when that fails. */
async function saveAndVerify(context, browser, now, evidence) {
  try {
    await context.storageState({ path: input.storageStatePath });
    evidence.storageStateWritten = fs.existsSync(input.storageStatePath);
  } catch (error) {
    reportVerificationFailure(error);
    return;
  }
  if (!evidence.storageStateWritten) return;
  let failure = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await verifyInFreshContext(browser, now, evidence);
      return;
    } catch (error) {
      failure = error;
    }
  }
  reportVerificationFailure(failure);
}

/* Waits for the password field to go, reads the page once more, and, when it went, gives the login's own requests time to answer, saves the session and reads a fresh context opened with it. */
async function observeSubmit(page, context, browser, evidence, found, watching) {
  await page.waitForFunction(noVisiblePassword, undefined, { timeout: room(POST_SUBMIT_WAIT_MS) }).catch(function () {});
  await watching.settle();
  const after = (await readPage(page)) || NOTHING_SHOWING;
  evidence.passwordGone = noPasswordShowing(after.fields);
  /* The password field going says nothing of the session until the login's own requests have answered: give them what is left of the window. */
  if (evidence.passwordGone) await watching.drained(Math.min(POST_SUBMIT_WAIT_MS - (Date.now() - watching.submittedAt), deadlineAt - Date.now()));
  const now = new URL(page.url());
  evidence.inFlightAtDeadline = watching.inFlight.size > 0;
  evidence.submitEventFired = await page.evaluate(submitWatchFired).catch(function () { return false; });
  evidence.requests = watching.requests.filter(function (entry) { return entry.attributed; }).map(function (entry) {
    return { method: entry.method, pathname: entry.pathname, status: entry.status };
  }).sort(function (a, b) {
    return (a.method + " " + a.pathname + " " + a.status).localeCompare(b.method + " " + b.pathname + " " + b.status);
  }).slice(0, MAX_REQUESTS);
  if (after.captcha.present) evidence.markers.captcha = true;
  evidence.challengeVisible = after.captcha.visible;
  evidence.secondFactorVisible = after.secondFactorVisible;
  const alert = after.alerts.find(function (text) { return !watching.alertsBefore.has(text); });
  evidence.firstAlert = alert === undefined ? null : noteText(alert);
  evidence.submitDisabled = !evidence.passwordGone && after.fields.some(function (field) { return field.form === found.password.form && field.type === "submit" && field.disabled; });
  evidence.finalPath = finalPathOf(page, evidence);
  if (!evidence.passwordGone || now.origin !== baseOrigin) return;
  await saveAndVerify(context, browser, now, evidence);
}

(async function () {
  const evidence = emptyEvidence();
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext(contextOptions({}));
    const page = await context.newPage();
    const watching = watch(page, evidence);
    const found = await findLoginForm(page, evidence, watching);
    if (found) await fillAndSubmit(page, found, evidence, watching);
    if (evidence.submitted) await observeSubmit(page, context, browser, evidence, found, watching);
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
