/* The path of the roster fixture the shell keeps beside its other integration fixtures: tests that need the roster only as an input resolve the agents config from it, never from the deployable agents/opencode.json. */
import { fileURLToPath } from "node:url";

export function rosterFixturePath(): string {
  return fileURLToPath(new URL("../../../src/integrations/fixtures/opencode-roster.json", import.meta.url));
}
