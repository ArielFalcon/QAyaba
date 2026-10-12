/* The transparent proxy is handed the connections the kernel redirected from the sandbox uid. It reads the name each one asks for, lets it through to that name (resolved afresh, never the address the client had) only when the policy allows it, and resets everything else. Real sockets on loopback; only the resolver is a fake. */
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { TransparentProxy } from "../../../src/shared-infrastructure/egress/transparent-proxy.ts";
import { compileEgressPolicy } from "../../../src/shared-infrastructure/egress/egress-policy.ts";

function helloFor(name: string): Buffer {
  const nameBytes = Buffer.from(name);
  const entry = Buffer.concat([Buffer.from([0, nameBytes.length >> 8, nameBytes.length & 255]), nameBytes]);
  const sni = Buffer.concat([Buffer.from([entry.length >> 8, entry.length & 255]), entry]);
  const ext = Buffer.concat([Buffer.from([0, 0, sni.length >> 8, sni.length & 255]), sni]);
  const body = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32, 1), Buffer.from([0]), Buffer.from([0, 2, 0x13, 1]), Buffer.from([1, 0]), Buffer.from([ext.length >> 8, ext.length & 255]), ext]);
  const hs = Buffer.concat([Buffer.from([1, body.length >> 16, (body.length >> 8) & 255, body.length & 255]), body]);
  return Buffer.concat([Buffer.from([0x16, 3, 1, hs.length >> 8, hs.length & 255]), hs]);
}

async function echoServer(): Promise<{ port: number; received: Buffer[]; close(): Promise<void> }> {
  const received: Buffer[] = [];
  const server = net.createServer((socket) => {
    socket.on("data", (d) => { received.push(d); socket.write(Buffer.concat([Buffer.from("echo:"), d])); });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, received, close: () => new Promise((resolve) => { server.close(() => resolve()); (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.(); }) };
}

function talk(port: number, payload: Buffer): Promise<{ data: Buffer; ended: "end" | "reset" }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(port, "127.0.0.1", () => socket.write(payload));
    socket.on("data", (d) => { chunks.push(d); if (Buffer.concat(chunks).length >= 5) socket.end(); });
    socket.on("error", () => resolve({ data: Buffer.concat(chunks), ended: "reset" }));
    socket.on("close", () => resolve({ data: Buffer.concat(chunks), ended: Buffer.concat(chunks).length > 0 ? "end" : "reset" }));
    setTimeout(() => { socket.destroy(); }, 3000);
  });
}

function proxyFor(policyOrigins: string[], upstream: { port: number }, over: { resolve?: (host: string) => Promise<string> } = {}): { proxy: TransparentProxy; denied: string[]; resolved: string[] } {
  const policy = compileEgressPolicy(policyOrigins);
  const denied: string[] = [];
  const resolved: string[] = [];
  const proxy = new TransparentProxy({
    allows: (host, port) => policy.allows(host, port),
    onDenied: (host) => denied.push(host ?? "(no name)"),
    resolve: over.resolve ?? (async (host) => { resolved.push(host); return "127.0.0.1"; }),
    upstreamPort: () => upstream.port,
  });
  return { proxy, denied, resolved };
}

test("an allowed TLS server name is piped through to the name's own address, unchanged", async () => {
  const upstream = await echoServer();
  const { proxy, denied, resolved } = proxyFor([`https://localhost:${upstream.port}`], upstream);
  try {
    const local = await proxy.listen(upstream.port);
    const hello = helloFor("localhost");
    const out = await talk(local, hello);
    assert.equal(out.data.subarray(0, 5).toString(), "echo:");
    assert.deepEqual(Buffer.concat(upstream.received), hello, "the upstream saw the client's own bytes, nothing added or removed");
    assert.deepEqual(denied, []);
    assert.deepEqual(resolved, ["localhost"]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("a server name the policy does not allow is reset, and recorded as denied", async () => {
  const upstream = await echoServer();
  const { proxy, denied } = proxyFor([`https://localhost:${upstream.port}`], upstream);
  try {
    const local = await proxy.listen(upstream.port);
    const out = await talk(local, helloFor("evil.example.net"));
    assert.equal(out.ended, "reset");
    assert.equal(Buffer.concat(upstream.received).length, 0, "nothing reached the upstream");
    assert.deepEqual(denied, ["evil.example.net"]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("a handshake with no server name, and a connection that names nothing, are reset", async () => {
  const upstream = await echoServer();
  const { proxy, denied } = proxyFor([`https://localhost:${upstream.port}`], upstream);
  try {
    const local = await proxy.listen(upstream.port);
    const noName = await talk(local, Buffer.from([0x16, 3, 1, 0, 4, 1, 0, 0, 0]));
    assert.equal(noName.ended, "reset");
    const garbage = await talk(local, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    assert.equal(garbage.ended, "reset");
    assert.equal(Buffer.concat(upstream.received).length, 0);
    assert.equal(denied.length, 2);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("a plain HTTP request is judged by its Host header", async () => {
  const upstream = await echoServer();
  const { proxy, denied } = proxyFor([`http://localhost:${upstream.port}`], upstream);
  try {
    const local = await proxy.listen(upstream.port);
    const allowed = await talk(local, Buffer.from(`GET / HTTP/1.1\r\nHost: localhost:${upstream.port}\r\n\r\n`));
    assert.equal(allowed.data.subarray(0, 5).toString(), "echo:");
    const refused = await talk(local, Buffer.from("GET / HTTP/1.1\r\nHost: evil.example.net\r\n\r\n"));
    assert.equal(refused.ended, "reset");
    assert.deepEqual(denied, ["evil.example.net"]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("a name that resolves to loopback is refused unless the rule names loopback itself (DNS rebinding)", async () => {
  const upstream = await echoServer();
  const { proxy, denied } = proxyFor([`https://rebind.example.com:${upstream.port}`], upstream, { resolve: async () => "127.0.0.1" });
  try {
    const local = await proxy.listen(upstream.port);
    const out = await talk(local, helloFor("rebind.example.com"));
    assert.equal(out.ended, "reset");
    assert.equal(Buffer.concat(upstream.received).length, 0);
    assert.deepEqual(denied, ["rebind.example.com"]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("every connection resolves the name again", async () => {
  const upstream = await echoServer();
  const { proxy, resolved } = proxyFor([`https://localhost:${upstream.port}`], upstream);
  try {
    const local = await proxy.listen(upstream.port);
    await talk(local, helloFor("localhost"));
    await talk(local, helloFor("localhost"));
    assert.deepEqual(resolved, ["localhost", "localhost"]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("with no policy active nothing passes", async () => {
  const upstream = await echoServer();
  const { proxy } = proxyFor([], upstream);
  try {
    const local = await proxy.listen(upstream.port);
    assert.equal((await talk(local, helloFor("localhost"))).ended, "reset");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("listening twice for the same upstream port gives the same local port", async () => {
  const upstream = await echoServer();
  const { proxy } = proxyFor([], upstream);
  try {
    assert.equal(await proxy.listen(443), await proxy.listen(443));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
