import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { promisify } from "node:util";
import { buildLoginDiscoveryScript } from "@contexts/qa-run-orchestration/infrastructure/login-discovery/login-discovery.script.ts";
import { classifyLoginEvidence, type LoginEvidence, type LoginOutcome } from "@contexts/qa-run-orchestration/domain/helpers/login-evidence.ts";

const execFileAsync = promisify(execFile);

/* Synthetic credentials: they exist only in the child's env. */
export const STUB_USER = "synthetic.user@demo.example";
export const STUB_PASS = "sYnth3tic pass&1";

export const STUB_ORIGIN = "https://app.stub.test";

/* What the in-page reader reports for one input or button (the shape the discovery script asks the page for). */
export interface StubField {
  i: number;
  tag: "input" | "button";
  type: string;
  visible: boolean;
  disabled: boolean;
  /** Index of the enclosing form, or -1 when the field is in none. */
  form: number;
}

export interface StubLink {
  href: string;
  text: string;
}

/** Something the page throws or logs: a page error, or a console error that carries an Error object or only text. */
export interface StubError {
  kind: "pageerror" | "console";
  isErrorObject?: boolean;
  text: string;
}

export interface StubRequest {
  method: string;
  url: string;
  resourceType?: string;
  /** null: the request never gets an answer. */
  status: number | null;
  /** The request fails on the network instead. */
  failed?: boolean;
}

/** Whether a form's action, and every submitter's formaction, resolve to the page's own origin. */
export interface StubForm {
  sameOrigin: boolean;
}

export interface StubPage {
  fields?: StubField[];
  /** By form index; a form not listed posts to the page's own origin. */
  forms?: StubForm[];
  /** Whether `<base href>` leaves the page's origin unchanged (default true). */
  baseSameOrigin?: boolean;
  links?: StubLink[];
  captcha?: { present: boolean; visible: boolean };
  secondFactorVisible?: boolean;
  alerts?: string[];
  /** Thrown or logged while the page loads. */
  errors?: StubError[];
}

/** What submitting the login does. */
export interface StubSubmit {
  /** Whether Enter in the password field submits (default true). */
  enter?: boolean;
  requests?: StubRequest[];
  errors?: StubError[];
  /** Where the browser ends up, signed in; absent means it stays on the page. */
  landing?: string;
  /** What the page shows afterwards when it stays. */
  after?: StubPage;
  /** Whether the saved session survives into a fresh context (default true). */
  persists?: boolean;
}

export interface StubSite {
  /** A page by its path (a hash route keeps its hash) or, off the app's origin, by its full URL. */
  pages: Record<string, StubPage>;
  /** The pages of a context that is signed in. */
  authedPages?: Record<string, StubPage>;
  submit?: StubSubmit;
  /** Where a path or URL ends up when it is opened. */
  redirects?: Record<string, string>;
  /** Paths whose navigation throws. */
  gotoFails?: string[];
  /** Input positions whose typed value does not stick. */
  dropFill?: number[];
  /** The Nth read of the page throws because the page navigated under it, and the browser is then on `to`. */
  navUnderRead?: { onCall: number; to: string };
  /** Moments at which the browser silently ends up on another URL. */
  drifts?: StubDrift[];
}

/** After the Nth `on` (a page read, a typed field, or the origin check that follows the first read) the browser is on `to`. */
export interface StubDrift {
  on: "evaluate" | "fill" | "url-after-read";
  nth: number;
  to: string;
  /** Only the pages of this browser context (numbered from 1 in the order they open); any when absent. */
  context?: number;
}

export const input = (i: number, type: string, form: number, over: Partial<StubField> = {}): StubField => ({ i, tag: "input", type, visible: true, disabled: false, form, ...over });
export const button = (i: number, form: number, over: Partial<StubField> = {}): StubField => ({ i, tag: "button", type: "submit", visible: true, disabled: false, form, ...over });

/* A login form as a page shows it: the user field, the password field and a submit button in form 0. */
export const loginForm = (): StubPage => ({ fields: [input(0, "email", 0), input(1, "password", 0), button(2, 0)] });

/*
 * A stand-in for the `playwright` module the script requires: a tiny fake browser over a JSON site.
 * It records what the script does to `STUB_EVENTS`, one JSON line each, so a test reads the
 * navigation and the typing from the outside. It never sees a real page.
 */
const STUB_MODULE = `
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const site = JSON.parse(fs.readFileSync(process.env.STUB_SITE, "utf8"));
const log = (entry) => fs.appendFileSync(process.env.STUB_EVENTS, JSON.stringify(entry) + "\\n");
const keyOf = (u) => (u.origin === site.origin ? u.pathname + u.hash : u.href);
const who = (v) => (v === process.env.DEV_TEST_USER ? "user" : v === process.env.DEV_TEST_PASS ? "pass" : "other");
const submit = site.submit || {};
let contexts = 0;
let evalCalls = 0;
function makePage(ctx, state) {
  const events = new EventEmitter();
  const page = { on: (name, listener) => events.on(name, listener) };
  const typed = {};
  let current = new URL("about:blank");
  let staying = null;
  let afterRead = false;
  const drifts = (site.drifts || []).filter((d) => d.context === undefined || d.context === ctx).map((d) => ({ ...d, seen: 0, fired: false }));
  const drift = (on) => {
    for (const d of drifts) if (d.on === on && !d.fired && ++d.seen === d.nth) { d.fired = true; current = new URL(d.to); }
  };
  const def = () => staying || (state.authed && (site.authedPages || {})[keyOf(current)]) || site.pages[keyOf(current)] || {};
  /* What the page logs while it loads is read back slowly (a turn of the event loop), as a browser's answer to a handle is. */
  const raise = (e, slow) => {
    if (e.kind === "pageerror") return events.emit("pageerror", new Error(e.text));
    const evaluate = async (fn) => {
      if (slow) await new Promise((resolve) => setImmediate(resolve));
      return fn(e.isErrorObject ? new Error(e.text) : e.text);
    };
    events.emit("console", { type: () => "error", text: () => e.text, args: () => [{ evaluate }] });
  };
  const submitted = (via, key, i) => {
    log({ t: "submit", via, key, i, ctx, at: current.origin });
    if (via === "press" && submit.enter === false) return;
    for (const r of submit.requests || []) {
      const request = { method: () => r.method, url: () => new URL(r.url, site.origin).href, resourceType: () => r.resourceType || "fetch" };
      events.emit("request", request);
      if (r.failed) events.emit("requestfailed", request);
      else if (r.status !== null) events.emit("response", { request: () => request, status: () => r.status });
    }
    (submit.errors || []).forEach((e) => raise(e, false));
    if (submit.landing) { state.authed = true; state.persists = submit.persists !== false; current = new URL(submit.landing, site.origin); staying = null; }
    else if (submit.after) staying = submit.after;
  };
  page.goto = async (target) => {
    const asked = new URL(target);
    log({ t: "goto", to: keyOf(asked), ctx });
    if ((site.gotoFails || []).includes(keyOf(asked))) throw new Error("navigation failed");
    const redirected = !state.authed && site.redirects && site.redirects[keyOf(asked)];
    current = redirected ? new URL(redirected, site.origin) : asked;
    staying = null;
    (def().errors || []).forEach((e) => raise(e, true));
  };
  page.url = () => {
    const href = current.href;
    if (afterRead) { afterRead = false; drift("url-after-read"); }
    return href;
  };
  page.waitForLoadState = async () => {};
  page.evaluate = async () => {
    evalCalls++;
    if (site.navUnderRead && evalCalls === site.navUnderRead.onCall) {
      current = new URL(site.navUnderRead.to);
      throw new Error("Execution context was destroyed, most likely because of a navigation");
    }
    if (current.origin !== site.origin) log({ t: "inspected-foreign-page" });
    const d = def();
    const fields = d.fields || [];
    const formCount = Math.max(-1, ...fields.map((f) => f.form)) + 1;
    const forms = Array.from({ length: formCount }, (_, n) => ({ sameOrigin: !d.forms || !d.forms[n] || d.forms[n].sameOrigin !== false }));
    afterRead = true;
    drift("evaluate");
    return { fields, forms, baseSameOrigin: d.baseSameOrigin !== false, links: d.links || [], captcha: d.captcha || { present: false, visible: false }, secondFactorVisible: !!d.secondFactorVisible, alerts: d.alerts || [] };
  };
  page.waitForFunction = async (fn, arg, options) => {
    log({ t: "wait", timeout: options.timeout });
    if ((def().fields || []).some((f) => f.tag === "input" && f.type === "password" && f.visible)) throw new Error("Timeout " + options.timeout + "ms exceeded");
  };
  page.locator = (selector) => {
    const i = Number(/"(\\d+)"/.exec(selector)[1]);
    return {
      fill: async (value) => { typed[i] = value; log({ t: "fill", i, as: who(value), at: current.origin }); drift("fill"); },
      inputValue: async () => ((site.dropFill || []).includes(i) ? "" : typed[i] || ""),
      press: async (key) => {
        submitted("press", key, i);
        if (process.env.STUB_PRESS_ERROR) throw new Error(process.env.STUB_PRESS_ERROR);
      },
      click: async () => submitted("click", undefined, i),
    };
  };
  return page;
}
function makeContext(options) {
  const id = ++contexts;
  log({ t: "context", id, storageState: !!options.storageState, credentialsOrigin: options.httpCredentials ? options.httpCredentials.origin : null, options: Object.keys(options) });
  const state = { authed: false, persists: false };
  if (options.storageState) state.authed = JSON.parse(fs.readFileSync(options.storageState, "utf8")).cookies.length > 0;
  return {
    newPage: async () => makePage(id, state),
    storageState: async ({ path }) => fs.writeFileSync(path, JSON.stringify({ cookies: state.persists ? [{ name: "session" }] : [], origins: [] })),
    close: async () => {},
  };
}
exports.chromium = {
  launch: async () => {
    if (process.env.STUB_LAUNCH_ERROR) throw new Error(process.env.STUB_LAUNCH_ERROR);
    return { newContext: async (options = {}) => makeContext(options), close: async () => {} };
  },
};
`;

export interface StubEvent {
  t: string;
  to?: string;
  i?: number;
  as?: string;
  /** The origin the browser was on when the script acted. */
  at?: string;
  via?: string;
  key?: string;
  ctx?: number;
  id?: number;
  storageState?: boolean;
  credentialsOrigin?: string | null;
  options?: string[];
  timeout?: number;
}

export interface LoginDiscoveryInput {
  baseUrl?: string;
  routes?: string[];
  loginPath?: string;
  storageStatePath?: string;
  budgetMs?: number;
  actionTimeoutMs?: number;
}

export interface DiscoveryRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Every stdout line, parsed. */
  lines: Array<Record<string, unknown>>;
  markers: string[];
  evidence: LoginEvidence | undefined;
  events: StubEvent[];
  /** The paths (or, off the app's origin, URLs) the script navigated to, in order. */
  gotos: string[];
  submits: StubEvent[];
}

export interface DiscoveryRunOptions {
  site: StubSite;
  input?: LoginDiscoveryInput;
  env?: Record<string, string>;
}

/** Runs the generated discovery script under real `node`, against the stub `playwright` module in a temp dir. */
export async function runLoginDiscovery(options: DiscoveryRunOptions): Promise<DiscoveryRun> {
  const dir = mkdtempSync(join(tmpdir(), "login-discovery-"));
  try {
    mkdirSync(join(dir, "playwright"));
    const stubPath = join(dir, "playwright", "index.cjs");
    writeFileSync(stubPath, STUB_MODULE);
    const scriptPath = join(dir, "discovery.cjs");
    writeFileSync(scriptPath, buildLoginDiscoveryScript(stubPath));
    const sitePath = join(dir, "site.json");
    writeFileSync(sitePath, JSON.stringify({ origin: STUB_ORIGIN, ...options.site }));
    const eventsPath = join(dir, "events.jsonl");
    writeFileSync(eventsPath, "");
    const env = {
      STUB_SITE: sitePath,
      STUB_EVENTS: eventsPath,
      DEV_TEST_USER: STUB_USER,
      DEV_TEST_PASS: STUB_PASS,
      PW_LOGIN_INPUT: JSON.stringify({ baseUrl: STUB_ORIGIN, routes: [], storageStatePath: join(dir, "state.json"), ...options.input }),
      ...options.env,
    };
    const done = await execFileAsync(process.execPath, [scriptPath], { env, timeout: 20_000 }).then(
      (ok) => ({ exitCode: 0, stdout: ok.stdout, stderr: ok.stderr }),
      (err: { code?: number; stdout?: string; stderr?: string }) => ({ exitCode: err.code ?? null, stdout: err.stdout ?? "", stderr: err.stderr ?? "" }),
    );
    const lines = done.stdout.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
    const events = readFileSync(eventsPath, "utf8").split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as StubEvent);
    const evidenceLine = lines.find((line) => "evidence" in line);
    return {
      ...done,
      lines,
      markers: lines.flatMap((line) => (typeof line.marker === "string" ? [line.marker] : [])),
      evidence: evidenceLine?.evidence as LoginEvidence | undefined,
      events,
      gotos: events.flatMap((event) => (event.t === "goto" && event.to !== undefined ? [event.to] : [])),
      submits: events.filter((event) => event.t === "submit"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A login that stays on its form after the submit, whatever the submit sent. */
export const stayingSite = (submit: StubSubmit = {}, page: StubPage = loginForm()): StubSite => ({ pages: { "/": page }, submit });

export function evidenceOf(run: DiscoveryRun): LoginEvidence {
  assert.ok(run.evidence, `the run printed no evidence (exit ${run.exitCode}): ${run.stderr}`);
  return run.evidence;
}

/** What the real classifier makes of the evidence a run printed. */
export const outcomeOf = (run: DiscoveryRun): LoginOutcome => classifyLoginEvidence(evidenceOf(run));

/** Syntax-checks a generated script with `node --check`. */
export async function nodeChecks(source: string): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), "login-discovery-check-"));
  try {
    const path = join(dir, "script.cjs");
    writeFileSync(path, source);
    await execFileAsync(process.execPath, ["--check", path]);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
