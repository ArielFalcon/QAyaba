/*
 * The DevTools protocol of the agent browser, between the orchestrator and a browser it started as the sandbox uid. The
 * browser speaks it over a pipe pair (`--remote-debugging-pipe`: commands in on fd 3, answers out on fd 4, each message ended
 * by a NUL) instead of a TCP port, because the egress filter rejects every loopback connection of the sandbox uid, the answers
 * of a listening browser included, so a debugging port would never answer the orchestrator. Playwright connects over a
 * WebSocket, so this puts one in front of the pipe: loopback only, on a path of 32 random bytes that only the orchestrator
 * knows, and for one client. A process that is not the orchestrator cannot find the browser, drive it, or get past the route
 * guard that the orchestrator's own Playwright context holds.
 */

import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

export interface CdpPipe {
  /* The browser's fd 3: commands, each ended by a NUL. */
  toBrowser: Writable;
  /* The browser's fd 4: answers and events, each ended by a NUL. */
  fromBrowser: Readable;
}

export interface CdpPipeBridge {
  /* `ws://127.0.0.1:<port>/<random>`: what `connectOverCDP` takes. */
  url: string;
  close(): Promise<void>;
}

const TOKEN_BYTES = 32;

export async function startCdpPipeBridge(pipe: CdpPipe): Promise<CdpPipeBridge> {
  const path = `/${randomBytes(TOKEN_BYTES).toString("hex")}`;
  let client: WebSocket | undefined;
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    maxPayload: 256 * 1024 * 1024,
    verifyClient: (info, done) => {
      if (info.req.url !== path) return done(false, 404, "not found");
      if (client !== undefined) return done(false, 409, "in use");
      return done(true);
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("the DevTools bridge has no port");

  let pending = "";
  /* A character split between two chunks of the pipe is held until its second half arrives. */
  const decoder = new StringDecoder("utf8");
  const onData = (chunk: Buffer | string): void => {
    pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let at: number;
    while ((at = pending.indexOf("\0")) >= 0) {
      const message = pending.slice(0, at);
      pending = pending.slice(at + 1);
      if (client !== undefined && client.readyState === client.OPEN) client.send(message);
    }
  };
  const onPipeEnd = (): void => {
    client?.close();
  };
  pipe.fromBrowser.on("data", onData);
  pipe.fromBrowser.once("end", onPipeEnd);
  pipe.fromBrowser.once("close", onPipeEnd);

  server.on("connection", (ws) => {
    client = ws;
    ws.on("message", (data) => {
      const text = data.toString("utf8");
      if (!pipe.toBrowser.destroyed) pipe.toBrowser.write(`${text}\0`);
    });
    ws.once("close", () => {
      if (client === ws) client = undefined;
    });
  });

  return {
    url: `ws://127.0.0.1:${address.port}${path}`,
    close: async () => {
      pipe.fromBrowser.off("data", onData);
      pipe.fromBrowser.off("end", onPipeEnd);
      pipe.fromBrowser.off("close", onPipeEnd);
      client?.close();
      for (const open of server.clients) open.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
