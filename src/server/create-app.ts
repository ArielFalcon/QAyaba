/* The control-plane server as a value. `createApp(deps)` builds both HTTP servers from injected collaborators and starts nothing: no listener, no timer, no signal handler exists until `listen()` runs, so a test can build the real handler on port 0 over fakes. It reads no environment and no module state. */

import { createServer, type Server } from "node:http";
import { createControlPlaneHandler, type ControlPlaneDeps } from "./control-plane-router";
import { guardRequestHandler } from "./guarded-handler";
import { describeListenAddress, serverErrorListener } from "./port";
import { createFixedWindowLimiter } from "./rate-limit";
import type { Lifecycle } from "./shutdown";
import { createWebhookHandler, type WebhookHandlerDeps } from "./webhook-handler";

/* Per-address throttle of the public sign-in routes: that route fans out to GitHub, so an unbounded flood would amplify from this server's address. */
export const LOGIN_ATTEMPTS_PER_WINDOW = 20;
export const LOGIN_WINDOW_MS = 60_000;

export interface AppDeps {
  /* Everything the request sequence needs except the pieces createApp builds itself. */
  control: Omit<ControlPlaneDeps, "loginLimiter" | "webhook">;
  webhook: WebhookHandlerDeps;
  /* The agents' tools endpoint: a second listener, never published. Its own error listener is the caller's. */
  toolsServer: Server;
  lifecycle: Lifecycle;
  listen: {
    port: number;
    host: string;
    toolsPort: number;
    toolsHost: string;
    /* Whether the API demands a token; only the boot line says so. */
    apiAuthOn: boolean;
  };
  /* Runs once the control plane accepts connections: the work that needs a live server (event stream, recovery, the poller). */
  onListening(): void;
  log(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void;
  exit(code: number): void;
  redact(err: unknown): string;
}

export interface App {
  readonly server: Server;
  readonly toolsServer: Server;
  /* Starts both listeners. Resolves when the control plane is listening and `onListening` ran; rejects when it cannot bind. */
  listen(): Promise<void>;
  /* Runs the graceful shutdown (cancel, drain, flush, exit) for a reason such as a signal name. */
  shutdown(reason: string): Promise<void>;
}

export function createApp(deps: AppDeps): App {
  const webhook = createWebhookHandler(deps.webhook);
  const loginLimiter = createFixedWindowLimiter({ limit: LOGIN_ATTEMPTS_PER_WINDOW, windowMs: LOGIN_WINDOW_MS });
  const control = createControlPlaneHandler({ ...deps.control, loginLimiter, webhook });
  const server = createServer(guardRequestHandler(control, (message) => deps.log("error", message)));

  return {
    server,
    toolsServer: deps.toolsServer,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.on(
          "error",
          serverErrorListener({
            port: deps.listen.port,
            listening: () => server.listening,
            log: deps.log,
            exit: deps.exit,
            redact: deps.redact,
          }),
        );
        server.once("error", reject);
        deps.toolsServer.listen(deps.listen.toolsPort, deps.listen.toolsHost, () =>
          deps.log("info", `tools endpoint listening on ${describeListenAddress(deps.toolsServer.address())}`),
        );
        server.listen(deps.listen.port, deps.listen.host, () => {
          server.off("error", reject);
          deps.log("info", `qayaba listening on ${describeListenAddress(server.address())}${deps.listen.apiAuthOn ? " (API auth on)" : ""}`);
          deps.onListening();
          resolve();
        });
      }),
    shutdown: (reason) => deps.lifecycle.shutdown(reason),
  };
}
