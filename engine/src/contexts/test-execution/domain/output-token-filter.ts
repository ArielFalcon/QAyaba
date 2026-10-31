/* A heuristic against one way of carrying data out through the answer of a tool: a spec runs with the session and the certificate in reach, and everything it prints comes back in an error message or a title. The secrets the run knows are taken out by value (run-secret-redaction.ts); what a spec could compute from them, an encoding or a hash, is not known by value. A long run of characters that is random-looking (a hex string, or a base64 or base64url string of high entropy) that the page capture of the same call does not show has no reason to be in a test's error or title, so it is replaced. It is a filter for the careless and the obvious: a payload cut into pieces shorter than the floor, spelled with words, spread over several calls or hidden in a timing or in whether a test passed is not found, and the bound on what leaves is the one in docs/execution-sandbox.md (secrets that die with the session, copies that live for one call, and the egress and read limits), not this. */

export const MIN_OPAQUE_TOKEN_CHARS = 32;
/* Random base64 of this many characters has an empirical entropy near 5 bits per character; readable identifiers and paths of the same length are near 3.5 to 4. */
export const MIN_OPAQUE_TOKEN_ENTROPY = 4.3;
export const OPAQUE_TOKEN_REMOVED = "[long-token-removed]";

const TOKEN = /[A-Za-z0-9+/_=-]{32,}/g;
const HEX_ONLY = /^[0-9a-fA-F]+$/;

function entropyBitsPerChar(token: string): number {
  const counts = new Map<string, number>();
  for (const ch of token) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / token.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function isOpaque(token: string): boolean {
  /* A hash or a dump in hex: its alphabet is too small for the entropy test and no word is made of it. */
  if (HEX_ONLY.test(token)) return /[0-9]/.test(token) && /[a-fA-F]/.test(token);
  const classes = Number(/[a-z]/.test(token)) + Number(/[A-Z]/.test(token)) + Number(/[0-9]/.test(token));
  return classes >= 2 && entropyBitsPerChar(token) >= MIN_OPAQUE_TOKEN_ENTROPY;
}

/* `text` with every opaque token that `shown` (the page captures of the same answer) does not contain replaced. */
export function dropOpaqueTokens(text: string, shown: string): string {
  return text.replace(TOKEN, (token) => (isOpaque(token) && !shown.includes(token) ? OPAQUE_TOKEN_REMOVED : token));
}
