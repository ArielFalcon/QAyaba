/* The secrets of one run's test account, redacted from text by VALUE. The pattern redaction of sanitize-text.ts finds a secret by how it looks, so a plain password a spec printed, or a cookie in a captured page, passes it; here the run's own secrets are known (the account's password, the DEV gate's credentials, the client certificate's passphrase, and the cookie and localStorage values of the session the login produced), and any text that is about to reach a model has each of them replaced wherever it stands.
   One scope per run, carried through the run's async calls (AsyncLocalStorage), so two runs never see each other's secrets and nothing is passed down by hand. The run opens it (`withRunSecretScope`); whatever learns a secret registers it into the scope the run is in (`registerSessionSecretsFromStorageState`, or `addAccountSecrets` on `activeRunSecretScope()`); the one text seam all model-bound text goes through (sanitizeText) and the transport that sends a prompt apply it (`redactByValue`). Outside a scope it changes nothing.
   Cheap: one regular expression of every escaped value, longest first, rebuilt only when a value is added. A value is also found as a page, a JSON string or a URL spells it. Never logs a value: a warning says what failed in words of its own. Fail-open on registration (a session that cannot be read strictly adds no value, with a warning, and the run goes on) because the pattern redaction still stands behind it. The session file is read through the confined reader, strictly: no link anywhere on the way, a regular file, under a cap. */

import { AsyncLocalStorage } from "node:async_hooks";
import { REDACTED } from "@kernel/ports/redaction.port.ts";
import { readFailureReason, readOwnedSpecFile } from "./spec-path-confinement.ts";

/* A password shorter than this is not redacted: it would take the same letters out of every word around it and protect nothing, and no real account has one. */
export const MIN_ACCOUNT_SECRET_CHARS = 4;
/* A cookie or localStorage value shorter than this is a flag, a language or a counter, not a credential. */
export const MIN_SESSION_VALUE_CHARS = 8;
/* A value longer than this is a stored document, not a credential. */
export const MAX_SECRET_VALUE_CHARS = 4096;
/* The most values a scope holds (the spellings of one value are not counted apart), far above any session's cookies and storage. */
export const MAX_SECRET_VALUES = 2000;
/* The most of a session file that is read. */
export const MAX_STORAGE_STATE_BYTES = 4 * 1024 * 1024;

export interface RunSecretScope {
  /* The account's own secrets: passwords, gate credentials, a certificate's passphrase (never an account's username: it is a name, not a credential). Empty, missing, too short and too long ones are skipped. */
  addAccountSecrets(values: ReadonlyArray<string | undefined>): void;
  /* Cookie and storage values of the session: the same, with the longer floor. */
  addSessionValues(values: ReadonlyArray<string | undefined>): void;
  /* The text with every value of the scope replaced, wherever it stands, and how many replacements were made. */
  redactCounted(text: string): { text: string; count: number };
  /* The same, for a caller that has no use for the count. */
  redact(text: string): string;
}

const store = new AsyncLocalStorage<RunSecretScope>();

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* One value as a page, a JSON string and a URL spell it, besides itself. */
function spellings(value: string): string[] {
  const html = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  return [value, html, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)];
}

export function createRunSecretScope(): RunSecretScope {
  const values = new Set<string>();
  let pattern: RegExp | undefined;

  const add = (candidates: ReadonlyArray<string | undefined>, minChars: number): void => {
    for (const candidate of candidates) {
      if (typeof candidate !== "string" || candidate.length < minChars || candidate.length > MAX_SECRET_VALUE_CHARS) continue;
      if (values.has(candidate)) continue;
      if (values.size >= MAX_SECRET_VALUES) return;
      values.add(candidate);
      pattern = undefined;
    }
  };
  const compiled = (): RegExp | undefined => {
    if (pattern === undefined && values.size > 0) {
      const all = new Set([...values].flatMap(spellings));
      pattern = new RegExp([...all].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).map(escapeRegExp).join("|"), "g");
    }
    return pattern;
  };

  const redactCounted = (text: string): { text: string; count: number } => {
    const re = compiled();
    if (re === undefined || !text) return { text, count: 0 };
    let count = 0;
    const out = text.replace(re, () => {
      count += 1;
      return REDACTED;
    });
    return { text: out, count };
  };

  return {
    addAccountSecrets: (candidates) => add(candidates, MIN_ACCOUNT_SECRET_CHARS),
    addSessionValues: (candidates) => add(candidates, MIN_SESSION_VALUE_CHARS),
    redactCounted,
    redact: (text) => redactCounted(text).text,
  };
}

/* Runs `fn`, and everything it awaits, with `scope` as the run's scope. */
export function withRunSecretScope<T>(scope: RunSecretScope, fn: () => T): T {
  return store.run(scope, fn);
}

/* The scope of the run this call is part of, or undefined outside a run. */
export function activeRunSecretScope(): RunSecretScope | undefined {
  return store.getStore();
}

/* The text with the secrets of the run it belongs to replaced; unchanged outside a run. */
export function redactByValue(text: string): string {
  return store.getStore()?.redact(text) ?? text;
}

/* The same, with the number of replacements, for the text seam that reports what it redacted. */
export function redactByValueCounted(text: string): { text: string; count: number } {
  return store.getStore()?.redactCounted(text) ?? { text, count: 0 };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const valuesOf = (entries: unknown): string[] =>
  (Array.isArray(entries) ? entries : []).flatMap((entry) => (isRecord(entry) && typeof entry.value === "string" ? [entry.value] : []));

/* Adds the cookie and localStorage values of the Playwright session at `file`, below `authDir`, to the run's scope. The file is orchestrator-owned but written by a login the agent may have authored, so it is read strictly and nothing it holds is ever logged: a file that cannot be read that way, or is not JSON, adds nothing and says so once. No file means no session, and says nothing. */
export function registerSessionSecretsFromStorageState(authDir: string, file: string): void {
  const scope = store.getStore();
  if (scope === undefined) return;
  let read;
  try {
    read = readOwnedSpecFile({ mirrorDir: authDir, specDir: authDir }, file, MAX_STORAGE_STATE_BYTES);
  } catch (err) {
    console.warn(`[qa] WARNING: the session file could not be read (${readFailureReason(err)}); its cookies and storage are not redacted by value this run (non-blocking).`);
    return;
  }
  if ("absent" in read) return;
  if ("reason" in read) {
    console.warn(`[qa] WARNING: the session file was not read (${read.reason}); its cookies and storage are not redacted by value this run (non-blocking).`);
    return;
  }
  let state: unknown;
  try {
    state = JSON.parse(read.bytes.toString("utf8"));
  } catch {
    console.warn("[qa] WARNING: the session file is not valid JSON; its cookies and storage are not redacted by value this run (non-blocking).");
    return;
  }
  if (!isRecord(state)) return;
  const origins = Array.isArray(state.origins) ? state.origins : [];
  scope.addSessionValues([...valuesOf(state.cookies), ...origins.flatMap((origin) => (isRecord(origin) ? valuesOf(origin.localStorage) : []))]);
}
