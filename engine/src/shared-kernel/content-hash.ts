/* The one way the engine fingerprints text for a trace: sha256 over its UTF-8 bytes, in hex. A hash says whether two texts were the same without saying what they were. */

import { createHash } from "node:crypto";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
