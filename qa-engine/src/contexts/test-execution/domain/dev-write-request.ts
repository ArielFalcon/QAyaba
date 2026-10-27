/*
 * One request an executed spec sent to DEV that writes, as the orchestrator keeps it: its method, the origin and pathname of its
 * URL (never its query or body), redacted, and how many times the run sent it. The seed's write counter records them beside its
 * count, so a run says which endpoints spent its DEV-write budget. Pure.
 */

/* The most distinct requests a run keeps; its count of writes covers the rest. */
export const MAX_DEV_WRITE_REQUESTS = 20;

export interface DevWriteRequest {
  method: string;
  url: string;
  count: number;
}

/* `POST https://dev.example.com/api/orders ×2`: one request as a span or a log line states it. */
export function describeDevWriteRequest(request: DevWriteRequest): string {
  return `${request.method} ${request.url}${request.count > 1 ? ` ×${request.count}` : ""}`;
}

/* Adds one sighting of `method url` to `into`, merged with an equal one; past the cap a new request is not kept. */
export function noteDevWriteRequest(into: DevWriteRequest[], method: string, url: string, count = 1): void {
  const same = into.find((r) => r.method === method && r.url === url);
  if (same) same.count += count;
  else if (into.length < MAX_DEV_WRITE_REQUESTS) into.push({ method, url, count });
}
