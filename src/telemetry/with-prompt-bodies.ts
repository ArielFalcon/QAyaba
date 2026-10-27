/* The agent facade decorator that hands a turn's prompt and output to the body exporter (prompt-body-logs.ts). It sits outside the turn-span decorator, so the turn's span exists by the time a prompt starts, and it adds no await to the prompt path: the caller's promise is the transport's own, only observed. Without a registered exporter (telemetry off, no log endpoint) it is the identity. */

import type { AgentDeps } from "../integrations/opencode-client";
import type { TelemetryContext } from "@kernel/telemetry/telemetry.port";
import { sha256Hex } from "../../qa-engine/src/shared-kernel/content-hash";
import { redactByValue } from "../../qa-engine/src/shared-kernel/run-secret-redaction";
import type { CaptureMode } from "@kernel/telemetry/capture-mode";
import { PromptBodyExporter, type TurnBodyIdentity } from "./prompt-body-logs";

export interface PromptBodyHost {
  readonly exporter: PromptBodyExporter;
  /* The capture mode of the run in effect where the prompt starts, or undefined when no span is active. */
  readonly activeMode: () => CaptureMode | undefined;
}

let host: PromptBodyHost | undefined;

/* Set by the telemetry bootstrap once a log endpoint exists; cleared at shutdown. */
export function registerPromptBodyHost(next: PromptBodyHost | undefined): void {
  host = next;
}

export interface PromptBodyDecoratorDeps {
  /* Digest of the static prompt layers (src/server/effective-config.ts hashStaticPrompts). */
  readonly staticHash: () => string | null;
  /* The turn span of the session's turn in flight (the registry the turn-span decorator fills). */
  readonly traces: { turnContext(sessionId: string): TelemetryContext | undefined };
}

export function withPromptBodies(base: AgentDeps, deps: PromptBodyDecoratorDeps): AgentDeps {
  const { traces } = deps;
  return {
    ...base,
    open: async (agent, cwd, opts) => {
      const inner = await base.open(agent, cwd, opts);
      return {
        ...inner,
        prompt: (text, promptOpts) => {
          const result = inner.prompt(text, promptOpts);
          try {
            const active = host;
            const mode = active?.activeMode();
            const turn = traces.turnContext(inner.id);
            if (active && mode === "full" && turn) {
              const who: TurnBodyIdentity = {
                turn,
                sessionId: inner.id,
                agent,
                role: opts?.descriptor?.role ?? agent,
                ...(promptOpts?.round !== undefined ? { round: promptOpts.round } : {}),
                repair: promptOpts?.isRepair ?? false,
                staticHash: deps.staticHash(),
              };
              active.exporter.exportPrompt({ who, mode, text, sectionSizes: promptOpts?.sectionSizes ?? null, sectionHashes: promptOpts?.sectionHashes ?? null, hashSection: (content) => sha256Hex(redactByValue(content)) });
              result.then(
                (output) => active.exporter.exportOutput({ who, mode, text: typeof output === "string" ? output : "" }),
                () => {},
              );
            }
          } catch {
            /* Observability never changes how a prompt ends. */
          }
          return result;
        },
      };
    },
  };
}
