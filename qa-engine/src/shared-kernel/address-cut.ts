/*
 * Where a request address (origin + pathname) may be cut. A path segment is where a session token, an id or a run secret sits, and
 * redaction by value finds a secret only whole, so an address cut inside a segment would carry a prefix of a secret no redaction can
 * recognise. Every cut of an address therefore keeps whole path segments only: up to the last `/` the cut reaches past the origin,
 * never part of the segment after it, and without that `/`, since a path that ends in an empty segment reads to the pattern policy as
 * no path (its last run would be redacted whole and distinct addresses would share one key). A cut that reaches only the root `/` keeps
 * it; an address with no `/` past its origin (a host) is cut at the bound. Pure.
 */

/* The longest request address (origin + pathname) a sandboxed producer keeps as the identity of a request: the seed's ledgers and observations and the control load cut there, and the orchestrator reads them with `wholeSegmentsOfProducerCut` at the same bound. The seed repeats it (it imports nothing) and a test keeps the two equal. */
export const PRODUCER_ADDRESS_CHARS = 300;

/* The address cut at `max` characters, keeping whole path segments only; an address within the bound is returned as it is. */
export function cutAddress(address: string, max: number): string {
  if (address.length <= max) return address;
  const head = address.slice(0, max);
  const scheme = head.indexOf("//");
  const pathStart = scheme < 0 ? 0 : head.indexOf("/", scheme + 2);
  const lastSlash = head.lastIndexOf("/");
  if (pathStart < 0 || lastSlash < pathStart) return head;
  return lastSlash > pathStart ? head.slice(0, lastSlash) : head.slice(0, pathStart + 1);
}

/*
 * An address a producer outside the orchestrator may have cut at `bound` (a sandboxed child slices it there and cannot redact):
 * one whose length reached the bound is read as cut, and its trailing segment, which may be part of a secret, is dropped. An address
 * of exactly `bound` characters that was never cut loses its last segment too; the bound is set far past any address a page uses.
 */
export function wholeSegmentsOfProducerCut(address: string, bound: number): string {
  return address.length < bound ? address : cutAddress(address, bound - 1);
}
