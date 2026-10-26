/*
 * Credentials for `opencode serve`, which the supervisor runs behind HTTP Basic auth. Both containers read
 * the same OPENCODE_SERVER_PASSWORD from compose; the orchestrator is the only caller of the server.
 * A client without the password is a configuration error, so it is refused at construction, and a 401 from
 * the server is thrown, never read as "no agents" or "no session". The password is never put in a message.
 */

import { activeEnvironment } from "../settings/active";

export const OPENCODE_SERVER_PASSWORD_ENV = "OPENCODE_SERVER_PASSWORD";
const OPENCODE_SERVER_USER = "opencode";

export class OpenCodeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeAuthError";
  }
}

export interface OpenCodeServerAuth {
  headers: { Authorization: string };
  /* The SDK calls its `fetch` with the Request it built. */
  fetch: (request: Request) => Promise<Response>;
}

export function openCodeServerAuth(
  env: Readonly<Record<string, string | undefined>> = activeEnvironment(),
  inner: (request: Request) => Promise<Response> = (request) => fetch(request),
): OpenCodeServerAuth {
  const password = env[OPENCODE_SERVER_PASSWORD_ENV]?.trim();
  if (!password) {
    throw new OpenCodeAuthError(
      `${OPENCODE_SERVER_PASSWORD_ENV} is not set: the orchestrator cannot authenticate to the OpenCode server. Set the same value on the orchestrator and agents services (see .env.example).`,
    );
  }
  return {
    headers: { Authorization: `Basic ${Buffer.from(`${OPENCODE_SERVER_USER}:${password}`).toString("base64")}` },
    fetch: async (request) => {
      const response = await inner(request);
      if (response.status === 401) {
        throw new OpenCodeAuthError(
          `the OpenCode server rejected the credentials (HTTP 401): ${OPENCODE_SERVER_PASSWORD_ENV} on the orchestrator differs from the one the agents service started with`,
        );
      }
      return response;
    },
  };
}
