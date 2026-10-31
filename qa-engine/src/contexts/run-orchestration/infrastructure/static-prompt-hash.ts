/* The file reader behind a run's recorded `prompt.staticHash`: the composition hands its digest to `recordRunConfig` as the environment's `staticPromptHash`. */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * Hash of the static prompt layers as the orchestrator's own copy of the repository has them: `agents/AGENTS.md` and each role file
 * under `agents/agent/`, in name order. The agents container mounts the same folder read-only, so this is what it serves unless the
 * two checkouts differ; null when the files cannot be read here.
 */
export function hashStaticPrompts(root: string): string | null {
  try {
    const hash = createHash("sha256");
    const entries: Array<[string, string]> = [["AGENTS.md", join(root, "agents", "AGENTS.md")]];
    const roleDir = join(root, "agents", "agent");
    for (const name of readdirSync(roleDir).filter((n) => n.endsWith(".md")).sort()) entries.push([`agent/${name}`, join(roleDir, name)]);
    for (const [name, path] of entries) {
      hash.update(`${name}\0`);
      hash.update(readFileSync(path));
      hash.update("\0");
    }
    return `sha256:${hash.digest("hex")}`;
  } catch {
    return null;
  }
}
