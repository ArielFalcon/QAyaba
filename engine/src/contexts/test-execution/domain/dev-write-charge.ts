/*
 * What one test's DEV writes are charged to the spec. A write the spec caused is a mutating request that would not have been
 * sent had the spec stopped before its first action. The page, the browser and the app's session code send some on their own
 * (a token renewal on load, a heartbeat); the engine holds evidence of them only from a control load: the same session and
 * app with no spec action, run in a process of its own before any spec code, which records the mutating requests DEV answered. A page
 * request the control also sent is that traffic, exempt up to the count the control saw for the same method and address;
 * every other write is charged. The request an API client sent is never exempt (the spec made that call by construction), and
 * neither is one whose sender was not recorded. No protocol, header, body, path or origin role is read. Pure.
 */
import type { DevWriteRequest } from "./dev-write-request.ts";

/* Who sent a recorded request: the test's page or context, its API client, or a seed that did not say. */
export type WriteSender = "page" | "api" | "unknown";

/* One distinct request a test's ledger kept: method and address, who sent it, how many times. */
export interface RecordedWrite {
  method: string;
  url: string;
  sender: WriteSender;
  count: number;
}

/* A test's ledger as the engine reads it: the writes DEV answered, the requests still out, whether the test finished, and the distinct requests behind the count (the writes it could not record are in `writes` only). */
export interface TestWriteLedger {
  writes: number;
  pending: number;
  done: boolean;
  requests: readonly RecordedWrite[];
}

export interface TestCharge {
  /* What this test costs the run's cap: its answered writes the control does not account for, plus the requests it still had out, finished or not (a write out when its test finished may have reached DEV). */
  charged: number;
  /* The recorded requests behind the charge, each with the count charged. */
  chargedRequests: DevWriteRequest[];
  /* The recorded requests the control accounted for, each with the count exempted. */
  exemptRequests: DevWriteRequest[];
}

const keyOf = (method: string, url: string): string => `${method} ${url}`;

/* Charges one test against the control of its project; no control (missing or untrusted) charges everything. What the control saw of a request is drawn down as it is exempted, so a ledger that lists one request twice (the seed never writes one, a forged file may) is exempt once up to the control's count in all. */
export function chargeTestWrites(ledger: TestWriteLedger, control: readonly DevWriteRequest[] | undefined): TestCharge {
  const seen = new Map<string, number>();
  for (const r of control ?? []) seen.set(keyOf(r.method, r.url), (seen.get(keyOf(r.method, r.url)) ?? 0) + r.count);
  const chargedRequests: DevWriteRequest[] = [];
  const exemptRequests: DevWriteRequest[] = [];
  let exempt = 0;
  for (const r of ledger.requests) {
    const key = keyOf(r.method, r.url);
    const accountedFor = r.sender === "page" ? Math.min(r.count, seen.get(key) ?? 0) : 0;
    seen.set(key, (seen.get(key) ?? 0) - accountedFor);
    if (accountedFor > 0) {
      exemptRequests.push({ method: r.method, url: r.url, count: accountedFor });
      exempt += accountedFor;
    }
    if (r.count > accountedFor) chargedRequests.push({ method: r.method, url: r.url, count: r.count - accountedFor });
  }
  return { charged: Math.max(0, ledger.writes - exempt) + ledger.pending, chargedRequests, exemptRequests };
}
