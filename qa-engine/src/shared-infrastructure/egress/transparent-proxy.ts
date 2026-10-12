/* The transparent proxy for the sandbox uid's TCP traffic. The kernel redirects each connection the sandbox uid makes to an allowed upstream port to a listener of this proxy (one per upstream port); the proxy reads the name the connection asks for (destination-sniffer.ts), asks the policy, and opens its own connection to that NAME, resolved afresh for every connection, never to the address the client had. A spoofed name can therefore only reach a host the policy already allows, and a hostname that re-resolves to a loopback address (DNS rebinding toward the API on 127.0.0.1) is refused unless the rule names loopback itself. No TLS is terminated: the client's bytes are piped as they came. A name that is missing, unreadable or not allowed gets a reset, and the name (never the payload) is reported as denied.
   Network and DNS are injected so the rules are testable with in-process sockets. */

import dns from "node:dns";
import net from "node:net";
import os from "node:os";
import { classifyAddress } from "./address-class.ts";
import { MAX_SNIFF_BYTES, sniffDestination } from "./destination-sniffer.ts";

export interface TransparentProxyDeps {
  /* Whether the connection to `host`:`port` is allowed right now (any active lease). */
  allows(host: string, port: number): boolean;
  /* A connection was refused. `host` is the name it asked for, when it asked for one. */
  onDenied(host: string | undefined, port: number): void;
  /* Whether a rule declares exactly this IP literal on this port. Only such an address lets a name lead to a private, link-local or otherwise internal address; absent: none does. */
  declaresAddress?(address: string, port: number): boolean;
  /* The addresses of this machine's own interfaces, which a name must never lead to (the API listens there). Defaults to the interfaces of the host. */
  localAddresses?(): ReadonlySet<string>;
  /* Opens the upstream connection. A test seam. */
  connect?(address: string, port: number): net.Socket;
  /* The address of `host`, looked up for this connection. */
  resolve?(host: string): Promise<string>;
  /* The upstream port a listener stands for. Defaults to the port it was created for. */
  upstreamPort?(listenerFor: number): number;
  /* Milliseconds a connection may take to name its destination, and may sit idle once piped. */
  nameTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxConnections?: number;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function isLoopbackAddress(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.") || address === "0.0.0.0";
}

export class TransparentProxy {
  private readonly servers = new Map<number, { server: net.Server; localPort: number }>();
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly deps: TransparentProxyDeps) {}

  /* Starts (once) the listener for connections that were headed to `upstream`; returns the local port the kernel must redirect them to. */
  async listen(upstream: number): Promise<number> {
    const existing = this.servers.get(upstream);
    if (existing) return existing.localPort;
    const server = net.createServer((socket) => this.handle(socket, upstream));
    server.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    /* The listeners never keep a process alive on their own: an operator script that ends must be able to exit. */
    server.unref();
    const localPort = (server.address() as net.AddressInfo).port;
    this.servers.set(upstream, { server, localPort });
    return localPort;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await Promise.all([...this.servers.values()].map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))));
    this.servers.clear();
  }

  /* Whether the address a declared name resolved to is somewhere the sandbox must not be taken. Loopback (the API on 127.0.0.1) only when the rule names loopback itself; this machine's own interface addresses never; any other non-public address (private, which holds the docker networks, link-local, carrier-grade NAT, multicast, unique-local, reserved) only when the app declared that very address as an IP literal. */
  private refusesAddress(host: string, address: string, port: number): boolean {
    if (isLoopbackAddress(address)) return !LOOPBACK_HOSTS.has(host);
    if ((this.deps.localAddresses ?? ownAddresses)().has(address)) return true;
    return classifyAddress(address) !== "public" && !(this.deps.declaresAddress?.(address, port) ?? false);
  }

  private handle(client: net.Socket, listenerFor: number): void {
    const upstreamPort = this.deps.upstreamPort ? this.deps.upstreamPort(listenerFor) : listenerFor;
    if (this.sockets.size >= (this.deps.maxConnections ?? 512)) {
      client.destroy();
      this.deps.onDenied(undefined, upstreamPort);
      return;
    }
    this.sockets.add(client);
    client.on("close", () => this.sockets.delete(client));
    client.on("error", () => client.destroy());
    client.setNoDelay(true);

    const chunks: Buffer[] = [];
    let size = 0;
    let decided = false;
    const deny = (host: string | undefined): void => {
      if (decided) return;
      decided = true;
      clearTimeout(nameTimer);
      client.destroy();
      this.deps.onDenied(host, upstreamPort);
    };
    const nameTimer = setTimeout(() => deny(undefined), this.deps.nameTimeoutMs ?? 10_000);

    client.on("data", function onData(this: net.Socket, chunk: Buffer) {
      if (decided) return;
      chunks.push(chunk);
      size += chunk.length;
      const head = Buffer.concat(chunks);
      const seen = sniffDestination(head);
      if (seen.kind === "need-more") {
        if (size >= MAX_SNIFF_BYTES) deny(undefined);
        return;
      }
      if (seen.kind === "unknown" || seen.host === undefined) return deny(seen.kind === "unknown" ? undefined : seen.host);
      decided = true;
      clearTimeout(nameTimer);
      client.removeListener("data", onData);
      client.pause();
      void connect(seen.host, head);
    });
    client.on("close", () => clearTimeout(nameTimer));

    const connect = async (host: string, head: Buffer): Promise<void> => {
      if (!this.deps.allows(host, upstreamPort)) {
        client.destroy();
        this.deps.onDenied(host, upstreamPort);
        return;
      }
      let address: string;
      try {
        address = await (this.deps.resolve ?? defaultResolve)(host);
      } catch {
        client.destroy();
        this.deps.onDenied(host, upstreamPort);
        return;
      }
      if (this.refusesAddress(host, address, upstreamPort)) {
        client.destroy();
        this.deps.onDenied(host, upstreamPort);
        return;
      }
      if (client.destroyed) return;
      const upstream = this.deps.connect ? this.deps.connect(address, upstreamPort) : net.connect({ host: address, port: upstreamPort });
      this.sockets.add(upstream);
      upstream.on("close", () => this.sockets.delete(upstream));
      const idle = this.deps.idleTimeoutMs ?? 300_000;
      upstream.setTimeout(idle, () => upstream.destroy());
      client.setTimeout(idle, () => client.destroy());
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
      upstream.once("connect", () => {
        upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
    };
  }
}

async function defaultResolve(host: string): Promise<string> {
  const result = await dns.promises.lookup(host, { family: 4 });
  return result.address;
}

function ownAddresses(): ReadonlySet<string> {
  const own = new Set<string>();
  for (const entries of Object.values(os.networkInterfaces())) for (const entry of entries ?? []) own.add(entry.address);
  return own;
}
