/* The run's sandbox scope as the engine sees it. A run opens its scope through this port, and the views the run flow needs of the scope that is active (the scope itself, whether the launcher refused a child, what the egress layer made of the run) are methods of it, so no use case reaches the process sandbox. The implementation is in shared-infrastructure/process-sandbox. */

import type { Attrs } from "../telemetry/attribute-registry.ts";
import type { TelemetryContext } from "../telemetry/telemetry.port.ts";

/* What the egress layer made of the run, for the run's gate signals. */
export interface SandboxReport {
  /* "enforced": every sandboxed child was held to its profile's origins. "unenforced": the filter was unavailable and the operator allowed that (warn mode). "not-applicable": no child was spawned. */
  egress: "enforced" | "unenforced" | "not-applicable";
  /* Hosts a child tried to reach that the run's policy does not declare, without duplicates, in first-seen order. */
  denied: string[];
  /* Why the launcher refused to start a child in this run, when it did: the run then ends E-SANDBOX whatever path it took to its infra-error. */
  refusal?: "uid" | "files" | "egress" | "residue";
  /* Told every refusal while a window is open (openDeniedWindow), a host the run was already refused included: `denied` keeps each host once, which cannot say whether a given child met it. */
  watchers?: Set<(host: string) => void>;
}

export interface RunScope {
  runId: string;
  /* `/tmp/qa-exec/<runId>`: the one directory the sandbox uid writes in. */
  workDir: string;
  /* The orchestrator-only directory holding the saved session and certificate. Never opened to a child; a spawn gets a copy. */
  authDir?: string;
  /* The DEV gate's HTTP Basic credentials, when the app has one. */
  gateCreds?: { user: string; pass: string };
  /* The test account, for a suite whose app opted in (e2e.specCredentials: account). Absent: specs never see the account. */
  suiteAccount?: { user: string; pass: string };
  /* The origins each kind of child may reach: `dev` for a suite or a login, `install` for a package-manager or toolchain child. A child of the offline profile reaches none. */
  egress: { dev: readonly string[]; install: readonly string[] };
  report: SandboxReport;
  /* The mirrors the launcher gave the sandbox's group for this run; the scope's end gives them back. */
  openedMirrors?: Set<string>;
  /* Set on a scope derived from the run's (withExecScopeParent): the run's own scope, which anything kept per run is keyed by. */
  base?: RunScope;
  /* Where the run's trace stands, set by the run: the launcher parents the span of each child to `parent()`, the phase that is open. Absent or undefined: the active context decides. */
  telemetry?: {
    parent(): TelemetryContext | undefined;
    /* Wall-clock ms the open phase started at, when known: spans synthesized from what a child reported are kept after it. */
    phaseStart?(): number | undefined;
    /* Sets attributes on the open phase's span. */
    annotate?(attrs: Attrs): void;
  };
}

/* The run's sandbox as the use case sees it: the scope is opened for the run and its work dir is removed when the run ends, however it ends. */
export interface ExecScopeSession {
  run<T>(fn: () => T): T;
  close(): void;
}

/* An error that says the sandbox is not safe to run agent code in, and why. */
export interface SandboxRefusal extends Error {
  readonly reason: "uid" | "files" | "egress" | "scope" | "residue";
}

export interface ExecScopePort {
  /* Async because bringing the egress filter up for a run's origins is. */
  open(input: { runId: string }): ExecScopeSession | Promise<ExecScopeSession>;
  /* The scope the calling code runs in, when it runs inside a run's. */
  activeExecScope(): RunScope | undefined;
  /* The scope of a run that never got one: the sandbox refused to open it. Spawns nothing. */
  refusedScope(runId: string, refusal: NonNullable<SandboxReport["refusal"]>): RunScope;
  /* Runs `fn` inside `scope`. */
  withExecScope<T>(scope: RunScope, fn: () => T): T;
  /* True when the launcher refused a child in the run this call is part of. */
  sandboxRefused(): boolean;
  /* What a run's sandbox did, for the persisted gate signals: absent when no child was ever started or refused. */
  sandboxSignal(): { egress: SandboxReport["egress"]; denied: string[] } | undefined;
  /* Whether an error is the sandbox refusing to open the run's scope. */
  isSandboxUnavailable(err: unknown): err is SandboxRefusal;
}
