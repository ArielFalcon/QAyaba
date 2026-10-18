/* Wraps HTTP handling so a throw can never leave a request unanswered or become an unhandled rejection. */
import type { IncomingMessage, ServerResponse } from "node:http";

/* Runs `work`; if it throws, logs the fault and answers 500 in the schemaVersion error shape (or just ends a response already started). */
export async function guardResponse(res: ServerResponse, work: () => Promise<void> | void, log: (message: string) => void): Promise<void> {
  try {
    await work();
  } catch (err) {
    log(`request handler failed: ${err instanceof Error ? err.message : String(err)}`);
    try {
      if (res.headersSent) {
        res.end();
      } else {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ schemaVersion: 1, error: "internal error" }));
      }
    } catch {
      /* the socket is gone: nothing left to answer */
    }
  }
}

export function guardRequestHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
  log: (message: string) => void,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return (req, res) => guardResponse(res, () => handler(req, res), log);
}
