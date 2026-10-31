/* Forwards one DNS query, byte for byte, to the container's own resolver (the first nameserver of /etc/resolv.conf: Docker's embedded 127.0.0.11, or the pinned public resolvers), from this process, which is not the sandbox uid and so is not filtered. */

import dgram from "node:dgram";
import { readFileSync } from "node:fs";

export function firstNameserver(resolvConf: string): string {
  for (const line of resolvConf.split("\n")) {
    const match = /^\s*nameserver\s+(\d{1,3}(?:\.\d{1,3}){3})\s*$/.exec(line);
    if (match) return match[1]!;
  }
  return "1.1.1.1";
}

export function forwardDnsQuery(query: Buffer, timeoutMs = 3000, resolvConf: () => string = () => readFileSync("/etc/resolv.conf", "utf8")): Promise<Buffer> {
  const upstream = firstNameserver(resolvConf());
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => { socket.close(); reject(new Error(`DNS upstream ${upstream} did not answer`)); }, timeoutMs);
    socket.once("message", (message) => { clearTimeout(timer); socket.close(); resolve(message); });
    socket.once("error", (err) => { clearTimeout(timer); socket.close(); reject(err); });
    socket.send(query, 53, upstream);
  });
}
