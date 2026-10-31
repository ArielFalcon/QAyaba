/* The one place the orchestrator process imports playwright-core (see the dependency rule): it hands the launcher the two methods of `chromium` it uses. Lazy, so that a process that never opens the agent browser never loads the package. */

import type { PlaywrightChromium } from "./chromium-sandbox.launcher.ts";

export async function loadPlaywrightChromium(): Promise<PlaywrightChromium> {
  const { chromium } = await import("playwright-core");
  return {
    executablePath: () => chromium.executablePath(),
    connectOverCDP: async (endpointURL) => (await chromium.connectOverCDP(endpointURL)) as unknown as Awaited<ReturnType<PlaywrightChromium["connectOverCDP"]>>,
  };
}
