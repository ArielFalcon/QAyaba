/* The session file of a run's login joins the run's secrets by value (the scope itself is the kernel's run-secret-redaction.ts). */
import { MAX_STORAGE_STATE_BYTES, activeRunSecretScope } from "@kernel/run-secret-redaction.ts";
import { readFailureReason, readOwnedSpecFile } from "../spec-path-confinement.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const valuesOf = (entries: unknown): string[] =>
  (Array.isArray(entries) ? entries : []).flatMap((entry) => (isRecord(entry) && typeof entry.value === "string" ? [entry.value] : []));

/* Adds the cookie and localStorage values of the Playwright session at `file`, below `authDir`, to the run's scope. The file is orchestrator-owned but written by a login the agent may have authored, so it is read strictly and nothing it holds is ever logged: a file that cannot be read that way, or is not JSON, adds nothing and says so once. No file means no session, and says nothing. */
export function registerSessionSecretsFromStorageState(authDir: string, file: string): void {
  const scope = activeRunSecretScope();
  if (scope === undefined) return;
  let read;
  try {
    read = readOwnedSpecFile({ mirrorDir: authDir, specDir: authDir }, file, MAX_STORAGE_STATE_BYTES);
  } catch (err) {
    console.warn(`[qa] WARNING: the session file could not be read (${readFailureReason(err)}); its cookies and storage are not redacted by value this run (non-blocking).`);
    return;
  }
  if ("absent" in read) return;
  if ("reason" in read) {
    console.warn(`[qa] WARNING: the session file was not read (${read.reason}); its cookies and storage are not redacted by value this run (non-blocking).`);
    return;
  }
  let state: unknown;
  try {
    state = JSON.parse(read.bytes.toString("utf8"));
  } catch {
    console.warn("[qa] WARNING: the session file is not valid JSON; its cookies and storage are not redacted by value this run (non-blocking).");
    return;
  }
  if (!isRecord(state)) return;
  const origins = Array.isArray(state.origins) ? state.origins : [];
  scope.addSessionValues([...valuesOf(state.cookies), ...origins.flatMap((origin) => (isRecord(origin) ? valuesOf(origin.localStorage) : []))]);
}
