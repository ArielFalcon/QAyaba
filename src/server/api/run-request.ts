/* The run request a caller outside the engine may make: an API client or a webhook delivery. */

import type { RunRequest } from "../runner";

/* The fields a caller may set; how the run was started (`source`, `trigger`) and what only a continuation or cleanup carries are the server's to add. */
export type ApiRunRequest = Omit<RunRequest, "source" | "trigger" | "fixCases" | "parentRunId" | "previousNamespace" | "purpose">;

/* The request with the optional fields that were left unset dropped, so a field is either set or absent. */
export function apiRunRequest(required: Pick<ApiRunRequest, "app" | "sha" | "target" | "mode">, optional: Partial<Omit<ApiRunRequest, keyof typeof required>>): ApiRunRequest {
  const set = Object.entries(optional).filter(([, value]) => value !== undefined);
  return { ...required, ...Object.fromEntries(set) };
}
