/*
 * Webhook cross-repo dispatch: primary uses the event's mode/guidance/baseSha;
 * a service-repo deploy always triggers a diff-mode e2e run of the owning app.
 */
import type { AppRepositoryPort } from "../../qa-engine/src/contexts/app-catalog/application/ports/index";
import type { RunMode } from "../types";

export interface WebhookDispatch {
  app: string;
  target: "code" | "e2e";
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
          target: m.app.code ? "code" : "e2e",
          mode: opts.mode,
          ...(opts.guidance !== undefined ? { guidance: opts.guidance } : {}),
          ...(opts.baseSha !== undefined ? { baseSha: opts.baseSha } : {}),
        }
      : {
          app: m.app.name,
          target: "e2e",
          mode: "diff",
          ...(opts.guidance !== undefined ? { guidance: opts.guidance } : {}),
          triggerRepo: repo,
        },
  );
}
