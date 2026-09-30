import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildLoginDiscoveryScript } from "@contexts/qa-run-orchestration/infrastructure/login-discovery/login-discovery.script.ts";
import type { LoginEvidence } from "@contexts/qa-run-orchestration/domain/helpers/login-evidence.ts";

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

export interface StubPage {
  fields?: StubField[];
  links?: StubLink[];
}

export interface StubSite {
  /** A page by its path (a hash route keeps its hash) or, off the app's origin, by its full URL. */
  pages: Record<string, StubPage>;
  /** Where a path or URL ends up when it is opened. */
  redirects?: Record<string, string>;
  /** Paths whose navigation throws. */
  gotoFails?: string[];
  /** Input positions whose typed value does not stick. */
  dropFill?: number[];
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
const site = JSON.parse(fs.readFileSync(process.env.STUB_SITE, "utf8"));
const log = (entry) => fs.appendFileSync(process.env.STUB_EVENTS, JSON.stringify(entry) + "\\n");
const keyOf = (u) => (u.origin === site.origin ? u.pathname + u.hash : u.href);
const who = (v) => (v === process.env.DEV_TEST_USER ? "user" : v === process.env.DEV_TEST_PASS ? "pass" : "other");
function makePage() {
  const page = {};
  const typed = {};
  let current = new URL("about:blank");
  page.goto = async (target) => {
    const asked = new URL(target);
    log({ t: "goto", to: keyOf(asked) });
    if ((site.gotoFails || []).includes(keyOf(asked))) throw new Error("navigation failed");
    const redirected = site.redirects && site.redirects[keyOf(asked)];
    current = redirected ? new URL(redirected, site.origin) : asked;
  };
  page.url = () => current.href;
  page.waitForLoadState = async () => {};
  page.evaluate = async () => {
    if (current.origin !== site.origin) log({ t: "inspected-foreign-page" });
    const def = site.pages[keyOf(current)] || {};
    return { fields: def.fields || [], links: def.links || [] };
  };
  page.locator = (selector) => {
    const i = Number(/"(\\d+)"/.exec(selector)[1]);
    return {
      fill: async (value) => { typed[i] = value; log({ t: "fill", i, as: who(value) }); },
      inputValue: async () => ((site.dropFill || []).includes(i) ? "" : typed[i] || ""),
      press: async (key) => {
        log({ t: "submit", via: "press", key, i });
        if (process.env.STUB_PRESS_ERROR) throw new Error(process.env.STUB_PRESS_ERROR);
      },
      click: async () => log({ t: "submit", via: "click", i }),
    };
  };
  return page;
}
exports.chromium = {
  launch: async () => {
    if (process.env.STUB_LAUNCH_ERROR) throw new Error(process.env.STUB_LAUNCH_ERROR);
    return {
      newContext: async () => ({ newPage: async () => makePage(), close: async () => {} }),
      close: async () => {},
    };
  },
};
`;

export interface StubEvent {
  t: string;
  to?: string;
  i?: number;
  as?: string;
  via?: string;
  key?: string;
}

export interface LoginDiscoveryInput {
  baseUrl?: string;
  routes?: string[];
  loginPath?: string;
  storageStatePath?: string;
  budgetMs?: number;
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
