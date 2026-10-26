/*
 * The turn span lives at the AgentDeps facade: the level the stall watchdog and the session registration wrap, so it sees the
 * role, the session, the prompt options and the result for every prompt, and sees a watchdog's abort (which rejects only the outer
 * promise; the attempt below keeps running until its own timeout). It adds no await to the prompt path: the prompt's promise is
 * returned untouched and only observed.
 */
import { engineLog } from "@kernel/ports/process-logger.ts";
import { activeRunSecretScope, redactByValue } from "../../../../shared-kernel/run-secret-redaction.ts";
import { activeExecScope } from "../../../../shared-infrastructure/process-sandbox/exec-scope.ts";
import { guardTelemetry } from "@kernel/telemetry/guarded-telemetry.ts";
import type { RedactionScope, SpanHandle, TelemetryClock, TelemetryContext, TelemetryPort } from "@kernel/telemetry/telemetry.port.ts";
import type { AgentDeps } from "../agent-transport-policy.ts";
import type { StepIntentContext } from "../../domain/step-intent.ts";
import { TurnProbe, type TurnIdentity } from "./turn-probe.ts";
import { agentTurnTraces, type AgentTurnTraces } from "./turn-trace-registry.ts";

export interface TurnTelemetryDeps {
  telemetry: TelemetryPort;
  clock: TelemetryClock;
  /* What classifies a step and a navigation: built from the app's own configuration by the composition root. */
  intent: StepIntentContext;
  traces?: AgentTurnTraces;
  /* Where the turn hangs. Default: the phase the run has open (its exec scope). Absent or undefined: the active context. */
  parent?: () => TelemetryContext | undefined;
  /* Default: the run's secret scope in effect when the prompt starts. */
  secrets?: () => RedactionScope | undefined;
  watchHost?: (span: SpanHandle) => () => void;
  /* The step cap the repository's copy of the agent configuration declares: recorded as a config fact, never as the limit the turn ran under. */
  stepLimitFor?: (agent: string) => number | undefined;
  /* The model and reasoning effort the repository's copy of the agent configuration declares, as `provider/model`. */
  agentConfig?: (agent: string) => { model?: string; reasoningEffort?: string } | undefined;
}

const defaultParent = (): TelemetryContext | undefined => activeExecScope()?.telemetry?.parent();

export function withTurnTelemetry(base: AgentDeps, deps: TurnTelemetryDeps): AgentDeps {
  const telemetry = guardTelemetry(deps.telemetry);
  const traces = deps.traces ?? agentTurnTraces;
  return {
    ...base,
    open: async (agent, cwd, opts) => {
      const inner = await base.open(agent, cwd, opts);
      let probes: TurnProbe[] = [];
      return {
        ...inner,
        prompt: (text, promptOpts) => {
          const mine = startProbe();
          if (mine) probes = [...probes.filter((p) => !p.isDone()), mine];
          let result: Promise<string>;
          try {
            result = inner.prompt(text, promptOpts);
          } catch (error) {
            /* A refusal before the prompt starts (the circuit breaker) is the turn's whole story. */
            mine?.settle({ ok: false, error });
            throw error;
          }
          /* Observed on a branch, so the caller's promise is the transport's own. */
          result.then(
            () => mine?.settle({ ok: true }),
            (error: unknown) => mine?.settle({ ok: false, error }),
          );
          return result;

          function startProbe(): TurnProbe | undefined {
            try {
              const config = deps.agentConfig?.(agent);
              const configuredSteps = deps.stepLimitFor?.(agent);
              const redacted = redactByValue(text);
              const identity: TurnIdentity = {
                agent,
                role: opts?.descriptor?.role ?? agent,
                sessionId: inner.id,
                round: promptOpts?.round,
                repair: promptOpts?.isRepair ?? false,
                delegationId: opts?.descriptor?.delegationId,
                requestedModel: opts?.model,
                config: config || configuredSteps !== undefined ? { model: config?.model, reasoningEffort: config?.reasoningEffort, stepsLimit: configuredSteps } : undefined,
                stepLimit: promptOpts?.stepLimit,
                prompt: {
                  bytes: Buffer.byteLength(redacted, "utf8"),
                  sectionSizes: promptOpts?.sectionSizes ?? null,
                  sectionHashes: promptOpts?.sectionHashes ?? null,
                  sectionItems: promptOpts?.sectionItems ?? null,
                  sectionsDropped: promptOpts?.sectionsDropped,
                  budgetBytes: promptOpts?.promptBudgetBytes,
                },
              };
              const created = new TurnProbe(
                {
                  telemetry,
                  clock: deps.clock,
                  intent: deps.intent,
                  parent: (deps.parent ?? defaultParent)(),
                  secrets: (deps.secrets ?? activeRunSecretScope)(),
                  watchHost: deps.watchHost,
                },
                identity,
              );
              traces.begin(inner.id, created);
              return created;
            } catch (err) {
              engineLog.error(`[qa] turn telemetry could not start and is off for this prompt: ${err instanceof Error ? err.message : String(err)}`);
              return undefined;
            }
          }
        },
        dispose: async () => {
          for (const probe of probes) probe.closeAll();
          traces.end(inner.id);
          await inner.dispose();
        },
      };
    },
  };
}
