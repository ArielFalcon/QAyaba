import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { WebSocket } from "ws";
import { startCdpPipeBridge, type CdpPipe } from "@contexts/test-execution/infrastructure/agent-browser/cdp-pipe-bridge.ts";

function pipe(): { pipe: CdpPipe; sent: string[]; browser: PassThrough } {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const sent: string[] = [];
  let buffer = "";
  toBrowser.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let at: number;
    while ((at = buffer.indexOf("\0")) >= 0) {
      sent.push(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
    }
  });
  return { pipe: { toBrowser, fromBrowser }, sent, browser: fromBrowser };
}

const open = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });

const nextMessage = (ws: WebSocket): Promise<string> => new Promise((resolve) => ws.once("message", (data) => resolve(data.toString())));

async function bridge(t: TestContext) {
  const p = pipe();
  const b = await startCdpPipeBridge(p.pipe);
  t.after(async () => { await b.close(); });
  return { ...p, bridge: b };
}

test("the endpoint is a loopback address with a path nobody can guess, different for each bridge", async (t) => {
  const a = await bridge(t);
  const b = await bridge(t);
  const url = new URL(a.bridge.url);
  assert.equal(url.protocol, "ws:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(url.pathname.length >= 33, "a path of at least 32 random characters");
  assert.notEqual(a.bridge.url, b.bridge.url);
});

test("what the client sends reaches the browser's pipe, one NUL-ended message each, and nothing is split or merged", async (t) => {
  const { bridge: b, sent } = await bridge(t);
  const ws = await open(b.url);
  t.after(() => ws.close());
  ws.send('{"id":1,"method":"Browser.getVersion"}');
  ws.send('{"id":2,"method":"Target.getTargets"}');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(sent, ['{"id":1,"method":"Browser.getVersion"}', '{"id":2,"method":"Target.getTargets"}']);
});

test("what the browser writes comes back to the client message by message, whatever the chunking of the pipe, and a large one survives", async (t) => {
  const { bridge: b, browser } = await bridge(t);
  const ws = await open(b.url);
  t.after(() => ws.close());
  const big = JSON.stringify({ id: 3, result: { tree: "x".repeat(3_000_000) } });
  const received: string[] = [];
  ws.on("message", (data) => received.push(data.toString()));
  browser.write('{"id":1,"result":{}}\0{"id":2,');
  browser.write('"result":{}}\0');
  browser.write(`${big.slice(0, 1_000_000)}`);
  browser.write(`${big.slice(1_000_000)}\0`);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(received.slice(0, 2), ['{"id":1,"result":{}}', '{"id":2,"result":{}}']);
  assert.equal(received[2]?.length, big.length);
});

test("a connection that does not know the path is refused, and so is a second one while the first is open", async (t) => {
  const { bridge: b } = await bridge(t);
  const wrong = new URL(b.url);
  wrong.pathname = "/not-the-path";
  await assert.rejects(open(wrong.toString()), /HTTP (401|403|404)/);
  const first = await open(b.url);
  t.after(() => first.close());
  await assert.rejects(open(b.url), /HTTP (401|403|409|503)/);
});

test("a message from a client that is not the one connected never reaches the pipe", async (t) => {
  const { bridge: b, sent } = await bridge(t);
  const wrong = new URL(b.url);
  wrong.pathname = "/guess";
  await open(wrong.toString()).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(sent, []);
});

test("when the browser's pipe ends the client is closed, and closing the bridge closes the client and stops listening", async (t) => {
  const first = await bridge(t);
  const ws1 = await open(first.bridge.url);
  const closed1 = new Promise<void>((resolve) => ws1.once("close", () => resolve()));
  first.browser.end();
  await closed1;

  const second = await bridge(t);
  const ws2 = await open(second.bridge.url);
  const closed2 = new Promise<void>((resolve) => ws2.once("close", () => resolve()));
  await second.bridge.close();
  await closed2;
  await assert.rejects(open(second.bridge.url));
});
