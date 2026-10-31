/* The product side of the served-version fact: reads the version source an app declares and answers only the commit it serves. One implementation per kind of source; the engine knows only this port. */

import type { ServedVersionRead } from "../served-version.ts";

export interface ServedVersionReaderPort {
  /** Never throws: a source that cannot be read answers with the typed reason. */
  read(url: string): Promise<ServedVersionRead>;
}
