/* The egress filter as the execution launcher sees it. It keeps one policy per child (a lease), answers the proxy and the DNS filter with the union of the leases held at that moment, and brings the filter up for a run's declared origins before the run's first child: a transparent-proxy listener per upstream port, the DNS filter, and the kernel rules that send the sandbox uid's traffic to them. With no lease held nothing is allowed, so a child that outlives its lease, or a connection that arrives between runs, reaches nothing.
   The filter is `available()` only when everything is in place: the boot self-test (bin/egress-init.sh) left `ok` in its status file, the jumps from OUTPUT are still there, and the rules for every prepared port were applied. Anything else leaves it unavailable, once and in words, and the mode decides what that means (enforce: the run ends E-SANDBOX; warn: it runs unfiltered and says so). A stale rule sends traffic to a listener that is gone, which the kernel answers with a refusal; a missing rule is closed by the kernel's reject: both fail closed. */

import type { EgressGate, EgressLease } from "../process-sandbox/exec-sandbox.ts";
import type { SandboxReport } from "../process-sandbox/exec-scope.ts";
import { compileEgressPolicy, type EgressPolicy } from "./egress-policy.ts";
import type { IptablesApplier } from "./iptables-runner.ts";

export interface ProxyPort {
  listen(upstream: number): Promise<number>;
  close(): Promise<void>;
}

export interface DnsPort {
  listen(): Promise<number>;
  close(): Promise<void>;
}

export interface EgressHooks {
  allows(host: string, port: number): boolean;
  allowsName(name: string): boolean;
  declaresAddress(address: string, port: number): boolean;
  onDenied(host: string | undefined, port?: number): void;
}

export interface EgressControllerDeps {
  mode: "enforce" | "warn";
  uid: number;
  /* The contents of the file the boot self-test wrote, or undefined when there is none. */
  readStatus(): string | undefined;
  createProxy(hooks: EgressHooks): ProxyPort;
  createDns(hooks: EgressHooks): DnsPort;
  iptables: IptablesApplier;
  warn(line: string): void;
}

const MAX_DENIED_PER_RUN = 64;

interface Held {
  policy: EgressPolicy;
  report: SandboxReport | undefined;
}

export class EgressController implements EgressGate {
  readonly mode: "enforce" | "warn";
  private readonly leases = new Set<Held>();
  private readonly redirects = new Map<number, number>();
  private readonly proxy: ProxyPort;
  private readonly dns: DnsPort;
  private dnsPort: number | undefined;
  private ready = false;
  private told = new Set<string>();

  constructor(private readonly deps: EgressControllerDeps) {
    this.mode = deps.mode;
    const hooks: EgressHooks = {
      allows: (host, port) => this.allows(host, port),
      allowsName: (name) => this.allowsName(name),
      declaresAddress: (address, port) => this.declaresAddress(address, port),
      onDenied: (host) => this.noteDenied(host),
    };
    this.proxy = deps.createProxy(hooks);
    this.dns = deps.createDns(hooks);
  }

  available(): boolean {
    return this.ready;
  }

  async prepare(origins: readonly string[]): Promise<void> {
    const status = this.deps.readStatus()?.trim();
    if (status !== "ok") {
      this.fail(`the boot self-test did not pass (${status ?? "no status file"})`);
      return;
    }
    try {
      const ports = [...compileEgressPolicy(origins).ports];
      const fresh = ports.filter((port) => !this.redirects.has(port));
      if (this.dnsPort === undefined) this.dnsPort = await this.dns.listen();
      for (const port of fresh) this.redirects.set(port, await this.proxy.listen(port));
      const jumps = this.deps.iptables.verifyJumps(this.deps.uid);
      if (jumps !== undefined) {
        this.fail(jumps);
        return;
      }
      /* Applied at every run, not only when a port is new: the chain belongs to the container, and another process of this image (an operator script that runs suites outside the queue) rewrites it for its own listeners. The run's own rules are put back before its first child, and the rewrite is one atomic commit. */
      this.deps.iptables.apply({ uid: this.deps.uid, dnsPort: this.dnsPort, redirects: [...this.redirects].map(([upstream, local]) => ({ upstream, local })) });
      this.ready = true;
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  lease(origins: readonly string[], report?: SandboxReport): EgressLease {
    const held: Held = { policy: compileEgressPolicy(origins), report };
    this.leases.add(held);
    return { release: () => { this.leases.delete(held); } };
  }

  allows(host: string, port: number): boolean {
    for (const held of this.leases) if (held.policy.allows(host, port)) return true;
    return false;
  }

  allowsName(name: string): boolean {
    for (const held of this.leases) if (held.policy.allowsName(name)) return true;
    return false;
  }

  declaresAddress(address: string, port: number): boolean {
    for (const held of this.leases) if (held.policy.declaresAddress(address, port)) return true;
    return false;
  }

  noteDenied(host: string | undefined): void {
    if (host === undefined) return;
    for (const held of this.leases) {
      const report = held.report;
      if (!report) continue;
      if (report.denied.length < MAX_DENIED_PER_RUN && !report.denied.includes(host)) report.denied.push(host);
      for (const watcher of report.watchers ?? []) watcher(host);
    }
  }

  async close(): Promise<void> {
    this.ready = false;
    await Promise.all([this.proxy.close(), this.dns.close()]);
  }

  private fail(reason: string): void {
    this.ready = false;
    if (this.told.has(reason)) return;
    this.told.add(reason);
    this.deps.warn(`[qa] WARNING: the egress filter is NOT active: ${reason}. QA_EGRESS_MODE=${this.mode}: ${this.mode === "enforce" ? "runs that execute agent code end E-SANDBOX" : "agent code runs with this container's full network"}.`);
  }
}
