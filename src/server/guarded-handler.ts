/* Wraps the HTTP request handler so a throw can never leave a request unanswered or become an unhandled rejection. */
import type { IncomingMessage, ServerResponse } from "node:http";

export function guardRequestHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
  log: (message: string) => void,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      await handler(req, res);
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
  };
}
