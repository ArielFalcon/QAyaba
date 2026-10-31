/* Which control-plane requests earn a log line. A successful read (health checks, the TUI and web console polling a
   run) says nothing a later failure does not say better, and it was ~95% of the orchestrator's container log. Anything
   that changes state, and every failure, is kept. */
export function shouldLogApiRequest(method: string | undefined, statusCode: number): boolean {
  const read = method === "GET" || method === "HEAD";
  return !read || statusCode >= 400;
}
