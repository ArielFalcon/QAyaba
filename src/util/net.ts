/*
 * Global outbound-HTTP setup for Node's fetch (undici). Node fetch does not honor
 * HTTP_PROXY/HTTPS_PROXY/NO_PROXY on its own; EnvHttpProxyAgent does, and is a no-op
 * when none are set. Timeouts keep per-prompt withTimeout as the real deadline for
 * long agent turns rather than a transport-level abort. Idempotent.
 */

export async function installHttpDispatcher(timeoutMs: number): Promise<void> {
  const { setGlobalDispatcher, EnvHttpProxyAgent } = await import("undici");
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      headersTimeout: timeoutMs + 30_000,
      bodyTimeout: timeoutMs + 30_000,
    }),
  );
}
