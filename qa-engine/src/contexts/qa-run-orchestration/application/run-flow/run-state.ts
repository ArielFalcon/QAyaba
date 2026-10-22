/* The data a run carries from one phase to the next. Each section is written by the phase that owns it and read by the later ones; it holds no live object, so it can be recorded as it stands. */

import type { CommitIntent } from "../ports/index.ts";

/* What the classifier said about the change. Only a diff run classifies: every other run generates and has no diff. */
export interface Classification {
  diff?: string;
  intent?: CommitIntent;
  reason?: string;
  contradiction?: boolean;
  /** False for a "regression" change, which runs the existing suite without generating. */
  generating: boolean;
}

/* What the setup phase left for the later ones. */
export interface SetupOutcome {
  /** The accepted suite was restored from the suite store: a green run may capture it back. */
  suiteRestored: boolean;
  /** The login the store brought back; a login that fails to sign in is replaced by the stock seed. */
  storeRestoredLogin: boolean;
  /** The auth setup is still the seed: generation may rewrite it, and the authoring handles are not granted. */
  authSeedUnauthored: boolean;
}

export interface RunState {
  classification: Classification;
  setup: SetupOutcome;
}

export function initialRunState(): RunState {
  return { classification: { generating: true }, setup: { suiteRestored: false, storeRestoredLogin: false, authSeedUnauthored: false } };
}
