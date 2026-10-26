/* Boundary-profile onboarding: propose a profile for an app, read the job, confirm it. */

import type { z } from "zod";
import { CreateAppResultSchema, OnboardingJobStatusSchema, type ProposeBoundariesInputSchema } from "../../../contract/commands";
import { ApiError } from "../api-error";
import type { ApiDeps } from "../deps";
import { reply, type ApiResult } from "../respond";

const UNAVAILABLE = "boundary-profile onboarding is not available";

function boundariesOf(deps: ApiDeps): NonNullable<ApiDeps["boundaries"]> {
  if (!deps.boundaries) throw new ApiError(501, UNAVAILABLE, { bare: true });
  return deps.boundaries;
}

export function requireBoundaries(deps: ApiDeps): void {
  boundariesOf(deps);
}

export function proposeBoundaries(deps: ApiDeps, name: string, input: z.infer<typeof ProposeBoundariesInputSchema>): ApiResult {
  const boundaries = boundariesOf(deps);
  /*
   * propose() rejects the mutex SYNCHRONOUSLY (a plain {ok:false} object, not a promise) — see
   * onboarding-job.ts's own contract. Only that synchronous shape can be inspected here; an
   * ACCEPTED kickoff returns a Promise the handler deliberately never awaits (fire-and-forget)
   * — any error surfacing later only shows up on the next status() poll.
   */
  const result = boundaries.propose(name, input);
  if (!(result instanceof Promise) && !result.ok) throw new ApiError(409, result.error, { bare: true });
  return reply.contract(202, OnboardingJobStatusSchema, boundaries.status(name));
}

export function boundaryStatus(deps: ApiDeps, name: string): ApiResult {
  return reply.contract(200, OnboardingJobStatusSchema, boundariesOf(deps).status(name));
}

export function confirmBoundaries(deps: ApiDeps, name: string): ApiResult {
  const result = boundariesOf(deps).confirm(name);
  if (!result.ok) throw new ApiError(422, result.error, { bare: true });
  return reply.contract(200, CreateAppResultSchema, { ok: true });
}
