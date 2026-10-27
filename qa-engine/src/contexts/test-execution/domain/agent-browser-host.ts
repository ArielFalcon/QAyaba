import type { GuardReason } from "./agent-browser-route-guard.ts";
import type { GeoLocation } from "@kernel/geolocation.ts";

/* What a tool call asks of the browser. A ref is one the last snapshot of the same session gave. */
export type BrowserAction =
  | { kind: "navigate"; url: string }
  | { kind: "snapshot" }
  | { kind: "click"; ref: string }
  | { kind: "type"; ref: string; text: string; submit: boolean };

export interface BlockedRequest {
  reason: GuardReason;
  /* Method and address without query or credentials. */
  detail: string;
}

/* A request the page made, as method + origin + pathname (no query, fragment, body, headers, cookies or userinfo), with how many times. */
export interface ObservedRequest {
  method: string;
  url: string;
  count: number;
  /* The route guard refused it (a closed route, a method that writes). */
  blocked?: true;
}

/* The requests the page made since the session's previous action: those to an origin the run declares listed, those to any other host only counted per host. */
export interface ObservedRequests {
  listed: ObservedRequest[];
  otherHosts: { host: string; count: number }[];
  /* Requests not kept because the page asked for more distinct ones than the safety bound holds. */
  omitted: number;
}

/* What the page looks like after a call. */
export interface PageState {
  url: string;
  title: string;
  /* The accessibility tree, with refs. */
  snapshot: string;
  /* The status of the main document when the call loaded one. */
  documentStatus?: number;
  passwordFieldVisible: boolean;
  /* The path the call asked for: a navigation's target, otherwise the page the session was on. */
  requestedPath: string;
  /* Requests the guard refused during the call. */
  blocked: BlockedRequest[];
  /* The requests the page made since the session's previous action. */
  requests: ObservedRequests;
  /* Things the agent should know that are not in the tree (a dialog dismissed, a tab closed). */
  notes: string[];
}

export interface BrowserCallOptions {
  /* Aborts when the call's time is up or its session ended. */
  signal: AbortSignal;
  timeoutMs: number;
  /* Where the caller's authoring scope is now: the action runs at it. Absent: the context keeps the app default. */
  geolocation?: GeoLocation;
  /* The session never writes to DEV: every request its page makes is judged read-only. */
  readOnly?: boolean;
}

/* The browser could not do what was asked for a reason the agent can act on (a ref that is gone, an element that is not there). Anything else the host throws is a fault and is not shown. */
export class BrowserActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserActionError";
  }
}
