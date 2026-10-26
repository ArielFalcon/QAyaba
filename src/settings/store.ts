/* The settings of a process and the way they change: loaded once at start, and loaded again after the onboarding surface applies variables to the live environment. */

import { installActiveSettings, activeSettingsOrUndefined } from "./active";
import { loadSettings, type EnvironmentMap, type Settings } from "./settings";

export interface SettingsStore {
  current(): Settings;
  /* Reads the environment again. A problem throws and leaves the current settings in place. */
  reload(): Settings;
}

export function createSettingsStore(env: EnvironmentMap): SettingsStore {
  let current = loadSettings(env);
  return {
    current: () => current,
    reload: () => {
      current = loadSettings(env);
      return current;
    },
  };
}

/* Makes the store's settings the process's active settings. */
export function installSettingsStore(store: SettingsStore): void {
  installActiveSettings(() => store.current());
}

/* The active settings, or those of the process environment when no store was installed (a script or a test). */
export function activeSettings(): Settings {
  return activeSettingsOrUndefined() ?? loadSettings(process.env);
}
