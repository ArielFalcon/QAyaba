/*
 * Control plane entry: webhook + sequential queue + HTTP API. One run at a time against DEV.
 * Importing this file starts nothing; `main()` loads the settings, wires the real adapters (src/server/wire-app.ts)
 * and starts the server, and runs only when this file is the process entry.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createSettingsStore, installSettingsStore } from "./settings/store";
import { wireApp } from "./server/wire-app";

export async function main(): Promise<void> {
  /* The one read of the process environment: every value the service uses comes from the typed settings (docs/settings.md). */
  const settingsStore = createSettingsStore(process.env);
  installSettingsStore(settingsStore);

  const { app, beforeListen } = wireApp(settingsStore);
  beforeListen();
  await app.listen();
}

/* True only when this file is the process entry (`tsx src/index.ts`); the link-resolved path is compared because the loader reports the real one. */
function isProcessEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isProcessEntry()) {
  void main();
}
