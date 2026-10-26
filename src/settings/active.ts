/* The settings a running process was started with, for the few modules that have no dependency to receive them through (the mirror and git helpers, the agent client's timeouts, the sanitizer's secret values). A composition root installs its store once; nothing else writes it. Import-free on purpose, so any module can read it without a cycle. */

import type { Settings } from "./settings";

let installed: (() => Settings) | undefined;

/* Called once by a composition root with a function that returns the current settings. */
export function installActiveSettings(read: () => Settings): void {
  installed = read;
}

export function resetActiveSettingsForTests(): void {
  installed = undefined;
}

export function activeSettingsOrUndefined(): Settings | undefined {
  return installed?.();
}

/* The environment secrets are redacted by value against, and children's environments are built from. In a process that installed no settings (a script, a test) it is the process environment itself. */
export function activeEnvironment(): Readonly<Record<string, string | undefined>> {
  return installed?.().environment ?? process.env;
}
