/*
 * Writes docs/settings.md from the settings registry (src/settings/registry.ts): one table per group with the
 * environment variable, the field that carries it, its type, default, whether it is required or secret, and what
 * it does. A secret shows no default and no value.
 *
 *   npm run settings:gen
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SETTING_GROUPS, SETTINGS_REGISTRY, type SettingDef } from "../src/settings/registry";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SETTINGS_DOC_PATH = join(ROOT, "docs", "settings.md");

const GROUP_TITLES: Record<(typeof SETTING_GROUPS)[number], string> = {
  server: "Server",
  auth: "Authentication",
  webhook: "Webhook",
  agent: "Agent runtime",
  git: "Git and mirrors",
  paths: "Paths",
  sandbox: "Execution sandbox",
  run: "Runs",
  telemetry: "Telemetry",
  retention: "Retention",
  maintainer: "Self-maintainer",
  judges: "Judges",
};

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function typeOf(def: SettingDef): string {
  return def.type === "enum" && def.values ? `enum: ${def.values.join(" \\| ")}` : def.type;
}

function row(def: SettingDef): string {
  const field = def.key === "-" ? "-" : `\`${def.group}.${def.key}\``;
  const fallback = def.secret ? "-" : def.default === undefined ? "-" : `\`${cell(def.default)}\``;
  const flags = [def.required ? "required" : "", def.secret ? "secret" : ""].filter((flag) => flag !== "").join(", ") || "-";
  return `| \`${def.env}\` | ${field} | ${typeOf(def)} | ${fallback} | ${flags} | ${cell(def.description)} |`;
}

export function renderSettingsDocs(registry: readonly SettingDef[] = SETTINGS_REGISTRY): string {
  const lines: string[] = [
    "# Settings",
    "",
    "Generated from `src/settings/registry.ts` by `npm run settings:gen`; do not edit by hand. `npm run settings:check` fails when this file is stale.",
    "",
    "The orchestrator reads its environment once, in `loadSettings(env)`. An empty value counts as unset. A value that cannot be parsed stops the start with one error that lists every offending variable (never a secret's value). The field column is the path in the typed `Settings` object; `-` marks a variable that is read live from `Settings.environment` (a child's environment, a secret redacted by value) or only by a child process. A secret never appears in a dump of the settings: it shows as `[set]`. One field has no variable: `server.drainMs` is the fixed window a cancelled run gets to unwind on shutdown (see `DEFAULT_DRAIN_MS`).",
    "",
  ];
  for (const group of SETTING_GROUPS) {
    const defs = registry.filter((def) => def.group === group);
    if (defs.length === 0) continue;
    lines.push(`## ${GROUP_TITLES[group]}`, "", "| Variable | Field | Type | Default | Flags | Description |", "| --- | --- | --- | --- | --- | --- |");
    for (const def of defs) lines.push(row(def));
    lines.push("");
  }
  return `${lines.join("\n")}`;
}

function main(): void {
  writeFileSync(SETTINGS_DOC_PATH, renderSettingsDocs(), "utf8");
  console.log(`settings:gen — wrote ${SETTINGS_DOC_PATH}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
