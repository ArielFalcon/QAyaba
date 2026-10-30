/*
 * The control load of a counted run_spec call (RFC-0007): the same session and app with no spec action, run before any spec
 * code, in a Playwright child of its own. The orchestrator writes two scripts into the call's work dir, a config that is the
 * project's own with the control's one test in place of the suite, and that test; the child is started through the execution
 * launcher like the spec child, so it gets the same environment, saved session copy and egress. Nothing a spec does can reach
 * it: it ends before the spec child starts, in a process and a browser the spec never shares.
 */
import { readFileSync } from "node:fs";
import { MAX_DEV_WRITE_REQUESTS } from "../domain/dev-write-request.ts";

const CONFIG_SOURCE = readFileSync(new URL("./embedded/control-load.config.cjs", import.meta.url), "utf8");
const TEST_SOURCE = readFileSync(new URL("./embedded/control-load.run.cjs", import.meta.url), "utf8");

/* The test file's text: it keeps as many distinct requests as the ledgers do, so a request has a slot in both or in neither. */
export function buildControlTest(): string {
  return `const CONTROL_MAX_REQUESTS = ${MAX_DEV_WRITE_REQUESTS};\n${TEST_SOURCE}`;
}

/* The config's text, told where the test file is. */
export function buildControlConfig(testPath: string): string {
  return `const CONTROL_TEST = ${JSON.stringify(testPath)};\n${CONFIG_SOURCE}`;
}

/* The control child's arguments: the project the spec child is limited to, if any, and nothing that names a spec, a retry or a report. */
export function controlArgs(configPath: string, outputDir: string, project: string | undefined): string[] {
  return ["playwright", "test", `--config=${configPath}`, "--reporter=null", `--output=${outputDir}`, ...(project !== undefined ? [`--project=${project}`] : [])];
}
