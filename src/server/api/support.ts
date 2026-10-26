/* Pieces several routes share: loading the app a route is about, the views and sanitizers that shape what leaves, and the lenient query parsers. */

import { sanitizeText } from "../../../qa-engine/src/shared-infrastructure/redaction/pattern-redaction.adapter";
import { RedactionPortAdapter } from "../../orchestrator/sanitizer";
import { AppConfigInvalidError, AppNotFoundError, type AppConfig } from "../../orchestrator/config-loader";
import { engineStatus, type RunRecord } from "../../types";
import { ApiError } from "./api-error";
import type { ApiDeps } from "./deps";

export const redactionPort = new RedactionPortAdapter();

/*
 * The one place a route loads the app it is about. An app with no config answers 404; an app whose config cannot be loaded
 * answers 422 with the reason (the operator can fix it, and "not found" would send them to onboard an app that exists). Any other
 * failure is not about the app and propagates.
 */
export function loadApp(deps: ApiDeps, name: string): AppConfig {
  try {
    return deps.loadApp(name);
  } catch (err) {
    if (err instanceof AppNotFoundError) throw new ApiError(404, `app not found: '${name}'`);
    if (err instanceof AppConfigInvalidError) throw new ApiError(422, redactionPort.redactError(err));
    throw err;
  }
}

/*
 * Sanitize a RunRecord before it leaves the system: logs, case details and the note can
 * carry DEV data or a secret the agent echoed. Same egress invariant the chat/Issue paths
 * already honor (AGENTS.md "Sanitize data leaving the system").
 */
export function sanitizeRecord(record: RunRecord): RunRecord {
  return {
    ...record,
    /*
     * Derive the run status on egress (never stored): present once a verdict exists, absent while the
     * run is still in-flight (a running run is not an "error"). Lets REST consumers read success vs
     * error directly instead of re-deriving from the verdict.
     */
    ...(record.verdict ? { engineStatus: engineStatus(record.verdict) } : {}),
    note: record.note ? sanitizeText(record.note).text : record.note,
    logs: record.logs.map((l) => sanitizeText(l).text),
    cases: record.cases.map((c) => {
      /*
       * Omit `detail` entirely when absent. A DB-backed record yields detail:null (history stores
       * `c.detail ?? null`), but the contract is z.string().optional() (string|undefined, NOT null),
       * so passing null through here 500s the run-status API. Strip it (and sanitize when present).
       */
      const { detail, networkErrors, ...rest } = c;
      /* A network error's URL and text are DEV data too: sanitize them on egress, not only by value at harvest. */
      const safeNetworkErrors = networkErrors?.map((e) => ({
        ...e,
        url: sanitizeText(e.url).text,
        ...(e.errorText !== undefined ? { errorText: sanitizeText(e.errorText).text } : {}),
        ...(e.resourceType !== undefined ? { resourceType: sanitizeText(e.resourceType).text } : {}),
      }));
      return {
        ...rest,
        ...(detail ? { detail: sanitizeText(detail).text } : {}),
        ...(safeNetworkErrors ? { networkErrors: safeNetworkErrors } : {}),
      };
    }),
    activity: record.activity?.map((a) => ({ ...a, text: sanitizeText(a.text).text })),
  };
}

export function appView(app: AppConfig): { name: string; repo: string; baseUrl: string; versionUrl: string; code: boolean; shadow: boolean; needsReview: boolean; testDataPrefix: string; services: Array<{ repo: string; openapi?: string; versionUrl?: string }>; authKind?: "form" | "mtls" } {
  /* Code-mode apps have no dev environment (and no baseUrl). */
  return {
    name: app.name,
    repo: app.repo,
    baseUrl: app.dev?.baseUrl ?? "",
    versionUrl: app.dev?.versionUrl ?? "",
    code: app.code ?? false,
    shadow: app.qa.shadow ?? false,
    needsReview: app.qa.needsReview,
    testDataPrefix: app.qa.testDataPrefix,
    services: (app.services ?? []).map((s) => ({
      repo: s.repo,
      openapi: typeof s.openapi === "string" ? s.openapi : s.openapi?.[0],
      versionUrl: s.versionUrl,
    })),
    ...(app.auth ? { authKind: app.auth.kind } : {}),
  };
}

/*
 * Parses "?limit=" defensively: absent/invalid falls back to the view's default (200), values
 * beyond the schema cap (1000) are clamped by the reader itself.
 */
export function parseLimit(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
/*
 * A client-supplied trends window (?window=N), clamped to [1,50] — listRunOutcomes caps the read at
 * 100 rows, so the current + previous windows (window*2) must stay within it. Invalid/absent →
 * undefined (the view falls back to its default of 20).
 */
export function parseWindow(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return Math.min(n, 50);
}
