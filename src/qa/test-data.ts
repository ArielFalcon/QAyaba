/*
 * Test-data hygiene against the live DEV database: namespace by SHA so entities are
 * identifiable and cleanable. With a runId, two runs of the same SHA never share a namespace.
 */

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function testDataNamespace(prefix: string, sha: string, runId?: string): string {
  const base = `${prefix}-${shortSha(sha)}`;
  return runId ? `${base}-${runToken(runId)}` : base;
}

/* Entity-name-safe token from runId `run-<sha7>-<ts36>-<hex8>` — the hex8 unique suffix. */
function runToken(runId: string): string {
  const tail = runId.split("-").pop() ?? runId;
  return tail.replace(/[^a-z0-9]/gi, "").slice(0, 12) || "run";
}
