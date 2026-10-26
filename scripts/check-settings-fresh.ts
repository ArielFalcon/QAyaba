/*
 * Settings freshness gate (npm run settings:check): regenerates docs/settings.md from the settings registry and
 * fails when the committed file differs, so a registry edit cannot ship without its documentation.
 *
 *   npm run settings:check
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderSettingsDocs, SETTINGS_DOC_PATH } from "./gen-settings-docs";

/* Pure comparison, unit-testable with a fake reader. Returns the reason the file is stale, or undefined when it is fresh. */
export function settingsDocStaleness(readCommitted: (path: string) => string, fresh: string = renderSettingsDocs()): string | undefined {
  let committed: string;
  try {
    committed = readCommitted(SETTINGS_DOC_PATH);
  } catch {
    return `${SETTINGS_DOC_PATH} does not exist — run \`npm run settings:gen\` and commit the result`;
  }
  return committed === fresh ? undefined : `${SETTINGS_DOC_PATH} is stale — run \`npm run settings:gen\` and commit the result`;
}

function main(): void {
  const stale = settingsDocStaleness((path) => readFileSync(path, "utf8"));
  if (stale) {
    console.error(`settings:check — ${stale}`);
    process.exitCode = 1;
    return;
  }
  console.log("settings:check — docs/settings.md is up to date.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
