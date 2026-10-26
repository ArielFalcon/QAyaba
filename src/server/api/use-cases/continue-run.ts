/* POST /runs/:id/continue: re-runs the failed cases of a finished run, with optional human guidance. */

import { z } from "zod";
import { ContinueResultSchema } from "../../../contract/commands";
import type { RunRecord } from "../../../types";
import { ApiError } from "../api-error";
import type { ApiDeps } from "../deps";
import { reply, type ApiResult } from "../respond";
import { fieldsOf } from "../request";
import { MAX_GUIDANCE_LENGTH } from "./create-run";

/* A body field of the wrong type is ignored, as if it were absent; a body of `null` is not a body. */
export const ContinueBodySchema = z.unknown().transform((raw, ctx) => {
  if (raw === null) {
    ctx.addIssue({ code: "custom", message: "invalid JSON" });
    return z.NEVER;
  }
  const body = fieldsOf(raw);
  return {
    guidance: typeof body.guidance === "string" ? body.guidance.slice(0, MAX_GUIDANCE_LENGTH) : undefined,
    cases: Array.isArray(body.cases) ? body.cases.filter((name): name is string => typeof name === "string") : undefined,
  };
});

export interface Continuable {
  readonly parent: RunRecord;
  readonly failedNames: ReadonlySet<string>;
}

/* The finished run with failed cases a continuation starts from. */
export function findContinuable(deps: ApiDeps, parentId: string): Continuable {
  const parent = deps.getRecord(parentId);
  if (!parent) throw new ApiError(404, `run not found: ${parentId}`, { bare: true });
  if (!deps.continuation) throw new ApiError(501, "continue is not available", { bare: true });
  if (parent.status !== "done") throw new ApiError(409, `run ${parentId} is not finished yet (status: ${parent.status})`, { bare: true });
  const failedNames = new Set(parent.cases.filter((c) => c.status === "fail").map((c) => c.name));
  if (failedNames.size === 0) throw new ApiError(409, `run ${parentId} has no failed cases to continue`, { bare: true });
  return { parent, failedNames };
}

export function continueRun(deps: ApiDeps, { parent, failedNames }: Continuable, input: z.infer<typeof ContinueBodySchema>): ApiResult {
  const continuation = deps.continuation;
  if (!continuation) throw new ApiError(501, "continue is not available", { bare: true });
  const { cases, guidance } = input;

  /*
   * If specific cases were requested, they must name actual failed cases of the parent
   * (otherwise the continuation would have nothing to fix).
   */
  if (cases && cases.length > 0) {
    const unknown = cases.filter((c) => !failedNames.has(c));
    if (unknown.length > 0) throw new ApiError(409, `not failed cases of ${parent.id}: ${unknown.join(", ")}`, { bare: true });
  }

  /*
   * Cap the continuation chain: an operator can chain continue→continue→continue indefinitely, each carrying
   * fresh guidance to nudge the suite toward green. After `maxDepth` rounds, refuse: the suite needs a fresh run.
   */
  const depth = continuation.depth(parent);
  let id = "";
  if (depth >= continuation.maxDepth) {
    console.warn(`[qa] rejecting continuation of ${parent.id}: depth ${depth} >= ${continuation.maxDepth} (max)`);
  } else {
    const want = new Set(cases ?? []);
    const failed = parent.cases.filter((c) => c.status === "fail" && (want.size === 0 || want.has(c.name)));
    id = continuation.enqueue({ parent, fixCases: failed, ...(guidance !== undefined ? { guidance } : {}) });
  }
  if (!id) throw new ApiError(503, "service shutting down", { bare: true });
  return reply.contract(202, ContinueResultSchema, { id, parentRunId: parent.id, app: parent.app, sha: parent.sha, status: "enqueued" });
}
