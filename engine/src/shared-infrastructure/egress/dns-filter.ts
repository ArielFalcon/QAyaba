/* The DNS filter for the sandbox uid: the kernel redirects its UDP port-53 traffic here. A name the policy declares is forwarded, byte for byte, to the real resolver; every other name gets NXDOMAIN, so the child cannot even learn an address it is not meant to reach (and a name cannot carry data out to a resolver an attacker controls). An AAAA question for a declared name gets an empty answer, because IPv6 is closed to the sandbox uid and a client should stay on IPv4. Only a single, well-formed question is answered; anything else is dropped, and a resolver that fails leaves the lookup unanswered rather than inventing one. */

import dgram from "node:dgram";

export interface DnsFilterDeps {
  allowsName(name: string): boolean;
  onDenied(name: string): void;
  /* Sends the query to the real resolver and returns its answer. */
  forward(query: Buffer): Promise<Buffer>;
}

const TYPE_AAAA = 28;

export function parseDnsQuestion(message: Buffer): { name: string; type: number; end: number } | undefined {
  if (message.length < 17) return undefined;
  if (message.readUInt16BE(4) !== 1) return undefined;
  const labels: string[] = [];
  let o = 12;
  for (;;) {
    if (o >= message.length) return undefined;
    const length = message[o]!;
    if (length === 0) { o += 1; break; }
    if (length > 63 || (length & 0xc0) !== 0) return undefined;
    if (o + 1 + length > message.length) return undefined;
    labels.push(message.toString("latin1", o + 1, o + 1 + length));
    o += 1 + length;
  }
  if (o + 4 > message.length) return undefined;
  const name = labels.join(".").toLowerCase();
  if (name.length === 0 || name.length > 253 || !/^[a-z0-9._-]+$/.test(name)) return undefined;
  return { name, type: message.readUInt16BE(o), end: o + 4 };
}

/* A standard query for `name` and `type`, as a resolver library would send it. */
export function buildDnsQuery(id: number, name: string, type: number): Buffer {
  const labels = name.split(".").flatMap((label) => [Buffer.from([label.length]), Buffer.from(label, "latin1")]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(type, 1);
  tail.writeUInt16BE(1, 3);
  return Buffer.concat([header, ...labels, tail]);
}

function reply(query: Buffer, end: number, rcode: number): Buffer {
  const response = Buffer.from(query.subarray(0, end));
  const flags = (query.readUInt16BE(2) & 0x7900) | 0x8000 | 0x0080 | rcode;
  response.writeUInt16BE(flags, 2);
  response.writeUInt16BE(0, 6);
  response.writeUInt16BE(0, 8);
  response.writeUInt16BE(0, 10);
  return response;
}

export class DnsFilter {
  private socket: dgram.Socket | undefined;

  constructor(private readonly deps: DnsFilterDeps) {}

  async listen(): Promise<number> {
    if (this.socket) return (this.socket.address() as { port: number }).port;
    const socket = dgram.createSocket("udp4");
    socket.on("message", (message, remote) => void this.answer(socket, message, remote));
    socket.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, "127.0.0.1", () => resolve());
    });
    socket.unref();
    this.socket = socket;
    return socket.address().port;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (socket) await new Promise<void>((resolve) => socket.close(() => resolve()));
  }

  private async answer(socket: dgram.Socket, query: Buffer, remote: dgram.RemoteInfo): Promise<void> {
    const question = parseDnsQuestion(query);
    if (!question) return;
    const send = (message: Buffer): void => { try { socket.send(message, remote.port, remote.address); } catch { /* the client is gone */ } };
    if (!this.deps.allowsName(question.name)) {
      this.deps.onDenied(question.name);
      send(reply(query, question.end, 3));
      return;
    }
    if (question.type === TYPE_AAAA) {
      send(reply(query, question.end, 0));
      return;
    }
    try {
      send(await this.deps.forward(query));
    } catch {
      /* unanswered: the client times out and retries or fails, which is what a resolver outage looks like */
    }
  }
}
