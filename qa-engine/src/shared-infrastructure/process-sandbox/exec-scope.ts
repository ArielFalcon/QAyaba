/* What a sandboxed child needs to know about the run it belongs to, carried through the run's async calls (AsyncLocalStorage) like the run's secret scope, so that the many spawn sites do not each take the run's directories and credentials as parameters. The run opens it (`withExecScope`); the launcher reads it. Outside a run there is none, and the launcher refuses to spawn. */

import { AsyncLocalStorage } from "node:async_hooks";

/* What the egress layer made of the run, for the run's gate signals. */
export interface SandboxReport {
  /* "enforced": every sandboxed child was held to its profile's origins. "unenforced": the filter was unavailable and the operator allowed that (warn mode). "not-applicable": no child was spawned. */
  egress: "enforced" | "unenforced" | "not-applicable";
  /* Hosts a child tried to reach that the run's policy does not declare, without duplicates, in first-seen order. */
  denied: string[];
  /* Why the launcher refused to start a child in this run, when it did: the run then ends E-SANDBOX whatever path it took to its infra-error. */
  refusal?: "uid" | "egress";
}

export interface RunScope {
  runId: string;
  /* `/tmp/qa-exec/<runId>`: the one directory the sandbox uid writes in. */
  workDir: string;
  /* The orchestrator-only directory holding the saved session and certificate. Never opened to a child; a spawn gets a copy. */
  authDir?: string;
  /* The DEV gate's HTTP Basic credentials, when the app has one. */
  gateCreds?: { user: string; pass: string };
  /* The origins each kind of child may reach: `dev` for a suite or a login, `install` for a package-manager or toolchain child. A child of the offline profile reaches none. */
  egress: { dev: readonly string[]; install: readonly string[] };
  report: SandboxReport;
}

const store = new AsyncLocalStorage<RunScope>();

export function withExecScope<T>(scope: RunScope, fn: () => T): T {
  return store.run(scope, fn);
}

export function activeExecScope(): RunScope | undefined {
  return store.getStore();
}

export function newSandboxReport(): SandboxReport {
  return { egress: "not-applicable", denied: [] };
}

/* What a run's sandbox did, for the persisted gate signals: absent when no child was ever started or refused. */
export function sandboxSignal(): { egress: SandboxReport["egress"]; denied: string[] } | undefined {
  const report = store.getStore()?.report;
  if (report === undefined || (report.egress === "not-applicable" && report.denied.length === 0)) return undefined;
  return { egress: report.egress, denied: [...report.denied] };
}

/* True when the launcher refused a child in the run this call is part of. */
export function sandboxRefused(): boolean {
  return store.getStore()?.report.refusal !== undefined;
}

/* The run's sandbox as the use case sees it: the scope is opened for the run and its work dir is removed when the run ends, however it ends. */
export interface ExecScopeSession {
  run<T>(fn: () => T): T;
  close(): void;
}

export interface ExecScopePort {
  open(input: { runId: string }): ExecScopeSession;
}
