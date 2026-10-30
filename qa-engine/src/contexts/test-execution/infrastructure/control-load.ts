/*
 * The control load of a counted run_spec call (RFC-0007): the same session and app with no spec action, run before any spec
 * code, in a Playwright child of its own. The orchestrator writes two scripts into the call's work dir, a config that is the
 * project's own with the control's one test in place of the suite, and that test; the child is started through the execution
 * launcher like the spec child, so it gets the same environment, saved session copy and egress. No spec code has run in its
 * process or its browser, and it ends before the spec child starts. It leaves its file in the capture directory, which the sandbox
 * can write, so the runner reads the file when the control child closes, before the spec child exists, and keeps it in memory: a
 * control file found afterwards is not read. The load has a bound of its own, a share of the call's time (`controlLoadMs`), so a
 * launch page that never goes idle cannot spend the call.
 */
import { readFileSync } from "node:fs";
import { MAX_DEV_WRITE_REQUESTS } from "../domain/dev-write-request.ts";

const CONFIG_SOURCE = readFileSync(new URL("./embedded/control-load.config.cjs", import.meta.url), "utf8");
const TEST_SOURCE = readFileSync(new URL("./embedded/control-load.run.cjs", import.meta.url), "utf8");

/* The share of a call's time its control load may take. The control is one page load with no spec action and the call's time is the spec's: a launch page that never goes idle (a stream, a poll) must cost the call a fifth of its time and not all of it, and the spec child then starts with the rest. The config gives the control's whole test twice the load's bound, for the browser's start and the file's write, so the control as a whole never takes more than two fifths. */
const CONTROL_TIME_SHARE = 0.2;

/* The bound of the control's page load, in milliseconds, for a call that has `callMs`. */
export function controlLoadMs(callMs: number): number {
  return Math.max(1, Math.floor(callMs * CONTROL_TIME_SHARE));
}

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
