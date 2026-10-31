/* The port of the agents' tools endpoint (src/entrypoints/tools-endpoint.ts), read from the environment. The default is a port the compose file does not publish. */

export const QA_TOOLS_PORT_ENV = "QA_TOOLS_PORT";
export const DEFAULT_TOOLS_PORT = 459;

export function resolveToolsPort(env: Record<string, string | undefined>): number {
  const raw = env[QA_TOOLS_PORT_ENV]?.trim();
  if (!raw) return DEFAULT_TOOLS_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${QA_TOOLS_PORT_ENV} must be a TCP port number (1-65535), got "${raw}"`);
  return port;
}
