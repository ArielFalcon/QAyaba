/* What a sandboxed child needs to know about the run it belongs to, carried through the run's async calls (AsyncLocalStorage) like the run's secret scope, so that the many spawn sites do not each take the run's directories and credentials as parameters. The run opens it (`withExecScope`); the launcher reads it. Outside a run there is none, and the launcher refuses to spawn. */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Attrs } from "../../shared-kernel/telemetry/attribute-registry.ts";
import type { TelemetryContext } from "../../shared-kernel/telemetry/telemetry.port.ts";
import type { RunScope, SandboxReport } from "../../shared-kernel/ports/exec-scope.port.ts";

export type { ExecScopePort, ExecScopeSession, RunScope, SandboxReport } from "../../shared-kernel/ports/exec-scope.port.ts";

const store = new AsyncLocalStorage<RunScope>();

export function withExecScope<T>(scope: RunScope, fn: () => T): T {
  return store.run(scope, fn);
}

/* The scope anything kept per run is keyed by: the run's own, whether the active scope is it or one derived from it. */
export function runScopeKey(scope: RunScope): RunScope {
  return scope.base ?? scope;
}

/*
 * Runs `fn` in the active scope with the parent of every child's span replaced: a tool call the orchestrator serves for an agent
 * (run_spec) hangs its children under the call's own span, not under the phase that happens to be open. The phase's other hooks stay
 * (`phaseStart`, `annotate`) unless the call gives its own: a report read inside the call is placed after the call's start and what
 * it annotates goes on the call's span. The copy shares the run's report, mirrors and directories (they are references) and names
 * the run's scope as its `base`, so state kept per run is still the run's. Outside a run there is no scope to change.
 */
export function withExecScopeParent<T>(parent: TelemetryContext, fn: () => T, own: { startedAt?: number; annotate?: (attrs: Attrs) => void } = {}): T {
  const scope = store.getStore();
  if (!scope) return fn();
  const phase = scope.telemetry;
  const telemetry: NonNullable<RunScope["telemetry"]> = {
    parent: () => parent,
    ...(own.startedAt !== undefined ? { phaseStart: () => own.startedAt } : phase?.phaseStart ? { phaseStart: () => phase.phaseStart!() } : {}),
    ...(own.annotate ? { annotate: own.annotate } : phase?.annotate ? { annotate: (attrs: Attrs) => phase.annotate!(attrs) } : {}),
  };
  return store.run({ ...scope, base: scope.base ?? scope, telemetry }, fn);
}

export function activeExecScope(): RunScope | undefined {
  return store.getStore();
}

export function newSandboxReport(): SandboxReport {
  return { egress: "not-applicable", denied: [] };
}

/* The scope of a run that never got one: the sandbox refused to open it, and the run's last words are said inside this one so that the refusal is what classifies how it ended. It has no work dir and spawns nothing. */
export function refusedScope(runId: string, refusal: NonNullable<SandboxReport["refusal"]>): RunScope {
  return { runId, workDir: "", egress: { dev: [], install: [] }, report: { egress: "not-applicable", denied: [], refusal } };
}

/* What a run's sandbox did, for the persisted gate signals: absent when no child was ever started or refused. */
export function sandboxSignal(): { egress: SandboxReport["egress"]; denied: string[] } | undefined {
  const report = store.getStore()?.report;
  if (report === undefined || (report.egress === "not-applicable" && report.denied.length === 0)) return undefined;
  return { egress: report.egress, denied: [...report.denied] };
}

/* A stretch of a run in which the hosts the egress filter refused are collected on their own, apart from the run's list (which keeps each host once, from its first sighting): a caller that must know whether the children it started were refused something asks for one before it starts them. Outside a run it hears nothing. */
export function openDeniedWindow(scope?: RunScope): { hosts(): string[]; close(): void } {
  const report = (scope ?? store.getStore())?.report;
  const heard: string[] = [];
  const watcher = (host: string): void => {
    if (heard.length < MAX_WINDOW_HOSTS && !heard.includes(host)) heard.push(host);
  };
  if (report) (report.watchers ??= new Set()).add(watcher);
  return {
    hosts: () => [...heard],
    close: () => {
      report?.watchers?.delete(watcher);
    },
  };
}

const MAX_WINDOW_HOSTS = 64;

/* True when the launcher refused a child in the run this call is part of. */
export function sandboxRefused(): boolean {
  return store.getStore()?.report.refusal !== undefined;
}
