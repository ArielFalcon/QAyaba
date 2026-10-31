import type { ContextHealRunRequest } from "../../domain/context-heal-run-request.ts";

/* Enqueues a `context` run of an app at a sha and returns its run id, or "" when the queue refuses new work. */
export interface EnqueueContextRunPort {
  (input: ContextHealRunRequest): string | Promise<string>;
}
