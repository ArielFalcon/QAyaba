/* DeployGatePort over a declared version source: the reader says which commit DEV serves, the mirror's history relates it to the run's sha, and the pure decision names the state and whether to wait. Timeouts resolve InfraError, never throw. The reader and the history are injected so this adapter needs no network and no git in its own tests. */

import type { Sha } from "@kernel/sha.ts";
import type { Result } from "@kernel/result.ts";
import { ok, err } from "@kernel/result.ts";
import { InfraError } from "@kernel/domain-error.ts";
import { engineLog } from "@kernel/ports/process-logger.ts";
import type { DeployGatePort } from "@kernel/ports/deploy-gate.port.ts";
import type { CommitAncestryPort, CommitRelation } from "@kernel/ports/commit-ancestry.port.ts";
import type { ServedVersionReaderPort } from "@kernel/ports/served-version-reader.port.ts";
import type { TriggerSource } from "@kernel/run-mode.ts";
import { DeployNotServedError, type ServedVersionFact, type ServedVersionRead } from "@kernel/served-version.ts";
import { needsHistory, servedState, waitsForDeploy } from "../../domain/served-version.ts";

export interface DeployGatePortConfig {
  versionUrl: string;
  intervalMs: number;
  timeoutMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DeployGatePortAdapter implements DeployGatePort {
  constructor(
    private readonly reader: ServedVersionReaderPort,
    /* Absent: a served commit that is not the run's own cannot be related to it, and the fact says so. */
    private readonly ancestry: CommitAncestryPort | undefined,
    private readonly cfg: DeployGatePortConfig,
  ) {}

  async verifyServed(sha: Sha, run: { source: TriggerSource; startedAt?: number }): Promise<Result<ServedVersionFact, InfraError>> {
    const startedAt = run.startedAt ?? Date.now();
    const deadline = startedAt + this.cfg.timeoutMs;
    /* A relation that answered stays true for the wait; one that did not (a commit the mirror lacks, a git fault) is asked again. */
    const known = new Map<string, CommitRelation>();
    let fact = await this.observe(sha, known);
    let waiting = waitsForDeploy(fact.state, run.source);
    /* Once waiting on a deploy, a read that gave nothing is one more poll: only a state that says where DEV stands ends the wait. */
    while (waiting && (waitsForDeploy(fact.state, run.source) || this.inconclusive(fact))) {
      if (Date.now() >= deadline) {
        const seen = fact.served !== undefined ? `; DEV serves ${fact.served} (${fact.state})` : `; the last read was ${fact.state}${fact.reason !== undefined ? ` (${fact.reason})` : ""}`;
        return err(new DeployNotServedError(`DEV did not serve sha ${sha.toString()} within ${this.cfg.timeoutMs}ms (versionUrl=${this.cfg.versionUrl})${seen}`, { ...fact, waitedMs: Date.now() - startedAt }));
      }
      if (this.cfg.intervalMs > 0) await sleep(this.cfg.intervalMs);
      fact = await this.observe(sha, known);
    }
    return ok(waiting ? { ...fact, waitedMs: Date.now() - startedAt } : fact);
  }

  async waitUntilHealthy(opts: { startedAt?: number; servedSha?: Sha } = {}): Promise<Result<true, InfraError>> {
    const deadline = (opts.startedAt ?? Date.now()) + this.cfg.timeoutMs;
    while (Date.now() < deadline) {
      const read = await this.reader.read(this.cfg.versionUrl);
      if (read.kind === "read") {
        if (opts.servedSha !== undefined && needsHistory(read.commit, opts.servedSha)) {
          const fact = await this.classify(read, opts.servedSha, new Map());
          return err(new DeployNotServedError(`DEV no longer serves sha ${opts.servedSha.toString()} (it serves ${read.commit}, ${fact.state})`, fact));
        }
        if (read.healthy === true) return ok(true);
      }
      if (this.cfg.intervalMs > 0) await sleep(this.cfg.intervalMs);
    }
    return err(new InfraError(`DEV did not report healthy within ${this.cfg.timeoutMs}ms (versionUrl=${this.cfg.versionUrl})`));
  }

  /* A read that did not say where DEV stands: the source gave nothing, or the history failed. A commit the mirror lacks is an answer. */
  private inconclusive(fact: ServedVersionFact): boolean {
    return fact.state === "unreadable" && fact.reason !== "commit-not-in-history";
  }

  private async observe(sha: Sha, known: Map<string, CommitRelation>): Promise<ServedVersionFact> {
    return this.classify(await this.reader.read(this.cfg.versionUrl), sha, known);
  }

  private async classify(read: ServedVersionRead, sha: Sha, known: Map<string, CommitRelation>): Promise<ServedVersionFact> {
    if (read.kind === "unreadable") return { state: "unreadable", reason: read.reason };
    const served = read.commit;
    if (!needsHistory(served, sha)) return { state: "equal", served };
    const relation = await this.relationOf(served, sha, known);
    if (relation === undefined) return { state: "unreadable", reason: "history-unavailable", served };
    if (relation === "unknown-commit") return { state: "unreadable", reason: "commit-not-in-history", served };
    return { state: servedState(served, sha, relation), served };
  }

  private async relationOf(served: string, sha: Sha, known: Map<string, CommitRelation>): Promise<CommitRelation | undefined> {
    const remembered = known.get(served);
    if (remembered !== undefined) return remembered;
    if (this.ancestry === undefined) return undefined;
    try {
      const relation = await this.ancestry.relation(served, sha);
      if (relation !== "unknown-commit") known.set(served, relation);
      return relation;
    } catch (cause) {
      engineLog.error(`[qa] the history could not relate the served commit ${served} to ${sha.short} (the fact is recorded unreadable and the run goes on): ${cause instanceof Error ? cause.message : String(cause)}`);
      return undefined;
    }
  }
}

/* The gate of an app that declares no version source (static sites): the fact is `undeclared`, never a silent ok that reads as verified. */
export class NullDeployGateAdapter implements DeployGatePort {
  async verifyServed(_sha: Sha, _run: { source: TriggerSource; startedAt?: number }): Promise<Result<ServedVersionFact, InfraError>> {
    return ok({ state: "undeclared" });
  }

  async waitUntilHealthy(_opts?: { startedAt?: number; servedSha?: Sha }): Promise<Result<true, InfraError>> {
    return ok(true);
  }
}
