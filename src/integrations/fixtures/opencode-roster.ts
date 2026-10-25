import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

export interface RosterRole {
  model: string;
  maxSteps: number;
}

export interface Roster {
  agent: Record<string, RosterRole>;
}

const ROSTER_FILE = join(dirname(fileURLToPath(import.meta.url)), "opencode-roster.json");

/* The absolute path of the roster fixture, for every API that takes the path of an agents config. */
export function rosterFixturePath(): string {
  return ROSTER_FILE;
}

export function loadRoster(): Roster {
  return JSON.parse(readFileSync(ROSTER_FILE, "utf8")) as Roster;
}
