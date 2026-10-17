/*
 * What the suite store told this run about its login (that the login in use was restored, that a restored login was demoted), kept per run so
 * the login span can say so: the login adapter has no other way to learn what the store did, and must not import the store's context.
 * Keyed by the run's exec scope; outside a run there is nowhere to keep it and nothing is noted.
 */

import { activeExecScope, type RunScope } from "../process-sandbox/exec-scope.ts";

export interface SuiteAuthNotes {
  restored: boolean;
  demotedReason?: string;
}

const NOTES = new WeakMap<RunScope, SuiteAuthNotes>();

/* The notes of the run this call is part of, if the suite store made any. */
export function suiteAuthNotes(): SuiteAuthNotes | undefined {
  const scope = activeExecScope();
  return scope ? NOTES.get(scope) : undefined;
}

/* Changes the notes of the run this call is part of. */
export function noteSuiteAuth(update: (notes: SuiteAuthNotes) => void): void {
  const scope = activeExecScope();
  if (!scope) return;
  let notes = NOTES.get(scope);
  if (!notes) {
    notes = { restored: false };
    NOTES.set(scope, notes);
  }
  update(notes);
}
