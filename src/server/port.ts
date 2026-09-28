/*
 * The control plane's port: the server listens on it and the CLI probes it, and the help
 * assistant points operators at it. PORT overrides it. The terminal clients carry the same default
 * (the Go TUI's api.DefaultHost, bin/qa's QA_HOST fallback).
 *
 * 458 is a privileged port (below 1024). The Docker image runs the orchestrator as root, so it
 * binds there; a non-root Linux process needs PORT above 1023 (clients then set QA_HOST) or the
 * CAP_NET_BIND_SERVICE capability, and rootless Docker cannot publish it.
 */
import type { AddressInfo } from "node:net";

export const DEFAULT_PORT = 458;
export const DEFAULT_HOST = `localhost:${DEFAULT_PORT}`;

/* PORT when set (an empty value counts as unset); anything that is not a TCP port throws. */
export function resolvePort(env: Record<string, string | undefined>): number {
  const raw = env.PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`PORT must be a TCP port number (0-65535), got "${env.PORT}"`);
  }
  return port;
}

/*
 * The interface the server listens on. A bare `npm run start` listens on loopback only, so it never
 * exposes the control plane to the network by accident; LISTEN_HOST names another interface (an
 * empty value counts as unset). The image sets 0.0.0.0 (Dockerfile, repeated in docker-compose.yml),
 * where exposure beyond the host is decided by the publish address (-p, or BIND_ADDR under compose).
 */
export const DEFAULT_LISTEN_HOST = "127.0.0.1";

export function resolveListenHost(env: Record<string, string | undefined>): string {
  return env.LISTEN_HOST?.trim() || DEFAULT_LISTEN_HOST;
}

/* "127.0.0.1:458" / "0.0.0.0:458" — where the server is actually reachable, for the boot log. */
export function describeListenAddress(address: AddressInfo | string | null): string {
  if (address === null) return "an unknown address";
  if (typeof address === "string") return address; /* a pipe or socket path */
  const host = address.family === "IPv6" || address.address.includes(":") ? `[${address.address}]` : address.address;
  return `${host}:${address.port}`;
}

/* What an operator should do when the server cannot bind its port. */
export function listenErrorHint(err: Error & { code?: string }, port: number): string {
  if (err.code === "EACCES" && port < 1024) {
    return `port ${port} is privileged: run as root (the Docker image does), grant node CAP_NET_BIND_SERVICE, or set PORT above 1023 and point the clients at it with QA_HOST`;
  }
  if (err.code === "EADDRINUSE") {
    return `port ${port} is already in use — stop the other process or set PORT to a free port`;
  }
  return `cannot listen on port ${port}: ${err.message}`;
}

export interface ServerErrorListenerDeps {
  port: number;
  listening: () => boolean;
  log: (level: "error", message: string, meta?: Record<string, unknown>) => void;
  exit: (code: number) => void;
  redact: (err: unknown) => string;
}

/*
 * The control-plane server's "error" listener. A bind failure (a privileged port without root, a
 * port already taken) ends the process with a hint the operator can act on instead of a bare
 * EACCES/EADDRINUSE stack. An error once the server is up is logged, redacted, and the server keeps
 * serving.
 */
export function serverErrorListener(deps: ServerErrorListenerDeps): (err: Error & { code?: string }) => void {
  return (err) => {
    if (deps.listening()) {
      deps.log("error", "control-plane server error", { error: deps.redact(err), ...(err.code ? { code: err.code } : {}) });
      return;
    }
    deps.log("error", `qayaba cannot start: ${listenErrorHint(err, deps.port)}`);
    deps.exit(1);
  };
}
