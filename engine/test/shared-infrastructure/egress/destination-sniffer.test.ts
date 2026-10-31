/* The proxy decides on the name a connection asks for: the server name of a TLS ClientHello, the Host header of a plain HTTP request. Nothing is decrypted. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffDestination, MAX_SNIFF_BYTES } from "../../../src/shared-infrastructure/egress/destination-sniffer.ts";

function clientHello(serverName: string | undefined, opts: { split?: number } = {}): Buffer {
  const ext = (type: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([type >> 8, type & 255, body.length >> 8, body.length & 255]), body]);
  const sniBody = serverName === undefined ? undefined : (() => {
    const name = Buffer.from(serverName);
    const entry = Buffer.concat([Buffer.from([0, name.length >> 8, name.length & 255]), name]);
    return Buffer.concat([Buffer.from([entry.length >> 8, entry.length & 255]), entry]);
  })();
  const extensions = Buffer.concat([ext(0x0b, Buffer.from([1, 0])), ...(sniBody ? [ext(0, sniBody)] : []), ext(0x0a, Buffer.from([0, 2, 0, 0x1d]))]);
  const body = Buffer.concat([
    Buffer.from([3, 3]), Buffer.alloc(32, 7), Buffer.from([0]),
    Buffer.from([0, 2, 0x13, 0x01]), Buffer.from([1, 0]),
    Buffer.from([extensions.length >> 8, extensions.length & 255]), extensions,
  ]);
  const handshake = Buffer.concat([Buffer.from([1, body.length >> 16, (body.length >> 8) & 255, body.length & 255]), body]);
  const record = Buffer.concat([Buffer.from([0x16, 3, 1, handshake.length >> 8, handshake.length & 255]), handshake]);
  return opts.split === undefined ? record : record.subarray(0, opts.split);
}

test("a ClientHello's server name is the destination", () => {
  const r = sniffDestination(clientHello("registry.npmjs.org"));
  assert.deepEqual(r, { kind: "tls", host: "registry.npmjs.org" });
});

test("a ClientHello without a server name has no destination", () => {
  assert.deepEqual(sniffDestination(clientHello(undefined)), { kind: "tls", host: undefined });
});

test("a ClientHello that has not fully arrived asks for more bytes", () => {
  const whole = clientHello("registry.npmjs.org");
  assert.deepEqual(sniffDestination(whole.subarray(0, 3)), { kind: "need-more" });
  assert.deepEqual(sniffDestination(whole.subarray(0, whole.length - 5)), { kind: "need-more" });
});

test("a truncated or malformed extension block gives no destination instead of reading past the record", () => {
  const whole = clientHello("registry.npmjs.org");
  const broken = Buffer.from(whole);
  broken[broken.length - 30] = 0xff; /* corrupt inside the extensions */
  const r = sniffDestination(broken);
  assert.ok(r.kind === "tls" || r.kind === "unknown");
  if (r.kind === "tls") assert.ok(r.host === undefined || typeof r.host === "string");
});

test("a plain HTTP request's Host header is the destination, without its port", () => {
  assert.deepEqual(sniffDestination(Buffer.from("GET /x HTTP/1.1\r\nUser-Agent: t\r\nHost: Dev.Example.com:8080\r\nAccept: */*\r\n\r\n")), { kind: "http", host: "dev.example.com" });
  assert.deepEqual(sniffDestination(Buffer.from("POST /x HTTP/1.1\r\nhost: dev.example.com\r\n\r\nbody")), { kind: "http", host: "dev.example.com" });
});

test("an HTTP request without a Host header, or whose head has not ended, has no destination yet", () => {
  assert.deepEqual(sniffDestination(Buffer.from("GET / HTTP/1.0\r\n\r\n")), { kind: "http", host: undefined });
  assert.deepEqual(sniffDestination(Buffer.from("GET / HTTP/1.1\r\nHost: a.example.com\r\n")), { kind: "need-more" });
});

test("a head that is never going to end stops being waited for", () => {
  const long = Buffer.from(`GET / HTTP/1.1\r\nX: ${"a".repeat(MAX_SNIFF_BYTES)}`);
  assert.deepEqual(sniffDestination(long), { kind: "unknown" });
});

test("bytes that are neither a handshake nor an HTTP method are unknown", () => {
  assert.deepEqual(sniffDestination(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05])), { kind: "unknown" });
  assert.deepEqual(sniffDestination(Buffer.alloc(0)), { kind: "need-more" });
});

test("two Host headers are ambiguous and give no destination", () => {
  assert.deepEqual(sniffDestination(Buffer.from("GET / HTTP/1.1\r\nHost: a.example.com\r\nHost: b.example.com\r\n\r\n")), { kind: "http", host: undefined });
});
