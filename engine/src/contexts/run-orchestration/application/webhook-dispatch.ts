/*
 * What run a deploy event triggers. A push to an app's primary repo runs the event's mode, guidance and base; a push to a service
 * repo always runs a diff-mode run of the app that owns it, naming the repo that triggered it.
 */
import type { AppRepositoryPort } from "@contexts/app-catalog/application/index.ts";
import type { RunMode } from "@kernel/run-mode.ts";

export interface WebhookDispatch {
  app: string;
  target: "e2e";
  mode: RunMode;
  guidance?: string;
  triggerRepo?: string;
  baseSha?: string;
}

export async function resolveWebhookDispatch(
  catalog: AppRepositoryPort,
  repo: string,
  opts: { mode: RunMode; guidance?: string; baseSha?: string },
): Promise<WebhookDispatch[]> {
  const matches = await catalog.resolveByRepo(repo);
  return matches.map((m): WebhookDispatch =>
    m.role === "primary"
      ? {
          app: m.app.name,
          target: "e2e",
          mode: opts.mode,
          ...(opts.guidance !== undefined ? { guidance: opts.guidance } : {}),
          ...(opts.baseSha !== undefined ? { baseSha: opts.baseSha } : {}),
        }
      : {
          app: m.app.name,
          target: "e2e",
          mode: "diff",
          ...(opts.guidance !== undefined ? { guidance: opts.guidance } : {}),
          ...(opts.baseSha !== undefined ? { baseSha: opts.baseSha } : {}),
          triggerRepo: repo,
        },
  );
}
