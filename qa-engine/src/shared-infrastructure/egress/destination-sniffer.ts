/* Reads, without decrypting anything, the name a connection asks for: the server name of a TLS ClientHello or the Host header of a plain HTTP request. The transparent proxy decides on that name and then opens its own connection to it, so a lie in the name can only reach a host the policy already allows. Pure: bytes in, a verdict out, never reading beyond what it was given. */

/* A ClientHello and an HTTP head are both far smaller than this; a connection that has not named its destination by here is not going to. */
export const MAX_SNIFF_BYTES = 16 * 1024;

export type Sniff =
  | { kind: "tls"; host: string | undefined }
  | { kind: "http"; host: string | undefined }
  | { kind: "need-more" }
  | { kind: "unknown" };

function serverNameOf(hello: Buffer): string | undefined {
  /* hello: the handshake message, starting at its type byte. */
  let o = 4; /* type(1) + length(3) */
  o += 2 + 32; /* version + random */
  if (o + 1 > hello.length) return undefined;
  o += 1 + hello[o]!; /* session id */
  if (o + 2 > hello.length) return undefined;
  o += 2 + hello.readUInt16BE(o); /* cipher suites */
  if (o + 1 > hello.length) return undefined;
  o += 1 + hello[o]!; /* compression */
  if (o + 2 > hello.length) return undefined;
  const extensionsEnd = Math.min(hello.length, o + 2 + hello.readUInt16BE(o));
  o += 2;
  while (o + 4 <= extensionsEnd) {
    const type = hello.readUInt16BE(o);
    const length = hello.readUInt16BE(o + 2);
    const body = o + 4;
    if (body + length > extensionsEnd) return undefined;
    if (type === 0) {
      /* server_name_list: length(2), then entries of type(1) length(2) name */
      let p = body + 2;
      const listEnd = body + length;
      while (p + 3 <= listEnd) {
        const nameType = hello[p]!;
        const nameLength = hello.readUInt16BE(p + 1);
        if (p + 3 + nameLength > listEnd) return undefined;
        if (nameType === 0) {
          const name = hello.toString("latin1", p + 3, p + 3 + nameLength);
          return /^[A-Za-z0-9._-]+$/.test(name) ? name.toLowerCase() : undefined;
        }
        p += 3 + nameLength;
      }
      return undefined;
    }
    o = body + length;
  }
  return undefined;
}

function hostOf(head: string): string | undefined {
  const hosts = head
    .split("\r\n")
    .slice(1)
    .map((line) => /^host:\s*(.*)$/i.exec(line)?.[1]?.trim())
    .filter((value): value is string => value !== undefined);
  if (hosts.length !== 1) return undefined;
  const value = hosts[0]!;
  const withoutPort = value.startsWith("[") ? value : value.replace(/:\d+$/, "");
  return /^[A-Za-z0-9._-]+$/.test(withoutPort) ? withoutPort.toLowerCase() : undefined;
}

export function sniffDestination(buf: Buffer): Sniff {
  if (buf.length === 0) return { kind: "need-more" };
  if (buf[0] === 0x16) {
    if (buf.length < 5) return { kind: "need-more" };
    const recordLength = buf.readUInt16BE(3);
    if (recordLength > MAX_SNIFF_BYTES) return { kind: "unknown" };
    if (buf.length < 5 + recordLength) return { kind: "need-more" };
    const handshake = buf.subarray(5, 5 + recordLength);
    if (handshake.length < 4 || handshake[0] !== 1) return { kind: "unknown" };
    return { kind: "tls", host: serverNameOf(handshake) };
  }
  if (buf[0]! >= 0x41 && buf[0]! <= 0x5a) {
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return buf.length >= MAX_SNIFF_BYTES ? { kind: "unknown" } : { kind: "need-more" };
    return { kind: "http", host: hostOf(buf.toString("latin1", 0, end)) };
  }
  return { kind: "unknown" };
}
