/*
 * What makes a repo's e2e/auth.setup.ts the stock login seed. A copy that is byte-for-byte a shipped
 * seed revision is stock: setup moves it on to the current seed, and a sign-in it cannot complete
 * means the seed does not fit the app yet. Any other copy — one that kept the seed's first-line
 * marker included — is a login written for the app: setup never overwrites it, and its failing
 * sign-in is an integration error.
 */
import { createHash } from "node:crypto";

/* sha256 of every auth.setup.ts seed revision shipped into watched repos, the current one included.
   Add the new hash whenever config/e2e/auth.setup.ts changes. */
const AUTH_SETUP_SEED_REVISIONS: ReadonlySet<string> = new Set([
  "f0026e081894e535c2c08506bb3b73d4023425313e4887917dd7ba368b1dcaa5",
  "ca23fb2c283f97093a8c7f98693e051e9f6cd11d8db53ee495833d1883cfc749",
]);

export function isStockAuthSetup(body: string): boolean {
  return AUTH_SETUP_SEED_REVISIONS.has(createHash("sha256").update(body).digest("hex"));
}
